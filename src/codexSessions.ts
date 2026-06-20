import { createReadStream, statSync, type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { CodexProConfig } from "./config.js";
import { CodexProError } from "./guard.js";

const CODEX_IDE_CONTEXT_PREFIX = "# Context from my IDE setup:";
const CODEX_REQUEST_MARKER = "my request for codex";
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const META_HEAD_BYTES = 64 * 1024;
const META_TAIL_BYTES = 64 * 1024;

export interface CodexSessionMeta {
  provider_id: "codex";
  session_id: string;
  title?: string;
  summary?: string;
  project_dir?: string;
  created_at?: number;
  last_active_at?: number;
  source_path: string;
  resume_command: string;
}

export interface CodexSessionMessage {
  role: string;
  content: string;
  ts?: number;
}

export interface CodexSessionListResult {
  codex_dir: string;
  roots: string[];
  sessions: CodexSessionMeta[];
  total_found: number;
}

export interface CodexSessionReadResult {
  session: CodexSessionMeta;
  messages: CodexSessionMessage[];
  truncated: boolean;
  text: string;
}

function codexDir(config: CodexProConfig): string {
  return path.resolve(config.codexDir || path.join(os.homedir(), ".codex"));
}

function sessionRoots(config: CodexProConfig): string[] {
  const root = codexDir(config);
  return [path.join(root, "sessions"), path.join(root, "archived_sessions")];
}

function ensureEnabled(config: CodexProConfig, read = false): void {
  if (config.codexSessions === "off") {
    throw new CodexProError("Codex session tools are disabled. Start with --codex-sessions metadata or --codex-sessions read to opt in.");
  }
  if (read && config.codexSessions !== "read") {
    throw new CodexProError("Reading Codex session transcripts is disabled. Start with --codex-sessions read to opt in.");
  }
}

function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectJsonlFiles(root: string, files: string[], maxDepth: number, maxFiles: number, depth = 0): Promise<void> {
  if (depth > maxDepth || files.length >= maxFiles) return;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(fullPath, files, maxDepth, maxFiles, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
}

async function readFileSlice(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function splitJsonlLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

async function readHeadTailLines(filePath: string, headLimit: number, tailLimit: number): Promise<{ head: string[]; tail: string[] }> {
  const fileStat = await fsp.stat(filePath);
  const headLength = Math.min(fileStat.size, META_HEAD_BYTES);
  const tailOffset = Math.max(0, fileStat.size - META_TAIL_BYTES);
  const tailLength = fileStat.size - tailOffset;
  const [headText, tailText] = await Promise.all([
    readFileSlice(filePath, 0, headLength),
    tailOffset === 0 && tailLength === headLength ? Promise.resolve("") : readFileSlice(filePath, tailOffset, tailLength)
  ]);

  const headLines = splitJsonlLines(headText);
  if (headLength < fileStat.size && !headText.endsWith("\n")) headLines.pop();

  const tailSource = tailText
    ? tailOffset > 0
      ? tailText.slice(Math.max(0, tailText.indexOf("\n") + 1))
      : tailText
    : headText;
  const tailLines = splitJsonlLines(tailSource);

  return {
    head: headLines.slice(0, headLimit),
    tail: tailLines.slice(-tailLimit)
  };
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "text" in item) return String((item as { text?: unknown }).text ?? "");
      return "";
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "");
  }
  return "";
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function basename(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[\\/]+$/, "");
  const base = path.basename(cleaned);
  return base || undefined;
}

function codexRequestHeadingPayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) return null;
  const heading = trimmed.replace(/^#+\s*/, "");
  const lowered = heading.toLowerCase();
  if (!lowered.startsWith(CODEX_REQUEST_MARKER)) return null;
  const suffix = heading.slice(CODEX_REQUEST_MARKER.length).trimStart();
  if (!suffix) return "";
  if (!/^[:：\-—]/.test(suffix)) return null;
  return suffix.replace(/^[:：\-—\s]+/, "").trim();
}

function extractCodexPromptFromIdeContext(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CODEX_IDE_CONTEXT_PREFIX)) return undefined;
  const lines = trimmed.replace(/\r\n/g, "\n").split("\n");
  let prompt: string | undefined;
  for (const [index, line] of lines.entries()) {
    const inline = codexRequestHeadingPayload(line);
    if (inline === null) continue;
    if (inline) {
      prompt = inline;
      continue;
    }
    const following = lines.slice(index + 1).join("\n").trim();
    prompt = following || undefined;
  }
  return prompt;
}

function titleCandidateFromUserMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("# AGENTS.md") || trimmed.startsWith("<environment_context>")) return undefined;
  if (trimmed.startsWith(CODEX_IDE_CONTEXT_PREFIX)) return extractCodexPromptFromIdeContext(trimmed);
  return trimmed;
}

function inferSessionIdFromFilename(filePath: string): string | undefined {
  const match = path.basename(filePath).match(UUID_RE);
  return match?.[0];
}

function parseJsonLine(line: string): any | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isSubagentSource(payload: any): boolean {
  return Boolean(payload?.source && typeof payload.source === "object" && "subagent" in payload.source);
}

async function parseSessionMeta(filePath: string): Promise<CodexSessionMeta | undefined> {
  const { head, tail } = await readHeadTailLines(filePath, 16, 48);
  let sessionId: string | undefined;
  let projectDir: string | undefined;
  let createdAt: number | undefined;
  let firstUserMessage: string | undefined;

  for (const line of head) {
    const value = parseJsonLine(line);
    if (!value) continue;
    createdAt ??= parseTimestamp(value.timestamp);
    if (value.type === "session_meta" && value.payload) {
      if (isSubagentSource(value.payload)) return undefined;
      sessionId ??= value.payload.id || value.payload.session_id || value.payload.sessionId;
      projectDir ??= value.payload.cwd || value.payload.project_dir || value.payload.projectDir;
      createdAt ??= parseTimestamp(value.payload.timestamp);
    }
    if (!firstUserMessage && value.type === "response_item" && value.payload?.type === "message" && value.payload?.role === "user") {
      const text = extractText(value.payload.content);
      firstUserMessage = titleCandidateFromUserMessage(text);
    }
  }

  let lastActiveAt: number | undefined;
  let summary: string | undefined;
  for (const line of [...tail].reverse()) {
    const value = parseJsonLine(line);
    if (!value) continue;
    lastActiveAt ??= parseTimestamp(value.timestamp);
    if (!summary && value.type === "response_item" && value.payload?.type === "message") {
      const text = extractText(value.payload.content);
      if (text.trim()) summary = text;
    }
    if (lastActiveAt && summary) break;
  }

  const id = String(sessionId || inferSessionIdFromFilename(filePath) || "").trim();
  if (!id) return undefined;
  const title = firstUserMessage ? truncate(firstUserMessage, 96) : basename(projectDir);

  return {
    provider_id: "codex",
    session_id: id,
    ...(title ? { title } : {}),
    ...(summary ? { summary: truncate(summary, 180) } : {}),
    ...(projectDir ? { project_dir: projectDir } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(lastActiveAt ? { last_active_at: lastActiveAt } : {}),
    source_path: filePath,
    resume_command: `codex resume ${id}`
  };
}

async function collectSessionMetas(config: CodexProConfig): Promise<CodexSessionMeta[]> {
  const files: string[] = [];
  for (const root of sessionRoots(config)) {
    await collectJsonlFiles(root, files, 6, 3000);
  }

  const sessions: CodexSessionMeta[] = [];
  for (const file of files) {
    const meta = await parseSessionMeta(file);
    if (meta) sessions.push(meta);
  }
  return sessions;
}

export async function listCodexSessions(
  config: CodexProConfig,
  options: { maxSessions?: number; query?: string } = {}
): Promise<CodexSessionListResult> {
  ensureEnabled(config);
  const roots = sessionRoots(config);
  const sessions = await collectSessionMetas(config);

  const query = options.query?.trim().toLowerCase();
  const filtered = query
    ? sessions.filter((session) => [
        session.session_id,
        session.title,
        session.summary,
        session.project_dir,
        session.source_path
      ].filter(Boolean).join("\n").toLowerCase().includes(query))
    : sessions;

  filtered.sort((a, b) => (b.last_active_at ?? b.created_at ?? 0) - (a.last_active_at ?? a.created_at ?? 0));
  const maxSessions = Math.max(1, Math.min(Number(options.maxSessions ?? 30), 200));
  return {
    codex_dir: codexDir(config),
    roots,
    sessions: filtered.slice(0, maxSessions),
    total_found: filtered.length
  };
}

async function resolveSessionSource(config: CodexProConfig, sessionId?: string, sourcePath?: string): Promise<CodexSessionMeta> {
  ensureEnabled(config, true);
  const roots = sessionRoots(config).map((root) => path.resolve(root));

  if (sourcePath) {
    const resolved = path.resolve(sourcePath);
    const canonical = await fsp.realpath(resolved).catch(() => resolved);
    if (!roots.some((root) => isSubpath(canonical, root))) {
      throw new CodexProError("Codex session source_path is outside configured Codex session roots.");
    }
    const meta = await parseSessionMeta(canonical);
    if (!meta) throw new CodexProError("Could not parse Codex session metadata from source_path.");
    if (sessionId && meta.session_id !== sessionId) throw new CodexProError("Codex session id does not match source_path.");
    return meta;
  }

  if (!sessionId) throw new CodexProError("session_id or source_path is required.");
  const sessions = await collectSessionMetas(config);
  const match = sessions.find((session) => session.session_id === sessionId);
  if (!match) throw new CodexProError(`Codex session not found: ${sessionId}`);
  return match;
}

async function loadSessionMessages(filePath: string, maxMessages: number, maxTotalBytes: number): Promise<{ messages: CodexSessionMessage[]; truncated: boolean }> {
  const size = statSync(filePath).size;
  if (size > 20_000_000) {
    throw new CodexProError(`Codex session file is too large (${size} bytes).`);
  }

  const messages: CodexSessionMessage[] = [];
  let usedBytes = 0;
  let truncated = false;
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of rl) {
    const value = parseJsonLine(line);
    if (value?.type !== "response_item" || !value.payload) continue;
    const payload = value.payload;
    let role = "";
    let content = "";
    if (payload.type === "message") {
      role = String(payload.role || "unknown");
      content = extractText(payload.content);
    } else if (payload.type === "function_call") {
      role = "assistant";
      content = `[Tool: ${payload.name || "unknown"}]`;
    } else if (payload.type === "function_call_output") {
      role = "tool";
      content = String(payload.output || "");
    } else {
      continue;
    }
    if (!content.trim()) continue;
    const nextBytes = Buffer.byteLength(content, "utf8");
    if (messages.length >= maxMessages || usedBytes + nextBytes > maxTotalBytes) {
      truncated = true;
      break;
    }
    usedBytes += nextBytes;
    const ts = parseTimestamp(value.timestamp);
    messages.push({ role, content, ...(ts !== undefined ? { ts } : {}) });
  }

  return { messages, truncated };
}

export async function readCodexSession(
  config: CodexProConfig,
  options: { sessionId?: string; sourcePath?: string; maxMessages?: number; maxTotalBytes?: number } = {}
): Promise<CodexSessionReadResult> {
  const session = await resolveSessionSource(config, options.sessionId, options.sourcePath);
  const maxMessages = Math.max(1, Math.min(Number(options.maxMessages ?? 80), 400));
  const maxTotalBytes = Math.max(4_000, Math.min(Number(options.maxTotalBytes ?? 80_000), 400_000));
  const { messages, truncated } = await loadSessionMessages(session.source_path, maxMessages, maxTotalBytes);
  const transcript = messages.map((message) => {
    const when = message.ts ? ` ${new Date(message.ts).toISOString()}` : "";
    return `### ${message.role}${when}\n\n${message.content}`;
  }).join("\n\n");
  const text = [
    "# Codex Session",
    "",
    `Session: ${session.session_id}`,
    session.title ? `Title: ${session.title}` : "",
    session.project_dir ? `CWD: ${session.project_dir}` : "",
    `Source: ${session.source_path}`,
    `Resume: ${session.resume_command}`,
    truncated ? "Transcript truncated by configured limits." : "",
    "",
    "## Transcript",
    "",
    transcript || "No readable transcript messages found."
  ].filter((line) => line !== "").join("\n");
  return { session, messages, truncated, text };
}
