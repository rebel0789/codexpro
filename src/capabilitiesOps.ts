import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { isSubpath, type Workspace } from "./guard.js";

export interface SkillInventoryItem {
  name: string;
  description?: string;
  source: "workspace" | "user" | "plugin" | "other";
  path: string;
}

interface SkillInventoryRecord extends SkillInventoryItem {
  absPath: string;
}

export interface LoadedSkill {
  skill: SkillInventoryItem;
  text: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

export interface McpServerInventoryItem {
  name: string;
  source: string;
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

async function safeReadText(file: string, maxBytes = 16_000): Promise<string> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTextWithStats(file: string, maxBytes: number): Promise<{ text: string; bytes: number; totalBytes: number; truncated: boolean }> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, "r");
  try {
    const limit = Math.max(1, Math.min(maxBytes, stat.size));
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      bytes: bytesRead,
      totalBytes: stat.size,
      truncated: stat.size > bytesRead
    };
  } finally {
    await handle.close();
  }
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function realpathOrUndefined(filePath: string): string | undefined {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return undefined;
  }
}

function displayPath(absPath: string, workspaceRoot: string): string {
  const home = os.homedir();
  if (absPath === workspaceRoot) return "$WORKSPACE";
  if (absPath.startsWith(`${workspaceRoot}${path.sep}`)) {
    return `$WORKSPACE/${path.relative(workspaceRoot, absPath).split(path.sep).join("/")}`;
  }
  if (absPath === home) return "~";
  if (absPath.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, absPath).split(path.sep).join("/")}`;
  }
  return absPath;
}

function skillSource(skillPath: string, workspaceRoot: string): SkillInventoryItem["source"] {
  if (skillPath.startsWith(`${workspaceRoot}${path.sep}`)) return "workspace";
  if (skillPath.includes(`${path.sep}.codex${path.sep}plugins${path.sep}`)) return "plugin";
  if (skillPath.startsWith(`${os.homedir()}${path.sep}`)) return "user";
  return "other";
}

function skillSourceRank(source: SkillInventoryItem["source"]): number {
  if (source === "workspace") return 0;
  if (source === "user") return 1;
  if (source === "plugin") return 2;
  return 3;
}

function compareSkills(a: SkillInventoryItem, b: SkillInventoryItem): number {
  return (
    skillSourceRank(a.source) - skillSourceRank(b.source) ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path)
  );
}

function publicSkill(record: SkillInventoryRecord): SkillInventoryItem {
  return {
    name: record.name,
    description: record.description,
    source: record.source,
    path: record.path
  };
}

function frontmatterValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

async function findSkillFiles(root: string, maxDepth: number, out: string[], maxItems: number): Promise<void> {
  if (out.length >= maxItems || maxDepth < 0) return;
  const entries = await safeReaddir(root);
  for (const entry of entries) {
    if (out.length >= maxItems) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push(abs);
      continue;
    }
    if (entry.isDirectory()) {
      await findSkillFiles(abs, maxDepth - 1, out, maxItems);
    }
  }
}

async function discoverSkillRecords(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryRecord[]> {
  const maxSkills = Math.max(1, Math.min(options.maxSkills ?? 120, 500));
  const workspaceRoots = [
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, ".agents", "skills"),
    path.join(workspace.root, "skills")
  ].flatMap((dir) => {
    const real = realpathOrUndefined(dir);
    return real && isSubpath(real, workspace.root) ? [real] : [];
  });
  const roots = [
    ...workspaceRoots,
    ...(options.includeGlobal
      ? [
          path.join(os.homedir(), ".codex", "skills"),
          path.join(os.homedir(), ".agents", "skills"),
          path.join(os.homedir(), ".codex", "plugins", "cache")
        ]
      : [])
  ].filter((dir) => fs.existsSync(dir));

  const skillFiles: string[] = [];
  for (const root of roots) {
    await findSkillFiles(root, root.includes(`${path.sep}plugins${path.sep}cache`) ? 9 : 3, skillFiles, maxSkills);
    if (skillFiles.length >= maxSkills) break;
  }

  const items: SkillInventoryRecord[] = [];
  for (const file of skillFiles.slice(0, maxSkills)) {
    const realFile = realpathOrUndefined(file) ?? file;
    if (isSubpath(file, workspace.root) && !isSubpath(realFile, workspace.root)) continue;
    let text = "";
    try {
      text = await safeReadText(realFile);
    } catch {
      // Keep the skill visible even if the file cannot be read.
    }
    const name = frontmatterValue(text, "name") ?? path.basename(path.dirname(realFile));
    const description = frontmatterValue(text, "description");
    items.push({
      name,
      description,
      source: skillSource(realFile, workspace.root),
      path: displayPath(realFile, workspace.root),
      absPath: realFile
    });
  }

  return unique(items, (item) => `${item.source}:${item.name}:${item.path}`).sort(compareSkills);
}

export async function discoverSkillInventory(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryItem[]> {
  return (await discoverSkillRecords(workspace, options)).map(publicSkill);
}

export async function loadSkill(
  workspace: Workspace,
  options: {
    name: string;
    source?: SkillInventoryItem["source"];
    path?: string;
    includeGlobal?: boolean;
    maxSkills?: number;
    maxBytes?: number;
  }
): Promise<LoadedSkill> {
  const name = options.name.trim();
  if (!name) throw new Error("Skill name is required.");
  const requestedPath = options.path?.trim();

  const records = await discoverSkillRecords(workspace, {
    includeGlobal: options.includeGlobal !== false,
    maxSkills: options.maxSkills
  });
  const matches = records.filter(
    (skill) =>
      skill.name === name &&
      (!options.source || skill.source === options.source) &&
      (!requestedPath || skill.path === requestedPath)
  );
  if (!matches.length) {
    const near = records
      .filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, 8)
      .map((skill) => `${skill.name} [${skill.source}]`)
      .join(", ");
    const suffix = requestedPath ? ` at ${requestedPath}` : "";
    throw new Error(`Skill not found: ${name}${suffix}${near ? `. Similar skills: ${near}` : ""}`);
  }
  if (matches.length > 1) {
    const choices = matches.map((skill) => `${skill.name} [${skill.source}] at ${skill.path}`).join("; ");
    throw new Error(`Multiple skills named ${name} were found. Pass source and path to choose one: ${choices}`);
  }

  const [skill] = matches;
  if (path.basename(skill.absPath) !== "SKILL.md") {
    throw new Error(`Refusing to load non-skill file: ${skill.path}`);
  }
  if (skill.source === "workspace") {
    const realSkillPath = realpathOrUndefined(skill.absPath);
    if (!realSkillPath || !isSubpath(realSkillPath, workspace.root)) {
      throw new Error(`Refusing to load workspace skill outside workspace: ${skill.path}`);
    }
  }
  const maxBytes = Math.max(1_000, Math.min(options.maxBytes ?? 40_000, 100_000));
  const loaded = await readTextWithStats(skill.absPath, maxBytes);
  return {
    skill: publicSkill(skill),
    text: loaded.text,
    bytes: loaded.bytes,
    totalBytes: loaded.totalBytes,
    truncated: loaded.truncated
  };
}

function parseTomlMcpServers(text: string, source: string): McpServerInventoryItem[] {
  const out: McpServerInventoryItem[] = [];
  const re = /^\s*\[(?:mcp_servers|mcpServers)\.("?)([^"\].]+)\1\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({ name: match[2], source });
  }
  return out;
}

function parseJsonMcpServers(text: string, source: string): McpServerInventoryItem[] {
  try {
    const parsed = JSON.parse(text);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
    return Object.keys(servers).map((name) => ({ name, source }));
  } catch {
    return [];
  }
}

export async function discoverMcpServers(workspace: Workspace): Promise<McpServerInventoryItem[]> {
  const candidates = [
    { file: path.join(os.homedir(), ".codex", "config.toml"), kind: "toml" },
    { file: path.join(workspace.root, ".mcp.json"), kind: "json" },
    { file: path.join(workspace.root, ".cursor", "mcp.json"), kind: "json" },
    { file: path.join(os.homedir(), ".cursor", "mcp.json"), kind: "json" }
  ];

  const servers: McpServerInventoryItem[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.file)) continue;
    let text = "";
    try {
      text = await safeReadText(candidate.file, 200_000);
    } catch {
      continue;
    }
    const source = displayPath(candidate.file, workspace.root);
    servers.push(...(candidate.kind === "toml" ? parseTomlMcpServers(text, source) : parseJsonMcpServers(text, source)));
  }

  return unique(servers, (server) => `${server.source}:${server.name}`).sort((a, b) => a.name.localeCompare(b.name));
}

export async function codexproInventory(
  config: CodexProConfig,
  workspace: Workspace,
  options: { includeGlobalSkills?: boolean; includeMcpServers?: boolean; maxSkills?: number } = {}
): Promise<{
  text: string;
  skills: SkillInventoryItem[];
  mcpServers: McpServerInventoryItem[];
}> {
  const skills = await discoverSkillInventory(workspace, {
    includeGlobal: options.includeGlobalSkills !== false,
    maxSkills: options.maxSkills
  });
  const mcpServers = options.includeMcpServers === false ? [] : await discoverMcpServers(workspace);

  const bySource = skills.reduce<Record<string, number>>((acc, skill) => {
    acc[skill.source] = (acc[skill.source] ?? 0) + 1;
    return acc;
  }, {});

  const skillLines = skills.length
    ? skills.map((skill) => `- ${skill.name} [${skill.source}]${skill.description ? ` - ${skill.description}` : ""}`).join("\n")
    : "- none discovered";
  const mcpLines = mcpServers.length
    ? mcpServers.map((server) => `- ${server.name} (${server.source})`).join("\n")
    : "- none discovered";

  const text = `# CodexPro Inventory

Workspace: ${workspace.root}
Bash mode: ${config.bashMode}
Write mode: ${config.writeMode}
Tool mode: ${config.toolMode}

## Skill summary

Total: ${skills.length}
Workspace: ${bySource.workspace ?? 0}
User: ${bySource.user ?? 0}
Plugin: ${bySource.plugin ?? 0}
Other: ${bySource.other ?? 0}

${skillLines}

## MCP servers

${mcpLines}
`;

  return { text, skills, mcpServers };
}
