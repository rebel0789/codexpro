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
  precedence: number;
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

const MAX_MCP_SERVER_INVENTORY = 120;

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
    // Prefer native realpath so Windows short/8.3 names and junctions collapse
    // to the same canonical spelling used for ~/ display matching.
    return fs.realpathSync.native(filePath);
  } catch {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return undefined;
    }
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of paths) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stripWinLongPathPrefix(value: string): string {
  return value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "");
}

function homePathCandidates(requestedHomeDir: string, homeDir: string): string[] {
  // Keep both the caller-supplied home and its realpath. On Windows, junction
  // targets often preserve the pre-realpath path form (for example long vs 8.3
  // names), so ~/ display must accept either spelling.
  const resolvedRequested = path.resolve(requestedHomeDir);
  return uniquePaths(
    [homeDir, resolvedRequested, realpathOrUndefined(resolvedRequested), realpathOrUndefined(homeDir)]
      .filter((value): value is string => Boolean(value))
      .map(stripWinLongPathPrefix)
  );
}

function samePath(left: string, right: string): boolean {
  const a = stripWinLongPathPrefix(left);
  const b = stripWinLongPathPrefix(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function homeRelativeDisplay(absPath: string, home: string): string | undefined {
  const candidates: Array<[string, string]> = [[absPath, home]];
  const realAbs = realpathOrUndefined(absPath);
  const realHome = realpathOrUndefined(home);
  if (realAbs && realHome) candidates.push([realAbs, realHome]);
  if (realAbs) candidates.push([realAbs, home]);
  if (realHome) candidates.push([absPath, realHome]);

  for (const [child, parent] of candidates) {
    const normalizedChild = stripWinLongPathPrefix(child);
    const normalizedParent = stripWinLongPathPrefix(parent);
    if (samePath(normalizedChild, normalizedParent)) return "~";
    if (isSubpath(normalizedChild, normalizedParent)) {
      return `~/${path.relative(normalizedParent, normalizedChild).split(path.sep).join("/")}`;
    }
  }

  // Windows short vs long path spellings can make path.relative walk through "..".
  // Walk ancestors of absPath until a realpath matches home's realpath.
  if (!realHome) return undefined;
  let current = path.resolve(absPath);
  const trail: string[] = [];
  while (true) {
    const realCurrent = realpathOrUndefined(current);
    if (realCurrent && samePath(realCurrent, realHome)) {
      return trail.length === 0 ? "~" : `~/${trail.reverse().join("/")}`;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    trail.push(path.basename(current).split(path.sep).join("/"));
    current = parent;
  }
  return undefined;
}

function displayPath(absPath: string, workspaceRoot: string, homes: string | string[] = os.homedir()): string {
  const homeList = Array.isArray(homes) ? homes : [homes];
  if (absPath === workspaceRoot || isSubpath(absPath, workspaceRoot)) {
    if (absPath === workspaceRoot) return "$WORKSPACE";
    return `$WORKSPACE/${path.relative(workspaceRoot, absPath).split(path.sep).join("/")}`;
  }
  for (const home of homeList) {
    const relative = homeRelativeDisplay(absPath, home);
    if (relative) return relative;
  }
  return absPath;
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

function compareSkillPrecedence(a: SkillInventoryRecord, b: SkillInventoryRecord): number {
  return (
    a.precedence - b.precedence ||
    skillSourceRank(a.source) - skillSourceRank(b.source) ||
    a.name.localeCompare(b.name) ||
    a.path.localeCompare(b.path)
  );
}

function activeSkillRecords(records: SkillInventoryRecord[]): SkillInventoryRecord[] {
  return unique([...records].sort(compareSkillPrecedence), (item) => item.name).sort(compareSkills);
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

async function findSkillFiles(
  root: string,
  maxDepth: number,
  out: Array<{ file: string; precedence: number; source: SkillInventoryItem["source"] }>,
  maxItems: number,
  precedence: number,
  source: SkillInventoryItem["source"]
): Promise<void> {
  if (out.length >= maxItems || maxDepth < 0) return;
  const entries = (await safeReaddir(root)).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxItems) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      out.push({ file: abs, precedence, source });
      continue;
    }
    if (entry.isDirectory()) {
      await findSkillFiles(abs, maxDepth - 1, out, maxItems, precedence, source);
      continue;
    }
    if (entry.isSymbolicLink()) {
      try {
        const target = realpathOrUndefined(abs);
        if (target && (await fsp.stat(target)).isDirectory()) {
          await findSkillFiles(target, maxDepth - 1, out, maxItems, precedence, source);
        }
      } catch {
        // Ignore broken or inaccessible skill directory links.
      }
    }
  }
}

async function discoverSkillRecords(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number; homeDir?: string } = {}
): Promise<SkillInventoryRecord[]> {
  const maxSkills = Math.max(1, Math.min(options.maxSkills ?? 120, 500));
  const workspaceRoot = realpathOrUndefined(workspace.root) ?? path.resolve(workspace.root);
  const requestedHomeDir = options.homeDir ?? os.homedir();
  const homeDir = realpathOrUndefined(requestedHomeDir) ?? path.resolve(requestedHomeDir);
  const homes = homePathCandidates(requestedHomeDir, homeDir);
  const workspaceRoots = [
    path.join(workspaceRoot, ".codex", "skills"),
    path.join(workspaceRoot, ".agents", "skills"),
    path.join(workspaceRoot, "skills")
  ].flatMap((dir) => {
    const real = realpathOrUndefined(dir);
    return real && isSubpath(real, workspaceRoot) ? [real] : [];
  });
  // Source comes from the configured scan root, not the symlink/junction target
  // path. Windows junctions often resolve to a different spelling of the same
  // home directory, which would otherwise misclassify user skills as "other".
  const roots = [
    ...workspaceRoots.map((dir) => ({ dir, source: "workspace" as const })),
    ...(options.includeGlobal
      ? [
          { dir: path.join(homeDir, ".codex", "skills"), source: "user" as const },
          { dir: path.join(homeDir, ".agents", "skills"), source: "user" as const },
          { dir: path.join(homeDir, ".codex", "plugins", "cache"), source: "plugin" as const }
        ]
      : [])
  ].filter((root) => fs.existsSync(root.dir));

  const skillFiles: Array<{ file: string; precedence: number; source: SkillInventoryItem["source"] }> = [];
  for (const [precedence, root] of roots.entries()) {
    await findSkillFiles(
      root.dir,
      root.dir.includes(`${path.sep}plugins${path.sep}cache`) ? 9 : 3,
      skillFiles,
      maxSkills,
      precedence,
      root.source
    );
    if (skillFiles.length >= maxSkills) break;
  }

  const items: SkillInventoryRecord[] = [];
  for (const discovered of skillFiles.slice(0, maxSkills)) {
    const file = discovered.file;
    const realFile = realpathOrUndefined(file) ?? file;
    if (isSubpath(file, workspaceRoot) && !isSubpath(realFile, workspaceRoot)) continue;
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
      source: discovered.source,
      path: displayPath(realFile, workspaceRoot, homes),
      absPath: realFile,
      precedence: discovered.precedence
    });
  }

  return unique(items, (item) => `${item.source}:${item.name}:${item.path}`).sort(compareSkillPrecedence);
}

export async function discoverSkillInventory(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number; homeDir?: string } = {}
): Promise<SkillInventoryItem[]> {
  return activeSkillRecords(await discoverSkillRecords(workspace, options)).map(publicSkill);
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
    homeDir?: string;
  }
): Promise<LoadedSkill> {
  const name = options.name.trim();
  if (!name) throw new Error("Skill name is required.");
  const requestedPath = options.path?.trim();

  const records = await discoverSkillRecords(workspace, {
    includeGlobal: options.includeGlobal !== false,
    maxSkills: options.maxSkills,
    homeDir: options.homeDir
  });
  const activeRecords = activeSkillRecords(records);
  const candidateRecords = requestedPath
    ? records
    : activeSkillRecords(options.source ? records.filter((skill) => skill.source === options.source) : records);
  const matches = candidateRecords.filter(
    (skill) =>
      skill.name === name &&
      (!options.source || skill.source === options.source) &&
      (!requestedPath || skill.path === requestedPath)
  );
  if (!matches.length) {
    const near = activeRecords
      .filter((skill) => skill.name.toLowerCase().includes(name.toLowerCase()))
      .slice(0, 8)
      .map((skill) => `${skill.name} [${skill.source}]`)
      .join(", ");
    const suffix = requestedPath ? ` at ${requestedPath}` : "";
    throw new Error(`Skill not found: ${name}${suffix}${near ? `. Similar skills: ${near}` : ""}`);
  }
  if (matches.length > 1) {
    const choices = matches.map((skill) => `${skill.name} [${skill.source}] at ${skill.path}`).join("; ");
    throw new Error(`Multiple exact skill matches remained for ${name}: ${choices}`);
  }

  const [skill] = matches;
  if (path.basename(skill.absPath) !== "SKILL.md") {
    throw new Error(`Refusing to load non-skill file: ${skill.path}`);
  }
  if (skill.source === "workspace") {
    const realSkillPath = realpathOrUndefined(skill.absPath);
    const realWorkspaceRoot = realpathOrUndefined(workspace.root) ?? path.resolve(workspace.root);
    if (!realSkillPath || !isSubpath(realSkillPath, realWorkspaceRoot)) {
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
    { file: path.join(os.homedir(), ".codex", "config.toml"), kind: "toml", source: "user codex config" },
    { file: path.join(workspace.root, ".mcp.json"), kind: "json", source: "workspace config" },
    { file: path.join(workspace.root, ".cursor", "mcp.json"), kind: "json", source: "workspace cursor config" },
    { file: path.join(os.homedir(), ".cursor", "mcp.json"), kind: "json", source: "user cursor config" }
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
    servers.push(...(candidate.kind === "toml" ? parseTomlMcpServers(text, candidate.source) : parseJsonMcpServers(text, candidate.source)));
  }

  return unique(servers, (server) => `${server.source}:${server.name}`)
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source))
    .slice(0, MAX_MCP_SERVER_INVENTORY);
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
