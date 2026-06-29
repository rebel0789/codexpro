import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { listFiles } from "./fsOps.js";
import { redactSensitiveText } from "./redact.js";

export interface SearchOptions {
  query: string;
  regex: boolean;
  root?: string;
  glob?: string;
  includeHidden: boolean;
  maxResults: number;
}

export interface SearchResult {
  text: string;
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
  used: "ripgrep" | "node";
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn("where", [command], { stdio: "ignore", shell: false })
      : spawn("/bin/sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function truncateLine(line: string, max = 400): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

async function runRipgrep(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const args = ["--json", "--line-number", "--with-filename", "--no-heading", "--color=never", "--max-columns", "500", "--max-count", "50", "--max-filesize", String(config.maxReadBytes)];
  if (!options.regex) args.push("--fixed-strings");
  if (options.includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  // Pass the query via -e so patterns beginning with "-" (e.g. "->", "--flag")
  // are treated as the search term instead of ripgrep options.
  args.push("-e", options.query, "--", target.absPath);

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > config.maxOutputBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code > 1) {
        reject(new CodexProError(stderr.trim() || `ripgrep failed with exit code ${code}`));
        return;
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const lines = stdout.split("\n").filter(Boolean);
      let visibleMatches = 0;
      for (const line of lines) {
        const value = JSON.parse(line);
        if (value.type !== "match") continue;
        const absPath = path.resolve(value.data?.path?.text ?? "");
        const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
        if (rel.startsWith("..")) continue;
        if (guard.isBlockedRelativePath(rel)) continue;
        visibleMatches += 1;
        if (matches.length >= options.maxResults) continue;
        const lineText = String(value.data?.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({ path: rel || ".", line: Number(value.data?.line_number ?? 0), text: redactSensitiveText(truncateLine(lineText)) });
      }
      const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
      resolve({ text, matches, truncated: visibleMatches > matches.length || stdout.length > config.maxOutputBytes, used: "ripgrep" });
    });
  });
}

async function runNodeSearch(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const matcher = options.regex ? new RegExp(options.query) : undefined;
  for (const rel of files) {
    if (matches.length >= options.maxResults) break;
    const resolved = guard.resolve(workspace, rel);
    try {
      const stat = await fsp.stat(resolved.absPath);
      if (stat.size > config.maxReadBytes) continue;
      const buffer = await fsp.readFile(resolved.absPath);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const hit = matcher ? matcher.test(line) : line.includes(options.query);
        if (hit) {
          matches.push({ path: rel, line: i + 1, text: redactSensitiveText(truncateLine(line)) });
          if (matches.length >= options.maxResults) break;
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
  return { text, matches, truncated: matches.length >= options.maxResults, used: "node" };
}

export async function searchWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace, rawOptions: Partial<SearchOptions>): Promise<SearchResult> {
  const query = rawOptions.query?.toString() ?? "";
  if (!query) throw new CodexProError("query is required.");
  const options: SearchOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults))
  };
  if (await commandExists("rg")) {
    return runRipgrep(config, guard, workspace, options);
  }
  if (options.regex) {
    throw new CodexProError("regex search requires ripgrep. Install rg or retry with regex=false.");
  }
  return runNodeSearch(config, guard, workspace, options);
}
