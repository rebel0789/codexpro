import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard, normalizeRelPath } from "./guard.js";
import { listFiles, readTextFile, repoTree, writeTextFile, ensureAiBridge } from "./fsOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";
import { readAiBridgeContext } from "./workspaceOps.js";
import { redactSensitiveText } from "./redact.js";

export interface ProContextOptions {
  title?: string;
  selectedPaths?: string[];
  extraGlobs?: string[];
  includeImportantFiles?: boolean;
  includeChangedFiles?: boolean;
  includeDiff?: boolean;
  includeAiBridge?: boolean;
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxDiffBytes?: number;
  maxTotalBytes?: number;
}

export interface ProContextResult {
  path?: string;
  markdown: string;
  bytes: number;
  filesIncluded: string[];
  filesSkipped: string[];
  truncated: boolean;
}

const IMPORTANT_ROOT_FILES = [
  "AGENTS.md",
  "README.md",
  "CLAUDE.md",
  "package.json",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "tsconfig.json",
  "jsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.ts",
  "next.config.js",
  "svelte.config.js",
  "astro.config.mjs",
  "tailwind.config.ts",
  "tailwind.config.js",
  "postcss.config.js",
  "eslint.config.js",
  ".eslintrc.json",
  "biome.json",
  "turbo.json",
  "deno.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod"
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => normalizeRelPath(value).replace(/^\.\//, "")).filter(Boolean))];
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`,
    truncated: true
  };
}

function parseChangedFiles(status: string): string[] {
  const files: string[] = [];
  for (const rawLine of status.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("##") || line.startsWith("git unavailable") || line.startsWith("fatal:")) continue;
    if (line.length < 4) continue;
    let rel = line.slice(3).trim();
    if (!rel) continue;
    if (rel.includes(" -> ")) rel = rel.split(" -> ").pop() ?? rel;
    if (rel.startsWith("\"") && rel.endsWith("\"")) rel = rel.slice(1, -1);
    files.push(rel);
  }
  return unique(files);
}

function languageForPath(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".md") return "markdown";
  if (ext === ".css") return "css";
  if (ext === ".html") return "html";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (ext === ".go") return "go";
  if (ext === ".toml") return "toml";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return "text";
}

function isLikelyImportantConfig(relPath: string): boolean {
  const basename = path.basename(relPath);
  return IMPORTANT_ROOT_FILES.includes(relPath) || IMPORTANT_ROOT_FILES.includes(basename);
}

async function existingImportantFiles(guard: PathGuard, workspace: Workspace): Promise<string[]> {
  const found: string[] = [];
  for (const rel of IMPORTANT_ROOT_FILES) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (fs.existsSync(resolved.absPath) && fs.statSync(resolved.absPath).isFile()) found.push(resolved.relPath);
    } catch {
      // Ignore blocked or missing optional config files.
    }
  }
  return unique(found);
}

async function filesForGlobs(
  guard: PathGuard,
  workspace: Workspace,
  globs: string[],
  maxFiles: number
): Promise<string[]> {
  const out: string[] = [];
  for (const glob of globs) {
    if (out.length >= maxFiles) break;
    const matches = await listFiles(guard, workspace, {
      root: ".",
      glob,
      includeHidden: false,
      maxFiles: Math.max(1, maxFiles - out.length)
    });
    out.push(...matches);
  }
  return unique(out).slice(0, maxFiles);
}

function appendSection(parts: string[], heading: string, body: string): void {
  parts.push(`## ${heading}\n\n${body.trimEnd()}`);
}

export async function buildProContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ProContextOptions = {}
): Promise<ProContextResult> {
  const title = options.title?.trim() || "CodexPro Context Bundle";
  const maxDepth = clamp(options.maxDepth, 3, 1, 6);
  const maxFiles = clamp(options.maxFiles, 24, 1, 80);
  const maxFileBytes = clamp(options.maxFileBytes, Math.min(config.maxReadBytes, 60_000), 1_000, Math.min(config.maxReadBytes, 250_000));
  const maxDiffBytes = clamp(options.maxDiffBytes, Math.min(config.maxOutputBytes, 80_000), 1_000, config.maxOutputBytes);
  const maxTotalBytes = clamp(
    options.maxTotalBytes,
    Math.min(config.maxWriteBytes, 700_000),
    20_000,
    Math.min(config.maxWriteBytes, 2_000_000)
  );

  const status = gitStatus(config, workspace);
  const changedFiles = parseChangedFiles(status);
  const includeImportantFiles = options.includeImportantFiles !== false;
  const includeChangedFiles = options.includeChangedFiles !== false;
  const importantFiles = includeImportantFiles ? await existingImportantFiles(guard, workspace) : [];
  const changedFileCandidates = includeChangedFiles ? changedFiles : [];
  const selectedPaths = unique(options.selectedPaths ?? []);
  const extraGlobFiles = await filesForGlobs(guard, workspace, options.extraGlobs ?? [], maxFiles);
  const candidates = unique([...importantFiles, ...changedFileCandidates, ...selectedPaths, ...extraGlobFiles])
    .filter((rel) => rel !== `${config.contextDir}/pro-context.md`)
    .sort((a, b) => {
      const aImportant = isLikelyImportantConfig(a) ? 0 : 1;
      const bImportant = isLikelyImportantConfig(b) ? 0 : 1;
      if (aImportant !== bImportant) return aImportant - bImportant;
      return a.localeCompare(b);
    })
    .slice(0, maxFiles);

  let truncated = false;
  const filesIncluded: string[] = [];
  const filesSkipped: string[] = [];
  const parts: string[] = [];

  parts.push(`# ${title}`);
  parts.push(
    [
      `Generated: ${new Date().toISOString()}`,
      `Workspace: ${workspace.root}`,
      `Workspace ID: ${workspace.id}`,
      `Write mode: ${config.writeMode}`,
      `Bash mode: ${config.bashMode}`,
      `Tool mode: ${config.toolMode}`,
      "",
      "Purpose: paste this bundle into a high-context ChatGPT model when that model cannot call the CodexPro MCP tools directly.",
      "Instruction for ChatGPT: use this as repository context, produce a narrow Codex execution plan, and avoid inventing files or runtime facts not shown here."
    ].join("\n")
  );

  appendSection(parts, "Repository Tree", (await repoTree(config, guard, workspace, {
    path: ".",
    maxDepth,
    includeHidden: false,
    maxEntries: 700
  })).text);

  appendSection(parts, "Git Status", `\`\`\`text\n${status}\n\`\`\``);
  appendSection(parts, "Recent Commits", `\`\`\`text\n${gitLog(config, workspace, 8)}\n\`\`\``);

  if (options.includeDiff !== false) {
    const diff = truncateText(gitDiff(config, guard, workspace), maxDiffBytes);
    truncated ||= diff.truncated;
    appendSection(parts, "Git Diff", `\`\`\`diff\n${diff.text}\n\`\`\``);
  }

  if (options.includeAiBridge !== false) {
    const ai = await readAiBridgeContext(config, guard, workspace);
    appendSection(parts, "Existing AI Bridge Context", ai.text);
  }

  appendSection(
    parts,
    "Selected Files",
    [
      `Changed files detected: ${changedFiles.length ? changedFiles.join(", ") : "none"}`,
      `Auto-include important root files: ${includeImportantFiles ? "yes" : "no"}`,
      `Auto-include changed files: ${includeChangedFiles ? "yes" : "no"}`,
      `Explicit selected paths: ${selectedPaths.length ? selectedPaths.join(", ") : "none"}`,
      `Extra globs: ${(options.extraGlobs ?? []).length ? (options.extraGlobs ?? []).join(", ") : "none"}`,
      `Files included below: ${candidates.length ? candidates.join(", ") : "none"}`
    ].join("\n")
  );

  const fileChunks: string[] = [];
  for (const rel of candidates) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (!fs.existsSync(resolved.absPath)) {
        filesSkipped.push(`${rel} [missing]`);
        continue;
      }
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) {
        filesSkipped.push(`${rel} [not a file]`);
        continue;
      }
      const read = await readTextFile(config, guard, workspace, rel, { maxBytes: maxFileBytes });
      filesIncluded.push(read.path);
      fileChunks.push(
        [
          `### ${read.path}`,
          "",
          `Bytes: ${read.bytes}`,
          `SHA-256: ${read.sha256}`,
          `Lines: ${read.startLine}-${read.endLine} of ${read.totalLines}`,
          "",
          `\`\`\`${languageForPath(read.path)}`,
          read.text,
          "```"
        ].join("\n")
      );
    } catch (error) {
      filesSkipped.push(`${rel} [${error instanceof Error ? error.message : String(error)}]`);
    }
  }

  appendSection(parts, "File Contents", fileChunks.length ? fileChunks.join("\n\n") : "No file contents selected.");
  appendSection(parts, "Skipped Files", filesSkipped.length ? filesSkipped.map((file) => `- ${file}`).join("\n") : "None.");

  let markdown = `${parts.join("\n\n")}\n`;
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > maxTotalBytes) {
    const capped = truncateText(markdown, maxTotalBytes);
    markdown = capped.text;
    truncated = true;
  }

  return {
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
    filesIncluded,
    filesSkipped,
    truncated
  };
}

export async function exportProContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: ProContextOptions = {}
): Promise<ProContextResult> {
  await ensureAiBridge(config, guard, workspace);
  const built = await buildProContext(config, guard, workspace, options);
  built.markdown = redactSensitiveText(built.markdown);
  const relPath = `${config.contextDir}/pro-context.md`;
  const write = await writeTextFile(config, guard, workspace, relPath, built.markdown, {
    createDirs: true,
    overwrite: true
  });
  return {
    ...built,
    path: write.path,
    bytes: write.bytes
  };
}
