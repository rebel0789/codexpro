import { type Dirent } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  direction: "head" | "tail";
  cursor: number;
  resume_cursor: number;
  next_cursor?: number;
  has_more: boolean;
  source_size_bytes: number;
  text: string;
}

export interface CodexSessionSearchMatch {
  message_id: string;
  byte_offset: number;
  role: string;
  snippet: string;
  ts?: number;
  tool_name?: string;
}

export interface CodexSessionSearchResult {
  session: CodexSessionMeta;
  matches: CodexSessionSearchMatch[];
  truncated: boolean;
  source_size_bytes: number;
  text: string;
}

export interface CodexSessionAroundResult {
  session: CodexSessionMeta;
  messages: CodexSessionMessage[];
  target: { message_id: string; byte_offset: number; ts?: number };
  before: number;
  after: number;
  has_more_before: boolean;
  has_more_after: boolean;
  truncated: boolean;
  source_size_bytes: number;
  text: string;
}

interface JsonlLine {
  line: string;
  start: number;
  end: number;
}

interface SessionMessageRecord {
  message: CodexSessionMessage;
  start: number;
  end: number;
}

const SESSION_READ_BLOCK_BYTES = 64 * 1024;
const DEFAULT_TOOL_OUTPUT_BYTES = 20_000;

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
  for (const line of [...tail].reverse()) {
    const value = parseJsonLine(line);
    if (!value) continue;
    lastActiveAt ??= parseTimestamp(value.timestamp);
    if (lastActiveAt) break;
  }

  const id = String(sessionId || inferSessionIdFromFilename(filePath) || "").trim();
  if (!id) return undefined;
  const title = firstUserMessage ? truncate(firstUserMessage, 96) : basename(projectDir);

  return {
    provider_id: "codex",
    session_id: id,
    ...(title ? { title } : {}),
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
    const meta = await parseSessionMeta(file).catch(() => undefined);
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
  const roots = await Promise.all(sessionRoots(config).map(async (root) => fsp.realpath(root).catch(() => path.resolve(root))));

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

function clampCursor(value: number | undefined, size: number, direction: "head" | "tail"): number {
  if (value === undefined) return direction === "tail" ? size : 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new CodexProError("cursor must be a non-negative integer byte offset returned by a previous read_codex_session call.");
  }
  if (value > size) {
    throw new CodexProError("cursor is beyond the current Codex session file. The source may have been truncated or replaced; restart pagination without a cursor.");
  }
  return value;
}

async function* readJsonlLinesFromHead(filePath: string, startOffset: number, endOffset: number): AsyncGenerator<JsonlLine> {
  const handle = await fsp.open(filePath, "r");
  try {
    let position = startOffset;
    let pending: Buffer[] = [];
    let pendingStart = startOffset;
    while (position < endOffset) {
      const length = Math.min(SESSION_READ_BLOCK_BYTES, endOffset - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (!bytesRead) break;
      const current = chunk.subarray(0, bytesRead);
      let lineStart = 0;
      while (true) {
        const newline = current.indexOf(0x0a, lineStart);
        if (newline === -1) break;
        const segment = current.subarray(lineStart, newline);
        const line = pending.length ? Buffer.concat([...pending, segment]) : segment;
        yield {
          line: line.toString("utf8"),
          start: pendingStart,
          end: position + newline + 1
        };
        pending = [];
        lineStart = newline + 1;
        pendingStart = position + lineStart;
      }
      const remainder = current.subarray(lineStart);
      if (remainder.length) pending.push(remainder);
      position += bytesRead;
    }
    if (pending.length) {
      const line = Buffer.concat(pending);
      yield { line: line.toString("utf8"), start: pendingStart, end: pendingStart + line.length };
    }
  } finally {
    await handle.close();
  }
}

async function* readJsonlLinesFromTail(filePath: string, endOffset: number): AsyncGenerator<JsonlLine> {
  const handle = await fsp.open(filePath, "r");
  try {
    let position = endOffset;
    let pending: Buffer[] = [];
    let pendingEnd = endOffset;
    while (position > 0) {
      const start = Math.max(0, position - SESSION_READ_BLOCK_BYTES);
      const length = position - start;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      if (!bytesRead) break;
      const current = chunk.subarray(0, bytesRead);
      let lineEnd = current.length;
      while (true) {
        const newline = current.lastIndexOf(0x0a, lineEnd - 1);
        if (newline === -1) break;
        const lineStart = newline + 1;
        const segment = current.subarray(lineStart, lineEnd);
        const line = pending.length
          ? Buffer.concat([segment, ...pending.slice().reverse()])
          : segment;
        if (line.length) {
          yield { line: line.toString("utf8"), start: start + lineStart, end: pendingEnd };
        }
        pending = [];
        pendingEnd = start + newline;
        lineEnd = newline;
      }
      const remainder = current.subarray(0, lineEnd);
      if (remainder.length) pending.push(remainder);
      position = start;
    }
    if (pending.length) {
      const line = Buffer.concat(pending.slice().reverse());
      yield { line: line.toString("utf8"), start: 0, end: pendingEnd };
    }
  } finally {
    await handle.close();
  }
}

function truncateUtf8(text: string, maxBytes: number, suffix = "…"): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const fittedSuffix = suffixBytes <= maxBytes ? suffix : "";
  const bodyBudget = maxBytes - Buffer.byteLength(fittedSuffix, "utf8");
  let usedBytes = 0;
  let body = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > bodyBudget) break;
    body += character;
    usedBytes += characterBytes;
  }
  return `${body}${fittedSuffix}`;
}

function boundedToolOutput(output: unknown, maxBytes: number): string {
  const content = String(output || "");
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  if (maxBytes <= 0) return "";
  const marker = "\n[Tool output truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return truncateUtf8(content, maxBytes, "");
  return `${truncateUtf8(content, maxBytes - markerBytes, "")}${marker}`;
}

function messageFromJsonlLine(
  line: string,
  options: { excludeToolOutputs: boolean; maxToolOutputBytes: number }
): CodexSessionMessage | undefined {
  const value = parseJsonLine(line);
  if (value?.type !== "response_item" || !value.payload) return undefined;
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
    if (options.excludeToolOutputs) return undefined;
    role = "tool";
    content = boundedToolOutput(payload.output, options.maxToolOutputBytes);
  } else {
    return undefined;
  }
  if (!content.trim()) return undefined;
  const ts = parseTimestamp(value.timestamp);
  return { role, content, ...(ts !== undefined ? { ts } : {}) };
}

function messageDetailsFromJsonlLine(
  line: string,
  options: { excludeToolOutputs: boolean; maxToolOutputBytes: number }
): { message: CodexSessionMessage; toolName?: string } | undefined {
  const value = parseJsonLine(line);
  if (value?.type !== "response_item" || !value.payload) return undefined;
  const message = messageFromJsonlLine(line, options);
  if (!message) return undefined;
  return {
    message,
    ...(value.payload.type === "function_call" && value.payload.name ? { toolName: String(value.payload.name) } : {})
  };
}

function timestampBound(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function snippetAround(text: string, query: string, maxChars: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const matchIndex = clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchIndex < 0) return truncate(clean, maxChars);
  const radius = Math.max(20, Math.floor((maxChars - query.length) / 2));
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(clean.length, matchIndex + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`.slice(0, maxChars);
}

export async function searchCodexSession(
  config: CodexProConfig,
  options: {
    sessionId?: string;
    sourcePath?: string;
    query: string;
    roles?: string[];
    toolNames?: string[];
    timeFrom?: string | number;
    timeTo?: string | number;
    maxResults?: number;
    maxSnippetBytes?: number;
  }
): Promise<CodexSessionSearchResult> {
  const session = await resolveSessionSource(config, options.sessionId, options.sourcePath);
  const query = options.query.trim();
  if (!query) throw new CodexProError("query is required.");
  const sourceSizeBytes = (await fsp.stat(session.source_path)).size;
  const allowedRoles = new Set((options.roles ?? []).map((role) => role.trim().toLowerCase()).filter(Boolean));
  const allowedTools = new Set((options.toolNames ?? []).map((tool) => tool.trim().toLowerCase()).filter(Boolean));
  const from = timestampBound(options.timeFrom);
  const to = timestampBound(options.timeTo);
  const maxResults = Math.max(1, Math.min(Number(options.maxResults ?? 30), 100));
  const maxSnippetBytes = Math.max(80, Math.min(Number(options.maxSnippetBytes ?? 600), 4_000));
  const matches: CodexSessionSearchMatch[] = [];
  let truncated = false;
  for await (const line of readJsonlLinesFromHead(session.source_path, 0, sourceSizeBytes)) {
    const details = messageDetailsFromJsonlLine(line.line, { excludeToolOutputs: false, maxToolOutputBytes: 12_000 });
    if (!details) continue;
    const { message, toolName } = details;
    if (allowedRoles.size && !allowedRoles.has(message.role.toLowerCase())) continue;
    if (allowedTools.size && (!toolName || !allowedTools.has(toolName.toLowerCase()))) continue;
    if (from !== undefined && (message.ts === undefined || message.ts < from)) continue;
    if (to !== undefined && (message.ts === undefined || message.ts > to)) continue;
    if (!message.content.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    matches.push({
      message_id: String(line.start),
      byte_offset: line.start,
      role: message.role,
      snippet: snippetAround(message.content, query, maxSnippetBytes),
      ...(message.ts !== undefined ? { ts: message.ts } : {}),
      ...(toolName ? { tool_name: toolName } : {})
    });
  }
  const rows = matches.length
    ? matches.map((match) => `- ${match.message_id} ${match.role}${match.tool_name ? ` [${match.tool_name}]` : ""}: ${match.snippet}`).join("\n")
    : "- No matching messages.";
  const text = [
    "# Search Codex Session",
    "",
    `Session: ${session.session_id}`,
    `Query: ${query}`,
    `Matches: ${matches.length}${truncated ? "+" : ""}`,
    "",
    rows
  ].join("\n");
  return { session, matches, truncated, source_size_bytes: sourceSizeBytes, text };
}

async function targetOffsetForSession(
  filePath: string,
  options: { messageId?: string; byteOffset?: number; timestamp?: string | number }
): Promise<{ offset: number; ts?: number }> {
  if (options.byteOffset !== undefined) {
    if (!Number.isInteger(options.byteOffset) || options.byteOffset < 0) throw new CodexProError("byte_offset must be a non-negative integer.");
    return { offset: options.byteOffset };
  }
  if (options.messageId?.trim()) {
    const offset = Number(options.messageId);
    if (!Number.isInteger(offset) || offset < 0) throw new CodexProError("message_id must be the byte offset returned by search_codex_session.");
    return { offset };
  }
  const targetTs = timestampBound(options.timestamp);
  if (targetTs === undefined) throw new CodexProError("message_id, byte_offset, or timestamp is required.");
  const size = (await fsp.stat(filePath)).size;
  for await (const line of readJsonlLinesFromHead(filePath, 0, size)) {
    const details = messageDetailsFromJsonlLine(line.line, { excludeToolOutputs: false, maxToolOutputBytes: 1_000 });
    if (details?.message.ts !== undefined && details.message.ts >= targetTs) return { offset: line.start, ts: details.message.ts };
  }
  throw new CodexProError("No transcript message matched the requested timestamp.");
}

async function loadSessionMessagesAround(
  filePath: string,
  targetOffset: number,
  options: { before: number; after: number; maxTotalBytes: number; excludeToolOutputs: boolean; maxToolOutputBytes: number }
): Promise<{ messages: CodexSessionMessage[]; target: { offset: number; ts?: number }; hasMoreBefore: boolean; hasMoreAfter: boolean; truncated: boolean; sourceSizeBytes: number }> {
  const sourceSizeBytes = (await fsp.stat(filePath)).size;
  if (targetOffset > sourceSizeBytes) throw new CodexProError("byte offset is beyond the current Codex session file.");
  const beforeRecords: SessionMessageRecord[] = [];
  const selected: SessionMessageRecord[] = [];
  let found = false;
  let afterCount = 0;
  let hasMoreBefore = false;
  let hasMoreAfter = false;
  let targetTs: number | undefined;
  for await (const line of readJsonlLinesFromHead(filePath, 0, sourceSizeBytes)) {
    const parsed = messageDetailsFromJsonlLine(line.line, options);
    if (!parsed) continue;
    const record = { message: parsed.message, start: line.start, end: line.end };
    if (!found) {
      if (line.start <= targetOffset && targetOffset < line.end) {
        found = true;
        targetTs = parsed.message.ts;
        selected.push(record);
        continue;
      }
      beforeRecords.push(record);
      if (beforeRecords.length > options.before) {
        beforeRecords.shift();
        hasMoreBefore = true;
      }
      continue;
    }
    if (afterCount < options.after) {
      selected.push(record);
      afterCount += 1;
    } else {
      hasMoreAfter = true;
      break;
    }
  }
  if (!found) throw new CodexProError("No transcript message matched the requested message_id or byte_offset.");
  const orderedRecords = selected.length
    ? [selected[0], ...beforeRecords.slice().reverse(), ...selected.slice(1)]
    : [];
  const accepted = new Map<number, CodexSessionMessage>();
  let usedBytes = 0;
  let truncated = false;
  for (const record of orderedRecords) {
    const message = record.message;
    const remaining = options.maxTotalBytes - usedBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const contentBytes = Buffer.byteLength(message.content, "utf8");
    const bounded = contentBytes > remaining ? { ...message, content: truncateUtf8(message.content, remaining) } : message;
    if (!bounded.content) {
      truncated = true;
      break;
    }
    accepted.set(record.start, bounded);
    usedBytes += Buffer.byteLength(bounded.content, "utf8");
    if (contentBytes > remaining) {
      truncated = true;
      break;
    }
  }
  const messages = [...accepted.entries()].sort(([left], [right]) => left - right).map(([, message]) => message);
  return {
    messages,
    target: { offset: targetOffset, ...(targetTs !== undefined ? { ts: targetTs } : {}) },
    hasMoreBefore,
    hasMoreAfter,
    truncated,
    sourceSizeBytes
  };
}

function transcriptText(session: CodexSessionMeta, messages: CodexSessionMessage[], heading: string): string {
  const transcript = messages.map((message) => {
    const when = message.ts ? ` ${new Date(message.ts).toISOString()}` : "";
    return `### ${message.role}${when}\n\n${message.content}`;
  }).join("\n\n");
  return [
    `# ${heading}`,
    "",
    `Session: ${session.session_id}`,
    session.title ? `Title: ${session.title}` : "",
    session.project_dir ? `CWD: ${session.project_dir}` : "",
    `Source: ${session.source_path}`,
    "",
    "## Transcript",
    "",
    transcript || "No readable transcript messages found."
  ].filter((line) => line !== "").join("\n");
}

export async function readCodexSessionAround(
  config: CodexProConfig,
  options: {
    sessionId?: string;
    sourcePath?: string;
    messageId?: string;
    byteOffset?: number;
    timestamp?: string | number;
    before?: number;
    after?: number;
    maxTotalBytes?: number;
    excludeToolOutputs?: boolean;
    maxToolOutputBytes?: number;
  }
): Promise<CodexSessionAroundResult> {
  const session = await resolveSessionSource(config, options.sessionId, options.sourcePath);
  const target = await targetOffsetForSession(session.source_path, options);
  const before = Math.max(0, Math.min(Number(options.before ?? 10), 100));
  const after = Math.max(0, Math.min(Number(options.after ?? 10), 100));
  const maxTotalBytes = Math.max(4_000, Math.min(Number(options.maxTotalBytes ?? 80_000), 400_000));
  const maxToolOutputBytes = Math.max(0, Math.min(Number(options.maxToolOutputBytes ?? DEFAULT_TOOL_OUTPUT_BYTES), 400_000));
  const result = await loadSessionMessagesAround(session.source_path, target.offset, {
    before,
    after,
    maxTotalBytes,
    excludeToolOutputs: options.excludeToolOutputs === true,
    maxToolOutputBytes
  });
  return {
    session,
    messages: result.messages,
    target: {
      message_id: String(result.target.offset),
      byte_offset: result.target.offset,
      ...(result.target.ts !== undefined ? { ts: result.target.ts } : {})
    },
    before,
    after,
    has_more_before: result.hasMoreBefore,
    has_more_after: result.hasMoreAfter,
    truncated: result.truncated,
    source_size_bytes: result.sourceSizeBytes,
    text: transcriptText(session, result.messages, "Read Around Codex Session")
  };
}

async function loadSessionMessages(
  filePath: string,
  options: {
    direction: "head" | "tail";
    cursor?: number;
    maxMessages: number;
    maxTotalBytes: number;
    excludeToolOutputs: boolean;
    maxToolOutputBytes: number;
  }
): Promise<{ messages: CodexSessionMessage[]; truncated: boolean; cursor: number; resumeCursor: number; nextCursor?: number; hasMore: boolean; sourceSizeBytes: number }> {
  const sourceSizeBytes = (await fsp.stat(filePath)).size;
  const cursor = clampCursor(options.cursor, sourceSizeBytes, options.direction);
  const lines = options.direction === "tail"
    ? readJsonlLinesFromTail(filePath, cursor)
    : readJsonlLinesFromHead(filePath, cursor, sourceSizeBytes);
  const records: SessionMessageRecord[] = [];
  let usedBytes = 0;
  let truncated = false;
  let hasMore = false;

  for await (const line of lines) {
    const parsed = messageFromJsonlLine(line.line, options);
    if (!parsed) continue;
    if (records.length >= options.maxMessages || usedBytes >= options.maxTotalBytes) {
      truncated = true;
      hasMore = true;
      break;
    }
    const remainingBytes = options.maxTotalBytes - usedBytes;
    const contentBytes = Buffer.byteLength(parsed.content, "utf8");
    const message = contentBytes > remainingBytes
      ? { ...parsed, content: truncateUtf8(parsed.content, remainingBytes) }
      : parsed;
    if (!message.content) {
      truncated = true;
      hasMore = true;
      break;
    }
    if (contentBytes > remainingBytes) truncated = true;
    usedBytes += Buffer.byteLength(message.content, "utf8");
    records.push({ message, start: line.start, end: line.end });
  }

  const ordered = options.direction === "tail" ? records.reverse() : records;
  const resumeCursor = records.length
    ? options.direction === "tail"
      ? Math.min(...records.map((record) => record.start))
      : Math.max(...records.map((record) => record.end))
    : cursor;
  return {
    messages: ordered.map((record) => record.message),
    truncated,
    cursor,
    resumeCursor,
    ...(hasMore ? { nextCursor: resumeCursor } : {}),
    hasMore,
    sourceSizeBytes
  };
}

export async function readCodexSession(
  config: CodexProConfig,
  options: {
    sessionId?: string;
    sourcePath?: string;
    direction?: "head" | "tail";
    cursor?: number;
    maxMessages?: number;
    maxTotalBytes?: number;
    excludeToolOutputs?: boolean;
    maxToolOutputBytes?: number;
  } = {}
): Promise<CodexSessionReadResult> {
  const session = await resolveSessionSource(config, options.sessionId, options.sourcePath);
  const direction = options.direction === "head" ? "head" : "tail";
  const maxMessages = Math.max(1, Math.min(Number(options.maxMessages ?? 80), 400));
  const maxTotalBytes = Math.max(4_000, Math.min(Number(options.maxTotalBytes ?? 80_000), 400_000));
  const maxToolOutputBytes = Math.max(0, Math.min(Number(options.maxToolOutputBytes ?? DEFAULT_TOOL_OUTPUT_BYTES), 400_000));
  const { messages, truncated, cursor, resumeCursor, nextCursor, hasMore, sourceSizeBytes } = await loadSessionMessages(session.source_path, {
    direction,
    cursor: options.cursor,
    maxMessages,
    maxTotalBytes,
    excludeToolOutputs: options.excludeToolOutputs === true,
    maxToolOutputBytes
  });
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
    `Direction: ${direction}`,
    `Cursor: ${cursor}`,
    `Resume cursor: ${resumeCursor}`,
    hasMore && nextCursor !== undefined ? `Next cursor: ${nextCursor}` : "",
    `Resume: ${session.resume_command}`,
    truncated ? "Transcript truncated by configured limits." : "",
    "",
    "## Transcript",
    "",
    transcript || "No readable transcript messages found."
  ].filter((line) => line !== "").join("\n");
  return {
    session,
    messages,
    truncated,
    direction,
    cursor,
    resume_cursor: resumeCursor,
    ...(nextCursor !== undefined ? { next_cursor: nextCursor } : {}),
    has_more: hasMore,
    source_size_bytes: sourceSizeBytes,
    text
  };
}
