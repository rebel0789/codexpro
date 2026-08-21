import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

function runGit(cwd: string, args: string[], maxOutputBytes: number): string {
  const result = spawnSync("git", args, {
    cwd,
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
  return redactSensitiveText(result.stdout.trim() || "(no output)");
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

function pathIsInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function pathScopedGitContext(workspace: Workspace, guard: PathGuard, filePath: string): { cwd: string; relPath: string } {
  const resolved = guard.resolve(workspace, filePath);
  let start = resolved.absPath;
  try {
    if (!fs.statSync(start).isDirectory()) start = path.dirname(start);
  } catch {
    start = path.dirname(start);
  }
  const topLevel = spawnSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    maxBuffer: 64_000,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (!topLevel.error && topLevel.status === 0) {
    const rawRoot = String(topLevel.stdout ?? "").trim();
    if (rawRoot) {
      let repoRoot = path.resolve(rawRoot);
      try { repoRoot = fs.realpathSync.native(repoRoot); } catch {}
      if (pathIsInside(workspace.root, repoRoot)) {
        return { cwd: repoRoot, relPath: path.relative(repoRoot, resolved.absPath).split(path.sep).join("/") || "." };
      }
    }
  }
  return { cwd: workspace.root, relPath: resolved.relPath };
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  let cwd = workspace.root;
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const context = pathScopedGitContext(workspace, guard, filePath);
    cwd = context.cwd;
    args.push("--", context.relPath);
  }
  return runGit(cwd, args, config.maxOutputBytes);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  let cwd = workspace.root;
  if (filePath?.trim()) {
    const context = pathScopedGitContext(workspace, guard, filePath);
    cwd = context.cwd;
    args.push("--", context.relPath);
  }
  return runGit(cwd, args, config.maxOutputBytes);
}

export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  let cwd = workspace.root;
  if (filePath?.trim()) {
    const context = pathScopedGitContext(workspace, guard, filePath);
    cwd = context.cwd;
    args.push("--", context.relPath);
    untrackedArgs.push("--", context.relPath);
  }
  const diffStatus = runGit(cwd, args, config.maxOutputBytes);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = runGit(cwd, untrackedArgs, config.maxOutputBytes);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace.root, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
