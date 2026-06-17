import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, displayPath, normalizeRelPath, PathGuard } from "./guard.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";

export interface TreeOptions {
  path?: string;
  maxDepth: number;
  includeHidden: boolean;
  maxEntries: number;
}

export interface TreeResult {
  text: string;
  entries: number;
  truncated: boolean;
}

export interface ReadFileResult {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  bytes: number;
  sha256: string;
  truncated: boolean;
}

export interface DiffResult {
  diff: string;
  additions: number;
  deletions: number;
  changed: boolean;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function withLineNumbers(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, idx) => `${String(startLine + idx).padStart(width, " ")} | ${line}`).join("\n");
}

export function makeUnifiedDiff(oldText: string, newText: string, relPath: string, maxChars = 60_000): DiffResult {
  if (oldText === newText) {
    return { diff: `No changes in ${relPath}.`, additions: 0, deletions: 0, changed: false };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const coreOldStart = prefix;
  const coreOldEnd = oldLines.length - suffix;
  const coreNewStart = prefix;
  const coreNewEnd = newLines.length - suffix;
  const context = 3;
  const oldStart = Math.max(0, coreOldStart - context);
  const oldEnd = Math.min(oldLines.length, coreOldEnd + context);
  const newStart = Math.max(0, coreNewStart - context);
  const newEnd = Math.min(newLines.length, coreNewEnd + context);

  const additions = Math.max(0, coreNewEnd - coreNewStart);
  const deletions = Math.max(0, coreOldEnd - coreOldStart);

  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -${oldStart + 1},${oldEnd - oldStart} +${newStart + 1},${newEnd - newStart} @@`];

  for (let i = oldStart; i < coreOldStart; i += 1) out.push(` ${oldLines[i]}`);
  for (let i = coreOldStart; i < coreOldEnd; i += 1) out.push(`-${oldLines[i]}`);
  for (let i = coreNewStart; i < coreNewEnd; i += 1) out.push(`+${newLines[i]}`);
  for (let i = coreOldEnd; i < oldEnd; i += 1) out.push(` ${oldLines[i]}`);

  let diff = out.join("\n");
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars) + `\n...[diff truncated to ${maxChars} chars]`;
  }
  return { diff: redactSensitiveText(diff), additions, deletions, changed: true };
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".") && name !== "." && name !== "..";
}

export async function repoTree(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: TreeOptions): Promise<TreeResult> {
  const target = guard.resolve(workspace, options.path ?? ".");
  const stat = await fsp.stat(target.absPath);
  if (!stat.isDirectory()) {
    throw new CodexProError(`Not a directory: ${target.relPath}`);
  }

  const lines: string[] = [target.relPath === "." ? "." : `${target.relPath}/`];
  let entries = 0;
  let truncated = false;

  async function walk(absDir: string, relDir: string, depth: number, prefix: string): Promise<void> {
    if (depth >= options.maxDepth || truncated) return;
    let dirents = await fsp.readdir(absDir, { withFileTypes: true });
    dirents = dirents
      .filter((entry) => options.includeHidden || !isHiddenName(entry.name))
      .filter((entry) => !guard.isBlockedRelativePath(normalizeRelPath(path.join(relDir, entry.name))))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < dirents.length; i += 1) {
      if (entries >= options.maxEntries) {
        truncated = true;
        return;
      }
      const entry = dirents[i];
      const isLast = i === dirents.length - 1;
      const branch = isLast ? "└── " : "├── ";
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      const childAbs = path.join(absDir, entry.name);
      const childRel = normalizeRelPath(path.join(relDir, entry.name));
      const displayName = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${prefix}${branch}${displayName}`);
      entries += 1;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1, childPrefix);
      }
      if (truncated) return;
    }
  }

  await walk(target.absPath, target.relPath === "." ? "" : target.relPath, 0, "");
  if (truncated) lines.push(`...[tree truncated after ${entries} entries]`);
  return { text: lines.join("\n"), entries, truncated };
}

export async function listFiles(
  guard: PathGuard,
  workspace: Workspace,
  options: { root?: string; glob?: string; includeHidden?: boolean; maxFiles: number }
): Promise<string[]> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const stat = await fsp.stat(target.absPath);
  const files: string[] = [];

  async function addFile(absFile: string): Promise<void> {
    const rel = displayPath(absFile, workspace.root);
    if (guard.isBlockedRelativePath(rel)) return;
    if (!options.includeHidden && rel.split("/").some(isHiddenName)) return;
    if (options.glob && !minimatch(rel, options.glob, { dot: true })) return;
    files.push(rel);
  }

  async function walk(absDir: string): Promise<void> {
    if (files.length >= options.maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= options.maxFiles) return;
      const abs = path.join(absDir, entry.name);
      const rel = displayPath(abs, workspace.root);
      if (guard.isBlockedRelativePath(rel)) continue;
      if (!options.includeHidden && rel.split("/").some(isHiddenName)) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) await addFile(abs);
    }
  }

  if (stat.isFile()) await addFile(target.absPath);
  else await walk(target.absPath);
  return files;
}

export async function readTextFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { startLine?: number; endLine?: number; maxBytes?: number } = {}
): Promise<ReadFileResult> {
  const resolved = guard.resolve(workspace, filePath);
  const maxBytes = Math.min(options.maxBytes ?? config.maxReadBytes, config.maxReadBytes);
  await guard.assertTextFile(resolved.absPath, maxBytes);
  const buffer = await fsp.readFile(resolved.absPath);
  const text = buffer.toString("utf8");
  const allLines = splitLines(text);
  const totalLines = allLines.length;
  const startLine = Math.max(1, Math.floor(options.startLine ?? 1));
  const endLine = Math.min(totalLines, Math.floor(options.endLine ?? totalLines));
  if (endLine < startLine) {
    throw new CodexProError(`end_line (${endLine}) must be >= start_line (${startLine}).`);
  }
  const selected = allLines.slice(startLine - 1, endLine);
  const numbered = withLineNumbers(selected, startLine);
  const truncated = startLine > 1 || endLine < totalLines;
  return {
    path: resolved.relPath,
    text: numbered,
    startLine,
    endLine,
    totalLines,
    bytes: buffer.byteLength,
    sha256: sha256(text),
    truncated
  };
}

export async function writeTextFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  content: string,
  options: { createDirs?: boolean; overwrite?: boolean } = {}
): Promise<{ path: string; bytes: number; sha256: string; existed: boolean; diff: DiffResult }> {
  const resolved = guard.resolve(workspace, filePath, { forWrite: true });
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > config.maxWriteBytes) {
    throw new CodexProError(`Write content is too large (${contentBytes} bytes). Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(content)) {
    throw new CodexProError("Secret-looking content is blocked from write. Use placeholders such as [REDACTED_SECRET] in handoff files.");
  }

  let oldText = "";
  let existed = false;
  try {
    await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
    oldText = await fsp.readFile(resolved.absPath, "utf8");
    existed = true;
  } catch (error) {
    if (error instanceof CodexProError && error.message.startsWith("Not a file")) throw error;
    if (fs.existsSync(resolved.absPath)) throw error;
  }

  if (existed && options.overwrite === false) {
    throw new CodexProError(`File already exists and overwrite=false: ${resolved.relPath}`);
  }
  if (options.createDirs) {
    await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
  }

  const diff = makeUnifiedDiff(oldText, content, resolved.relPath);
  await fsp.writeFile(resolved.absPath, content, "utf8");
  return { path: resolved.relPath, bytes: contentBytes, sha256: sha256(content), existed, diff };
}

export async function editTextFile(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; expectedReplacements?: number } = {}
): Promise<{ path: string; replacements: number; bytes: number; sha256: string; diff: DiffResult }> {
  if (!oldText) throw new CodexProError("old_text must not be empty.");
  const resolved = guard.resolve(workspace, filePath, { forWrite: true });
  await guard.assertTextFile(resolved.absPath, Math.max(config.maxWriteBytes, config.maxReadBytes));
  const before = await fsp.readFile(resolved.absPath, "utf8");
  const occurrences = before.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new CodexProError(`old_text was not found in ${resolved.relPath}. Read the file and retry with an exact snippet.`);
  }

  let replacements: number;
  let after: string;
  if (options.replaceAll) {
    after = before.split(oldText).join(newText);
    replacements = occurrences;
  } else {
    if (occurrences !== 1) {
      throw new CodexProError(`old_text matched ${occurrences} times. Provide a more specific old_text or set replace_all=true.`);
    }
    after = before.replace(oldText, newText);
    replacements = 1;
  }

  if (typeof options.expectedReplacements === "number" && replacements !== options.expectedReplacements) {
    throw new CodexProError(`Expected ${options.expectedReplacements} replacements but would perform ${replacements}.`);
  }

  const afterBytes = Buffer.byteLength(after, "utf8");
  if (afterBytes > config.maxWriteBytes) {
    throw new CodexProError(`Edited file would be too large (${afterBytes} bytes). Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(after)) {
    throw new CodexProError("Secret-looking content is blocked from edit. Use placeholders such as [REDACTED_SECRET] in handoff files.");
  }

  const diff = makeUnifiedDiff(before, after, resolved.relPath);
  await fsp.writeFile(resolved.absPath, after, "utf8");
  return { path: resolved.relPath, replacements, bytes: afterBytes, sha256: sha256(after), diff };
}

export async function ensureAiBridge(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<string[]> {
  const files: Record<string, string> = {
    "README.md": `# AI Bridge\n\nShared planning context for ChatGPT, other planning models, Codex, OpenCode, Pi, or another local implementation agent.\n\n- current-plan.md: plan produced by ChatGPT or another planning model for the implementation agent.\n- agent-status.md: generic implementation notes, touched files, test results, blockers, and review notes.\n- implementation-diff.patch: final review diff from the implementation agent when practical.\n- codex-status.md: legacy Codex-specific status file, kept for existing workflows.\n- decisions.md: architectural decisions that should remain stable.\n- open-questions.md: unresolved questions.\n- execution-log.jsonl: append-only generic agent handoff and execution events.\n- session-log.jsonl: append-only legacy session events.\n`,
    "current-plan.md": "# Current Plan\n\nNo plan written yet.\n",
    "agent-status.md": "# Agent Status\n\nNo implementation agent status written yet.\n",
    "implementation-diff.patch": "",
    "codex-status.md": "# Codex Status\n\nNo Codex status written yet.\n",
    "decisions.md": "# Decisions\n\n",
    "open-questions.md": "# Open Questions\n\n",
    "execution-log.jsonl": "",
    "session-log.jsonl": ""
  };
  const created: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const rel = `${config.contextDir}/${name}`;
    const resolved = guard.resolve(workspace, rel, { forWrite: true });
    if (!fs.existsSync(resolved.absPath)) {
      await fsp.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fsp.writeFile(resolved.absPath, content, "utf8");
      created.push(rel);
    }
  }
  return created;
}
