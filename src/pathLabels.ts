import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";

/**
 * Absolute local paths are replaced with stable labels before anything leaves the
 * server, so a connector client never learns the operator's directory layout.
 *
 * Ordering matters: entries are sorted longest-first so a workspace nested inside
 * the home directory is labelled [workspace:...] rather than [home]/....
 * The first label registered for a given path wins, which is why payload-derived
 * workspace roots are collected before the config-derived fallbacks.
 */
export type PathRedactions = Array<[string, string]>;

export function pathRedactions(config: CodexProConfig, discovered: unknown = undefined): PathRedactions {
  const replacements = new Map<string, string>();
  const add = (value: unknown, label: string): void => {
    if (typeof value !== "string" || !value || !path.isAbsolute(value)) return;
    if (!replacements.has(value)) replacements.set(value, label);
  };

  // Workspace roots come from the payload because MCP worktree ids are created at
  // runtime and appear nowhere in config.
  const collectWorkspaceRoots = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectWorkspaceRoots);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.root === "string") {
      add(record.root, `[workspace:${String(record.id ?? record.workspace_id ?? record.project_id ?? "current")}]`);
    }
    Object.values(record).forEach(collectWorkspaceRoots);
  };
  if (discovered !== undefined) collectWorkspaceRoots(discovered);

  add(config.defaultRoot, "[workspace]");
  for (const allowedRoot of config.allowedRoots) add(allowedRoot, "[allowed-root]");
  add(config.codexDir, "[codex-data]");
  add(os.homedir(), "[home]");
  return [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const boundaryPatterns = new Map<string, RegExp>();

/**
 * A registered path only matches at a path boundary, so /home/u/.codex never
 * rewrites the unrelated /home/u/.codexpro into "[codex-data]pro".
 */
function boundaryPattern(absolutePath: string): RegExp {
  const cached = boundaryPatterns.get(absolutePath);
  if (cached) return cached;
  const pattern = new RegExp(`${escapeRegExp(absolutePath)}(?![A-Za-z0-9_.-])`, "g");
  boundaryPatterns.set(absolutePath, pattern);
  return pattern;
}

export function redactPathsInText(value: string, ordered: PathRedactions): string {
  let output = value;
  for (const [absolutePath, label] of ordered) {
    output = output.replace(boundaryPattern(absolutePath), label);
  }
  return output;
}

export function redactPathsDeep<T>(value: T, ordered: PathRedactions): T {
  if (!ordered.length) return value;
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return redactPathsInText(input, ordered);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, child]) => [key, walk(child)]));
    }
    return input;
  };
  return walk(value) as T;
}

// A string that is entirely one absolute filesystem path. Anchored at both ends so
// URLs ("https://host/p"), labelled paths ("[home]/.codex") and prose that merely
// contains a slash are never matched.
const WHOLE_STRING_ABSOLUTE_PATH = /^(?:\/[^\0\n]*|[A-Za-z]:[\\/][^\0\n]*)$/;

function mapStrings<T>(value: T, fn: (input: string) => string): T {
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return fn(input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, child]) => [key, walk(child)]));
    }
    return input;
  };
  return walk(value) as T;
}

/**
 * Redact a config-echoing payload for the authenticated HTTP diagnostics endpoints,
 * which are reachable with the same bearer token an MCP client holds.
 *
 * `labelUnknownPaths` additionally collapses any string that is still a bare absolute
 * path into [path]. Those endpoints echo *stored* profile content, which can hold
 * paths from an older profile that the running config knows nothing about, so the
 * config-derived labels alone cannot cover them. It is deliberately not used for MCP
 * tool results, where file content and command output must survive untouched.
 */
export function redactConfigPaths<T>(
  config: CodexProConfig,
  value: T,
  options: { labelUnknownPaths?: boolean } = {}
): T {
  if (config.exposeAbsolutePaths) return value;
  const redacted = redactPathsDeep(value, pathRedactions(config, value));
  if (!options.labelUnknownPaths) return redacted;
  return mapStrings(redacted, (input) => (WHOLE_STRING_ABSOLUTE_PATH.test(input) ? "[path]" : input));
}
