import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import type { AnalysisLanguage, AnalysisSymbol, AnalysisSymbolKind, InventoryFile } from "./types.js";

type Pattern = { regex: RegExp; kind: AnalysisSymbolKind };

const DECLARATIONS: Partial<Record<AnalysisLanguage, Pattern[]>> = {
  typescript: [
    { regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" }
  ],
  javascript: [
    { regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" }
  ],
  python: [
    { regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" }
  ],
  go: [
    { regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type" }
  ],
  rust: [
    { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" }
  ],
  swift: [
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?func\s+([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?protocol\s+([A-Za-z_]\w*)/, kind: "protocol" }
  ],
  java: [
    { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" }
  ],
  csharp: [
    { regex: /^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { regex: /^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" }
  ],
  c: [{ regex: /^\s*[A-Za-z_]\w*(?:\s+[*])?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, kind: "function" }],
  cpp: [
    { regex: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { regex: /^\s*[A-Za-z_:][\w:<>,*&\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, kind: "function" }
  ]
};

const SOURCE_LANGUAGES = new Set<AnalysisLanguage>(["typescript", "javascript", "python", "go", "rust", "swift", "java", "csharp", "c", "cpp"]);

export interface ExtractedFile {
  path: string;
  text: string;
  symbols: AnalysisSymbol[];
  imports: string[];
}

function importSpecifiers(language: AnalysisLanguage, line: string): string[] {
  if (language === "typescript" || language === "javascript") {
    const match = line.match(/\b(?:import|export)\b[^"']*?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/);
    return match ? [match[1] ?? match[2]].filter(Boolean) : [];
  }
  if (language === "c" || language === "cpp") {
    const match = line.match(/^\s*#include\s*["<]([^">]+)[">]/);
    return match ? [match[1]] : [];
  }
  return [];
}

function resolveInternalImport(fromPath: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const raw = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const withoutRuntimeExtension = raw.replace(/\.(js|mjs|cjs)$/, "");
  const candidates = [raw, withoutRuntimeExtension, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".swift", ".java", ".cs", ".c", ".cpp", ".h", ".hpp"].map((ext) => `${withoutRuntimeExtension}${ext}`), ...["index.ts", "index.tsx", "index.js", "index.py"].map((name) => `${withoutRuntimeExtension}/${name}`)];
  return candidates.find((candidate) => files.has(candidate));
}

export async function extractWorkspaceFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  inventoryFiles: InventoryFile[]
): Promise<{ files: ExtractedFile[]; analyzedFiles: number; scannedBytes: number; truncated: boolean; warnings: string[] }> {
  const fileSet = new Set(inventoryFiles.map((file) => file.path));
  const extracted: ExtractedFile[] = [];
  let scannedBytes = 0;
  let symbolCount = 0;
  let sourceBudgetReached = false;
  let symbolBudgetReached = false;
  let skippedFiles = 0;
  for (const file of inventoryFiles) {
    if (!SOURCE_LANGUAGES.has(file.language) || file.generated) continue;
    if (extracted.length >= config.analysisLimits.maxAnalyzedFiles || scannedBytes + file.bytes > config.analysisLimits.maxScannedBytes) {
      sourceBudgetReached = true;
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
      sourceBudgetReached = true;
      break;
    }
    scannedBytes += actualBytes;
    const symbols: AnalysisSymbol[] = [];
    const imports: string[] = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const pattern of DECLARATIONS[file.language] ?? []) {
        const match = line.match(pattern.regex);
        if (!match?.[1]) continue;
        if (symbolCount >= config.analysisLimits.maxSymbols) {
          symbolBudgetReached = true;
          continue;
        }
        symbols.push({ name: match[1], kind: pattern.kind, path: file.path, line: index + 1, exported: /\b(export|public|pub)\b/.test(line), confidence: "strong" });
        symbolCount += 1;
      }
      for (const specifier of importSpecifiers(file.language, line)) {
        const target = resolveInternalImport(file.path, specifier, fileSet);
        if (target && !imports.includes(target)) imports.push(target);
      }
    }
    extracted.push({ path: file.path, text, symbols, imports });
  }
  const warnings = [
    ...(sourceBudgetReached ? ["Source analysis reached its file or byte limit."] : []),
    ...(symbolBudgetReached ? ["Symbol extraction reached its configured limit."] : []),
    ...(skippedFiles ? [`Skipped ${skippedFiles} source file${skippedFiles === 1 ? "" : "s"} that changed or became unreadable during analysis.`] : [])
  ];
  return {
    files: extracted,
    analyzedFiles: extracted.length,
    scannedBytes,
    truncated: sourceBudgetReached || symbolBudgetReached || skippedFiles > 0,
    warnings
  };
}
