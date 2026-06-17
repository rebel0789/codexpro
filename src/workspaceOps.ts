import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { readTextFile, repoTree, ensureAiBridge } from "./fsOps.js";
import { gitDiff, gitLog, gitStatus } from "./gitOps.js";

export interface WorkspaceSummary {
  text: string;
  workspaceId: string;
  root: string;
  agentsLoaded: boolean;
  agentsPath?: string;
  skills: string[];
  tree?: string;
  gitStatus: string;
}

export interface CodexContext {
  text: string;
  workspaceId: string;
  root: string;
  targetPath: string;
  agentsFiles: string[];
  aiContextFiles: string[];
  gitStatus?: string;
  gitDiff?: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function discoverSkills(workspace: Workspace, options: { includeGlobal?: boolean } = {}): Promise<string[]> {
  const candidateDirs = unique([
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, "skills"),
    ...(options.includeGlobal
      ? [path.join(os.homedir(), ".codex", "skills"), path.join(os.homedir(), ".chatgpt", "skills")]
      : [])
  ]);
  const skills: string[] = [];
  for (const dir of candidateDirs) {
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (entry.isDirectory()) skills.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".md")) skills.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return unique(skills).sort((a, b) => a.localeCompare(b));
}

async function findAgentsFile(workspace: Workspace): Promise<string | undefined> {
  const candidates = ["AGENTS.override.md", "AGENTS.md", "agents.md", ".agents.md"];
  for (const candidate of candidates) {
    const abs = path.join(workspace.root, candidate);
    if (fs.existsSync(abs)) return candidate;
  }
  return undefined;
}

function candidateAgentsPaths(targetPath: string): string[] {
  const normalized = targetPath.split(path.sep).join("/").replace(/^\.\//, "");
  const parts = normalized && normalized !== "." ? normalized.split("/").filter(Boolean) : [];
  const dirs = [""];
  const directoryParts = parts.length > 0 && parts.at(-1)?.includes(".") ? parts.slice(0, -1) : parts;
  for (let i = 0; i < directoryParts.length; i += 1) {
    dirs.push(directoryParts.slice(0, i + 1).join("/"));
  }

  const names = ["AGENTS.override.md", "AGENTS.md", "agents.md", ".agents.md"];
  return unique(
    dirs.flatMap((dir) => names.map((name) => (dir ? `${dir}/${name}` : name)))
  );
}

async function readAgentsChain(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  targetPath: string,
  maxBytes: number
): Promise<{ text: string; files: string[] }> {
  const chunks: string[] = [];
  const files: string[] = [];
  const seenRealPaths = new Set<string>();
  for (const rel of candidateAgentsPaths(targetPath)) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (!fs.existsSync(resolved.absPath)) continue;
      const real = fs.realpathSync(resolved.absPath).toLowerCase();
      if (seenRealPaths.has(real)) continue;
      seenRealPaths.add(real);
      const agents = await readTextFile(config, guard, workspace, rel, { maxBytes });
      chunks.push(`--- ${rel} ---\n${agents.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
      files.push(rel);
    }
  }
  return {
    text: chunks.length ? chunks.join("\n\n") : "No AGENTS.md-style instruction files found for this target path.",
    files
  };
}

export async function workspaceSummary(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { includeTree?: boolean; maxDepth?: number; bootstrapContext?: boolean; includeSkills?: boolean; includeGlobalSkills?: boolean } = {}
): Promise<WorkspaceSummary> {
  if (options.bootstrapContext) {
    await ensureAiBridge(config, guard, workspace);
  }
  const skills = options.includeSkills ? await discoverSkills(workspace, { includeGlobal: options.includeGlobalSkills }) : [];
  const agentsPath = await findAgentsFile(workspace);
  let agentsText = "AGENTS.md: none loaded";
  if (agentsPath) {
    try {
      const agents = await readTextFile(config, guard, workspace, agentsPath, { maxBytes: 40_000 });
      agentsText = `AGENTS.md loaded from ${agentsPath}\n\n${agents.text}`;
    } catch {
      agentsText = `AGENTS.md found at ${agentsPath}, but it could not be read.`;
    }
  }

  let treeText: string | undefined;
  if (options.includeTree !== false) {
    const tree = await repoTree(config, guard, workspace, {
      path: ".",
      maxDepth: Math.max(1, Math.min(options.maxDepth ?? 3, 8)),
      includeHidden: false,
      maxEntries: 500
    });
    treeText = tree.text;
  }

  const status = gitStatus(config, workspace);
  const log = gitLog(config, workspace, 5);
  const skillText = options.includeSkills
    ? `Skills (${skills.length}): ${skills.join(", ") || "none discovered"}`
    : "Skills: skipped for speed. Pass include_skills=true if repo-local skill discovery is needed.";
  const text = `# Workspace\n\nWorkspace: ${workspace.id}\nRoot: ${workspace.root}\nBash mode: ${config.bashMode}\nWrite mode: ${config.writeMode}\nAllowed roots:\n${config.allowedRoots.map((root) => `- ${root}`).join("\n")}\n\n${skillText}\n\n${agentsText}\n\n## Git status\n\n${status}\n\n## Recent commits\n\n${log}\n${treeText ? `\n## Files\n\n${treeText}` : ""}`;

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    agentsLoaded: Boolean(agentsPath),
    agentsPath,
    skills,
    tree: treeText,
    gitStatus: status
  };
}

export async function readAiBridgeContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { createIfMissing?: boolean } = {}
): Promise<{ text: string; files: string[] }> {
  if (options.createIfMissing) {
    await ensureAiBridge(config, guard, workspace);
  } else {
    const bridgeDir = guard.resolve(workspace, config.contextDir);
    if (!fs.existsSync(bridgeDir.absPath)) {
      return {
        text: `No ${config.contextDir} handoff context exists yet. Use handoff_to_agent or handoff_to_codex to create it when a plan is ready.`,
        files: []
      };
    }
  }
  const relFiles = [
    `${config.contextDir}/current-plan.md`,
    `${config.contextDir}/agent-status.md`,
    `${config.contextDir}/implementation-diff.patch`,
    `${config.contextDir}/codex-status.md`,
    `${config.contextDir}/decisions.md`,
    `${config.contextDir}/open-questions.md`,
    `${config.contextDir}/execution-log.jsonl`
  ];
  const chunks: string[] = [];
  const files: string[] = [];
  for (const rel of relFiles) {
    try {
      const read = await readTextFile(config, guard, workspace, rel, { maxBytes: 80_000 });
      chunks.push(`--- ${rel} ---\n${read.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
    }
  }
  return { text: chunks.join("\n\n"), files };
}

export async function readCodexContext(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    targetPath?: string;
    includeAiBridge?: boolean;
    includeGit?: boolean;
    includeDiff?: boolean;
    maxAgentBytes?: number;
  } = {}
): Promise<CodexContext> {
  const targetPath = options.targetPath ?? ".";
  guard.resolve(workspace, targetPath);
  const agents = await readAgentsChain(config, guard, workspace, targetPath, Math.min(options.maxAgentBytes ?? 60_000, config.maxReadBytes));
  const ai = options.includeAiBridge === false
    ? { text: "Skipped by request.", files: [] }
    : await readAiBridgeContext(config, guard, workspace);
  const status = options.includeGit === false ? undefined : gitStatus(config, workspace);
  const diff = options.includeDiff ? gitDiff(config, guard, workspace) : undefined;

  const text = [
    "# Codex Context",
    "",
    `Workspace: ${workspace.id}`,
    `Root: ${workspace.root}`,
    `Target path: ${targetPath}`,
    `Bash mode: ${config.bashMode}`,
    `Write mode: ${config.writeMode}`,
    "",
    "## AGENTS Instructions",
    "",
    agents.text,
    "",
    "## AI Bridge Context",
    "",
    ai.text,
    ...(status !== undefined ? ["", "## Git Status", "", status] : []),
    ...(diff !== undefined ? ["", "## Git Diff", "", diff] : [])
  ].join("\n");

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    targetPath,
    agentsFiles: agents.files,
    aiContextFiles: ai.files,
    gitStatus: status,
    gitDiff: diff
  };
}
