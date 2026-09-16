import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { resolveBashInvocation } from "./bashOps.js";
import type { Workspace } from "./guard.js";
import { CodexProError, isSubpath, normalizeRelPath, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

interface GitContext {
  cwd: string;
  root: string;
  targetPath?: string;
}

export interface GitRuntimeStatus {
  executable?: string;
  version?: string;
  source?: "configured" | "git-for-windows" | "path";
  available: boolean;
  reason?: string;
  bash_runtime?: string;
}

function gitExecutableInfo(config: CodexProConfig): { executable: string; source: GitRuntimeStatus["source"] } {
  if (config.gitExecutable) return { executable: config.gitExecutable, source: "configured" };
  if (process.platform === "win32") {
    try {
      const bash = resolveBashInvocation(config);
      if (bash.runtime === "native-bash" && /[\\/]Git[\\/]bin[\\/]bash\.exe$/i.test(bash.executable)) {
        const gitForWindows = path.win32.join(path.win32.dirname(path.win32.dirname(bash.executable)), "cmd", "git.exe");
        if (fs.existsSync(gitForWindows)) return { executable: gitForWindows, source: "git-for-windows" };
      }
    } catch {
      // Preserve the normal PATH lookup so Git diagnostics can report the actual failure.
    }
  }
  return { executable: "git", source: "path" };
}

export function gitRuntimeStatus(config: CodexProConfig): GitRuntimeStatus {
  const info = gitExecutableInfo(config);
  const result = spawnSync(info.executable, ["--version"], {
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" },
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    return {
      executable: info.executable,
      source: info.source,
      available: false,
      reason: result.error?.message ?? String(result.stderr ?? result.stdout ?? `git exited with status ${result.status}`)
    };
  }
  return {
    executable: info.executable,
    source: info.source,
    version: String(result.stdout ?? "").trim().split(/\r?\n/)[0] || undefined,
    available: true
  };
}

function gitExecutable(config: CodexProConfig): string {
  return gitExecutableInfo(config).executable;
}

function defaultGitContext(workspace: Workspace): GitContext {
  return { cwd: workspace.root, root: workspace.root };
}

function nearestGitContext(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string): GitContext {
  if (!filePath?.trim()) return defaultGitContext(workspace);
  const resolved = guard.resolve(workspace, filePath);
  let probe = resolved.absPath;
  try {
    if (!fs.statSync(probe).isDirectory()) probe = path.dirname(probe);
  } catch {
    probe = path.dirname(probe);
  }
  const result = spawnSync(gitExecutable(config), ["rev-parse", "--show-toplevel"], {
    cwd: probe,
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.error || result.status !== 0) return { ...defaultGitContext(workspace), targetPath: resolved.relPath };
  const rootText = String(result.stdout ?? "").trim();
  if (!rootText) return { ...defaultGitContext(workspace), targetPath: resolved.relPath };
  const root = fs.realpathSync.native(path.resolve(rootText));
  if (!config.allowedRoots.some((allowedRoot) => isSubpath(root, allowedRoot)) || !isSubpath(resolved.absPath, root)) {
    return { ...defaultGitContext(workspace), targetPath: resolved.relPath };
  }
  return { cwd: root, root, targetPath: normalizeRelPath(path.relative(root, resolved.absPath)) };
}

function workspacePathForGitPath(gitRoot: string, workspace: Workspace, gitPath: string): string {
  if (!gitPath || gitPath === "/dev/null") return gitPath;
  const absPath = path.resolve(gitRoot, gitPath.replace(/^\.[/\\]/, ""));
  if (!isSubpath(absPath, workspace.root)) return gitPath;
  return normalizeRelPath(path.relative(workspace.root, absPath));
}

function rewriteStatusPaths(output: string, context: GitContext, workspace: Workspace): string {
  if (context.root === workspace.root) return output;
  return output.split("\n").map((line) => {
    if (!line || line.startsWith("##")) return line;
    if (line.includes("\t")) {
      const parts = line.split("\t");
      return [parts[0], ...parts.slice(1).map((value) => workspacePathForGitPath(context.root, workspace, value))].join("\t");
    }
    const match = line.match(/^(\s*\S{1,2}\s+)(.+)$/);
    if (!match) return line;
    const pathText = match[2];
    if (pathText.includes(" -> ")) {
      const [from, to] = pathText.split(" -> ", 2);
      return `${match[1]}${workspacePathForGitPath(context.root, workspace, from)} -> ${workspacePathForGitPath(context.root, workspace, to)}`;
    }
    return `${match[1]}${workspacePathForGitPath(context.root, workspace, pathText)}`;
  }).join("\n");
}

function runGit(config: CodexProConfig, workspace: Workspace, args: string[], maxOutputBytes: number, context = defaultGitContext(workspace), rewritePaths = false): string {
  const result = spawnSync(gitExecutable(config), args, {
    cwd: context.cwd,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.error) {
    return `git unavailable or failed: ${result.error.message}`;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return stderr || stdout || `git exited with status ${result.status}`;
  }
  const output = result.stdout.trim() || "(no output)";
  return redactSensitiveText(rewritePaths ? rewriteStatusPaths(output, context, workspace) : output);
}

function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  const context = guard && filePath?.trim() ? nearestGitContext(config, guard, workspace, filePath) : defaultGitContext(workspace);
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  return runGit(config, workspace, args, config.maxOutputBytes, context, true);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  const context = nearestGitContext(config, guard, workspace, filePath);
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  return runGit(config, workspace, args, config.maxOutputBytes, context);
}

export function gitDiffStats(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath?: string,
  staged = false
): { additions: number; deletions: number; changed: boolean; error?: string } {
  const args = ["diff", "--numstat", "--no-ext-diff", "--no-textconv"];
  const context = nearestGitContext(config, guard, workspace, filePath);
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  const output = runGit(config, workspace, args, config.maxOutputBytes, context);
  if (isGitFailure(output)) return { additions: 0, deletions: 0, changed: false, error: output };
  const lines = outputLines(output);
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    const [added, deleted] = line.split("\t", 2);
    if (/^\d+$/.test(added)) additions += Number(added);
    if (/^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return { additions, deletions, changed: lines.length > 0 };
}

export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  const context = nearestGitContext(config, guard, workspace, filePath);
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (filePath?.trim()) {
    args.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
    untrackedArgs.push("--", context.targetPath ?? guard.resolve(workspace, filePath).relPath);
  }
  const diffStatus = runGit(config, workspace, args, config.maxOutputBytes, context, true);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = runGit(config, workspace, untrackedArgs, config.maxOutputBytes, context, true);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(config, workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
