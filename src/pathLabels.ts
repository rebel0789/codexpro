import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";

export type PathRedactions = Array<[string, string]>;

export function pathRedactions(config: CodexProConfig, discovered: unknown = undefined): PathRedactions {
  const replacements = new Map<string, string>();
  const add = (value: unknown, label: string): void => {
    if (typeof value !== "string" || !value || !path.isAbsolute(value)) return;
    if (!replacements.has(value)) replacements.set(value, label);
  };

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
