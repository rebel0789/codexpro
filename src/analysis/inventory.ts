import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import { listFiles, textScanByteLimit } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { classifyFileRole, classifyLanguage, isEntrypoint, isGeneratedFile } from "./classify.js";
import type { InventoryFile, InventoryResult } from "./types.js";

export async function inventoryWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<InventoryResult> {
  const maxFiles = config.analysisLimits.maxInventoryFiles;
  const candidates = await listFiles(guard, workspace, { root: ".", includeHidden: true, maxFiles: maxFiles + 1 });
  const truncated = candidates.length > maxFiles;
  const files: InventoryFile[] = [];

  for (const candidate of candidates.slice(0, maxFiles)) {
    try {
      const resolved = guard.resolve(workspace, candidate);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) continue;
      await guard.assertTextFile(resolved.absPath, textScanByteLimit(config));
      const language = classifyLanguage(resolved.relPath);
      files.push({
        path: resolved.relPath,
        bytes: stat.size,
        modifiedMs: stat.mtimeMs,
        language,
        role: classifyFileRole(resolved.relPath, language),
        generated: isGeneratedFile(resolved.relPath),
        entrypoint: isEntrypoint(resolved.relPath)
      });
    } catch {
      // Blocked, escaping, unreadable, binary, and oversized files are absent by design.
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.bytes}:${file.modifiedMs}`).join("\n"))
    .digest("hex");
  const warnings = truncated ? [`Inventory truncated at ${maxFiles} files.`] : [];
  return {
    files,
    fingerprint,
    coverage: {
      inventoryFiles: files.length,
      analyzedFiles: 0,
      scannedBytes: 0,
      symbolCount: 0,
      relationshipCount: 0,
      truncated,
      warnings
    }
  };
}
