export type AnalysisConfidence = "exact" | "strong" | "inferred";
export type AnalysisLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "swift"
  | "java"
  | "csharp"
  | "c"
  | "cpp"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "shell"
  | "unknown";
export type AnalysisFileRole = "source" | "test" | "config" | "docs" | "generated" | "infrastructure" | "other";
export type AnalysisSearchIntent = "auto" | "text" | "symbol" | "references" | "impact";
export type AnalysisResultGroup = "definitions" | "references" | "tests" | "configuration" | "documentation" | "other";

export interface AnalysisLimits {
  maxInventoryFiles: number;
  maxAnalyzedFiles: number;
  maxScannedBytes: number;
  maxSymbols: number;
  maxRelationships: number;
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  maxInventoryFiles: 20_000,
  maxAnalyzedFiles: 5_000,
  maxScannedBytes: 64 * 1024 * 1024,
  maxSymbols: 100_000,
  maxRelationships: 250_000
};

export interface InventoryFile {
  path: string;
  bytes: number;
  modifiedMs: number;
  language: AnalysisLanguage;
  role: AnalysisFileRole;
  generated: boolean;
  entrypoint: boolean;
}

export interface AnalysisCoverage {
  inventoryFiles: number;
  analyzedFiles: number;
  scannedBytes: number;
  symbolCount: number;
  relationshipCount: number;
  truncated: boolean;
  warnings: string[];
}

export interface InventoryResult {
  files: InventoryFile[];
  fingerprint: string;
  coverage: AnalysisCoverage;
}

export type AnalysisSymbolKind = "function" | "class" | "interface" | "enum" | "struct" | "trait" | "protocol" | "type" | "variable";
export type AnalysisRelationshipKind = "imports" | "references" | "tests" | "package";

export interface AnalysisSymbol {
  name: string;
  kind: AnalysisSymbolKind;
  path: string;
  line: number;
  exported: boolean;
  confidence: AnalysisConfidence;
}

export interface AnalysisRelationship {
  from: string;
  to: string;
  kind: AnalysisRelationshipKind;
  confidence: AnalysisConfidence;
  source: string;
}

export interface AnalysisArea {
  path: string;
  role: AnalysisFileRole;
  files: number;
}

export interface WorkspaceAnalysis {
  schemaVersion: 1;
  workspaceId: string;
  root: string;
  languages: AnalysisLanguage[];
  projectTypes: string[];
  entrypoints: string[];
  importantFiles: string[];
  areas: AnalysisArea[];
  files: InventoryFile[];
  symbols: AnalysisSymbol[];
  relationships: AnalysisRelationship[];
  coverage: AnalysisCoverage;
  warnings: string[];
  fingerprint: string;
  cache: { hit: boolean; key: string };
}

export interface StructuredSearchMatch {
  path: string;
  line: number;
  text: string;
  group: AnalysisResultGroup;
  score: number;
  reasons: string[];
  confidence: AnalysisConfidence;
  source: string;
}

export type StructuredSearchGroups = Record<AnalysisResultGroup, StructuredSearchMatch[]>;

export interface StructuredSearchResult {
  schemaVersion: 1;
  query: string;
  intent: Exclude<AnalysisSearchIntent, "auto">;
  groups: StructuredSearchGroups;
  matches: StructuredSearchMatch[];
  coverage: AnalysisCoverage;
  warnings: string[];
  cache: { hit: boolean; key: string };
}

export interface ProviderAvailability {
  available: boolean;
  detail?: string;
}

export interface AnalysisProvider {
  id: string;
  availability(workspace: { id: string; root: string }): Promise<ProviderAvailability>;
  inspect?(request: { workspaceId: string; root: string }): Promise<Partial<WorkspaceAnalysis>>;
  search?(request: { workspaceId: string; root: string; query: string; intent: AnalysisSearchIntent }): Promise<Partial<StructuredSearchResult>>;
}

export interface ImpactFile {
  path: string;
  confidence: AnalysisConfidence;
  reasons: string[];
}

export interface AnalysisRiskSignal {
  id: "public-api" | "authentication" | "storage" | "migration" | "build" | "configuration";
  label: string;
  confidence: AnalysisConfidence;
  paths: string[];
  reasons: string[];
}

export interface AnalysisCommandRecommendation {
  command: string;
  source: string;
  reasons: string[];
}

export interface ChangeAnalysis {
  schemaVersion: 1;
  changedPaths: string[];
  affectedAreas: string[];
  dependentFiles: ImpactFile[];
  relatedTests: ImpactFile[];
  riskSignals: AnalysisRiskSignal[];
  recommendedCommands: AnalysisCommandRecommendation[];
  coverage: AnalysisCoverage;
  warnings: string[];
  cache: { hit: boolean; key: string };
}
