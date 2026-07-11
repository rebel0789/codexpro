import type { CodexProConfig } from "../config.js";
import fsp from "node:fs/promises";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { detectProjectTypes } from "./classify.js";
import { getCachedWorkspaceAnalysis, invalidateWorkspaceAnalysis, setCachedWorkspaceAnalysis } from "./cache.js";
import { extractWorkspaceFiles } from "./extract.js";
import { buildRelationships } from "./graph.js";
import { inventoryWorkspace } from "./inventory.js";
import { classifySearchIntent, emptySearchGroups, groupForFile, sortStructuredMatches } from "./rank.js";
import type { AnalysisSearchIntent, StructuredSearchMatch, StructuredSearchResult, WorkspaceAnalysis } from "./types.js";

function cacheKey(workspace: Workspace, fingerprint: string, config: CodexProConfig): string {
  return `${workspace.id}:${fingerprint}:${JSON.stringify(config.analysisLimits)}`;
}

function areasFor(files: WorkspaceAnalysis["files"]): WorkspaceAnalysis["areas"] {
  const counts = new Map<string, { role: WorkspaceAnalysis["files"][number]["role"]; files: number }>();
  for (const file of files) {
    const top = file.path.includes("/") ? file.path.split("/")[0] : ".";
    const current = counts.get(top) ?? { role: file.role, files: 0 };
    current.files += 1;
    if (current.role === "other" && file.role !== "other") current.role = file.role;
    counts.set(top, current);
  }
  return [...counts.entries()].map(([areaPath, value]) => ({ path: areaPath, ...value })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

export async function inspectWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<WorkspaceAnalysis> {
  if (!config.analysisEnabled) throw new Error("Repository analysis is disabled by CODEXPRO_ANALYSIS=0.");
  const inventory = await inventoryWorkspace(config, guard, workspace);
  const key = cacheKey(workspace, inventory.fingerprint, config);
  const cached = getCachedWorkspaceAnalysis(key);
  if (cached) return { ...cached, cache: { hit: true, key } };

  const extraction = await extractWorkspaceFiles(config, guard, workspace, inventory.files);
  const symbols = extraction.files.flatMap((file) => file.symbols).slice(0, config.analysisLimits.maxSymbols);
  const relationships = buildRelationships(extraction.files, inventory.files, config.analysisLimits.maxRelationships);
  const languages = [...new Set(inventory.files.map((file) => file.language).filter((language) => language !== "unknown"))].sort();
  const warnings = [...inventory.coverage.warnings, ...extraction.warnings];
  const result: WorkspaceAnalysis = {
    schemaVersion: 1,
    workspaceId: workspace.id,
    root: workspace.root,
    languages,
    projectTypes: detectProjectTypes(inventory.files),
    entrypoints: inventory.files.filter((file) => file.entrypoint).map((file) => file.path),
    importantFiles: inventory.files.filter((file) => file.role === "config" || /(^|\/)(README|AGENTS)\.md$/i.test(file.path)).map((file) => file.path),
    areas: areasFor(inventory.files),
    files: inventory.files,
    symbols,
    relationships,
    coverage: {
      ...inventory.coverage,
      analyzedFiles: extraction.analyzedFiles,
      scannedBytes: extraction.scannedBytes,
      symbolCount: symbols.length,
      relationshipCount: relationships.length,
      truncated: inventory.coverage.truncated || extraction.truncated,
      warnings
    },
    warnings,
    fingerprint: inventory.fingerprint,
    cache: { hit: false, key }
  };
  setCachedWorkspaceAnalysis(key, result);
  return result;
}

export async function searchWorkspaceStructured(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { query: string; intent?: AnalysisSearchIntent; includeTests?: boolean; regex?: boolean; root?: string; maxResults?: number }
): Promise<StructuredSearchResult> {
  const query = options.query.trim();
  if (!query) throw new Error("query is required.");
  const analysis = await inspectWorkspace(config, guard, workspace);
  const intent = classifySearchIntent(query, options.intent ?? "auto", options.regex);
  const groups = emptySearchGroups();
  const lowered = query.toLowerCase();
  const matches: StructuredSearchMatch[] = [];
  const warnings = [...analysis.warnings];
  const resultLimit = Math.max(1, Math.min(options.maxResults ?? config.maxSearchResults, config.maxSearchResults));
  const candidateLimit = Math.max(resultLimit, Math.min(resultLimit * 4, 20_000));
  const resolvedRoot = options.root?.trim() ? guard.resolve(workspace, options.root).relPath.replace(/^\.\/?$/, "") : "";
  const inScope = (filePath: string) => !resolvedRoot || filePath === resolvedRoot || filePath.startsWith(`${resolvedRoot}/`);
  const definitionsByPath = new Map<string, Map<number, WorkspaceAnalysis["symbols"][number]>>();
  for (const symbol of analysis.symbols) {
    const byLine = definitionsByPath.get(symbol.path) ?? new Map<number, WorkspaceAnalysis["symbols"][number]>();
    byLine.set(symbol.line, symbol);
    definitionsByPath.set(symbol.path, byLine);
  }
  if (options.regex) {
    warnings.push("Grouped results are unavailable for regular expression searches. Lexical regex matching remains delegated to ripgrep.");
    return {
      schemaVersion: 1,
      query,
      intent,
      groups,
      matches: [],
      coverage: { ...analysis.coverage, truncated: true, warnings },
      warnings,
      cache: analysis.cache
    };
  }
  let scannedFiles = 0;
  let scannedBytes = 0;
  let searchBudgetReached = false;
  let candidateLimitReached = false;
  let skippedFiles = 0;

  scan:
  for (const file of analysis.files) {
    if (file.generated || (!options.includeTests && file.role === "test")) continue;
    if (!inScope(file.path) && !(options.includeTests && file.role === "test")) continue;
    if (scannedFiles >= config.analysisLimits.maxAnalyzedFiles || scannedBytes + file.bytes > config.analysisLimits.maxScannedBytes) {
      searchBudgetReached = true;
      break;
    }
    let text: string;
    try {
      const resolved = guard.resolve(workspace, file.path);
      text = await fsp.readFile(resolved.absPath, "utf8");
    } catch {
      skippedFiles += 1;
      continue;
    }
    const actualBytes = Buffer.byteLength(text, "utf8");
    if (scannedBytes + actualBytes > config.analysisLimits.maxScannedBytes) {
      searchBudgetReached = true;
      break;
    }
    scannedFiles += 1;
    scannedBytes += actualBytes;
    const definitions = definitionsByPath.get(file.path) ?? new Map();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toLowerCase().includes(lowered)) continue;
      const symbol = definitions.get(index + 1);
      const isDefinition = Boolean(symbol && symbol.name.toLowerCase() === lowered);
      const group = groupForFile(analysis, file.path, isDefinition);
      const reasons = isDefinition ? ["exact text match", "symbol definition"] : file.role === "test" ? ["exact text match", "related test"] : ["exact text match"];
      if (matches.length >= candidateLimit) {
        candidateLimitReached = true;
        break scan;
      }
      matches.push({
        path: file.path,
        line: index + 1,
        text: redactSensitiveText(line.trim().slice(0, 400)),
        group,
        score: isDefinition ? 190 : file.role === "test" ? 160 : 100,
        reasons,
        confidence: isDefinition ? "strong" : "exact",
        source: "built-in analysis"
      });
    }
  }

  if (searchBudgetReached) warnings.push("Grouped search reached its configured file or byte limit.");
  if (skippedFiles) warnings.push(`Grouped search skipped ${skippedFiles} file${skippedFiles === 1 ? "" : "s"} that changed or became unreadable during analysis.`);

  if (intent === "references" || intent === "impact") {
    const definitionPaths = new Set(
      analysis.symbols
        .filter((symbol) => symbol.name.toLowerCase() === lowered)
        .map((symbol) => symbol.path)
    );
    for (const relationship of analysis.relationships) {
      if (!definitionPaths.has(relationship.to)) continue;
      const group = relationship.kind === "tests" ? "tests" : "references";
      if (group === "tests" && !options.includeTests) continue;
      const reason = relationship.kind === "tests" ? "dependent test" : "dependent module";
      const existing = matches.find((match) => match.path === relationship.from && match.group === group);
      if (existing) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
        existing.score = Math.max(existing.score, relationship.kind === "tests" ? 170 : 165);
        existing.confidence = "strong";
        continue;
      }
      if (matches.length >= candidateLimit) {
        candidateLimitReached = true;
        continue;
      }
      matches.push({
        path: relationship.from,
        line: 1,
        text: `${relationship.kind} ${relationship.to}`,
        group,
        score: relationship.kind === "tests" ? 170 : 165,
        reasons: [reason, `${relationship.kind} relationship`],
        confidence: "strong",
        source: relationship.source
      });
    }
  }

  if (candidateLimitReached) warnings.push(`Grouped search retained the first ${candidateLimit} candidates before ranking.`);

  for (const match of sortStructuredMatches(matches).slice(0, resultLimit)) groups[match.group].push(match);
  return {
    schemaVersion: 1,
    query,
    intent,
    groups,
    matches: Object.values(groups).flat(),
    coverage: {
      ...analysis.coverage,
      truncated: analysis.coverage.truncated || searchBudgetReached || candidateLimitReached || skippedFiles > 0,
      warnings
    },
    warnings,
    cache: analysis.cache
  };
}

export { invalidateWorkspaceAnalysis } from "./cache.js";
export { reviewWorkspaceChanges } from "./impact.js";
export { listAnalysisProviders, normalizeProviderPaths, registerAnalysisProvider } from "./providers.js";
export type * from "./types.js";
