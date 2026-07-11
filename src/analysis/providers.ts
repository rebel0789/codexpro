import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import type { AnalysisProvider } from "./types.js";

const providers = new Map<string, AnalysisProvider>();

export function registerAnalysisProvider(provider: AnalysisProvider): void {
  if (!provider.id.trim()) throw new Error("Analysis provider id is required.");
  providers.set(provider.id, provider);
}

export function listAnalysisProviders(): AnalysisProvider[] {
  return [...providers.values()];
}

export function normalizeProviderPaths(guard: PathGuard, workspace: Workspace, paths: string[]): { paths: string[]; warnings: string[] } {
  const valid: string[] = [];
  const warnings: string[] = [];
  for (const candidate of paths) {
    try {
      valid.push(guard.resolve(workspace, candidate).relPath);
    } catch (error) {
      warnings.push(redactSensitiveText(`Provider path rejected: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  return { paths: [...new Set(valid)], warnings };
}
