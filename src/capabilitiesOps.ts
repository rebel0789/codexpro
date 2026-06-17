import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";

export interface SkillInventoryItem {
  name: string;
  description?: string;
  source: "workspace" | "user" | "plugin" | "other";
  path: string;
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

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
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

export async function discoverSkillInventory(
  workspace: Workspace,
  options: { includeGlobal?: boolean; maxSkills?: number } = {}
): Promise<SkillInventoryItem[]> {
  const maxSkills = Math.max(1, Math.min(options.maxSkills ?? 120, 500));
  const roots = [
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, ".agents", "skills"),
    path.join(workspace.root, "skills"),
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

  const items: SkillInventoryItem[] = [];
  for (const file of skillFiles.slice(0, maxSkills)) {
    let text = "";
    try {
      text = await safeReadText(file);
    } catch {
      // Keep the skill visible even if the file cannot be read.
    }
    const name = frontmatterValue(text, "name") ?? path.basename(path.dirname(file));
    const description = frontmatterValue(text, "description");
    items.push({
      name,
      description,
      source: skillSource(file, workspace.root),
      path: displayPath(file, workspace.root)
    });
  }

  return unique(items, (item) => `${item.source}:${item.name}:${item.path}`).sort((a, b) =>
    `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`)
  );
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
