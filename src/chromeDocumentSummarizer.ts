import { createHash } from "node:crypto";
import { canonicalRoot } from "./chrome2ApiContract.js";
import {
  CHROME_SUMMARY_LIMITS,
  type ChromeSummaryInput,
  normalizeChromeSummary
} from "./chromeSummarizerContract.js";
import { summarizeWithChrome2Api } from "./chromeSummarizerOps.js";
import { CodexProError } from "./guard.js";

export const CHROME_DOCUMENT_LIMITS = Object.freeze({
  maxDocumentBytes: 2_000_000,
  maxChunkBytes: 48_000,
  minChunkBytes: 4_096,
  maxChunks: 64,
  maxReductionDepth: 6
});

export interface ChromeDocumentSummaryInput extends Omit<ChromeSummaryInput, "text"> {
  text: string;
  documentId?: string;
  chunkBytes?: number;
}

export interface SourceChunk {
  id: string;
  startByte: number;
  endByte: number;
  bytes: number;
  sha256: string;
  text: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8Boundary(buffer: Buffer, proposed: number, start: number): number {
  let position = proposed;
  while (position > start && position < buffer.length && (buffer[position] & 0xc0) === 0x80) position -= 1;
  return position > start ? position : proposed;
}

function lastBoundary(buffer: Buffer, start: number, limit: number, minimum: number): number {
  const candidates = ["\n\n", "\n", ". ", "! ", "? ", "; "];
  for (const marker of candidates) {
    const found = buffer.lastIndexOf(marker, limit - Buffer.byteLength(marker, "utf8"), "utf8");
    if (found >= minimum && found >= start) return found + Buffer.byteLength(marker, "utf8");
  }
  return utf8Boundary(buffer, limit, start);
}

export function splitUtf8Document(text: string, requestedChunkBytes: number = CHROME_DOCUMENT_LIMITS.maxChunkBytes): SourceChunk[] {
  if (typeof text !== "string" || !text.trim()) throw new CodexProError("Chrome document summarizer text must be non-empty UTF-8 text.");
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength > CHROME_DOCUMENT_LIMITS.maxDocumentBytes) {
    throw new CodexProError(`Chrome document exceeds ${CHROME_DOCUMENT_LIMITS.maxDocumentBytes} UTF-8 bytes.`);
  }
  if (!Number.isInteger(requestedChunkBytes) || requestedChunkBytes < CHROME_DOCUMENT_LIMITS.minChunkBytes || requestedChunkBytes > CHROME_DOCUMENT_LIMITS.maxChunkBytes) {
    throw new CodexProError(`Chrome document chunk_bytes must be ${CHROME_DOCUMENT_LIMITS.minChunkBytes}-${CHROME_DOCUMENT_LIMITS.maxChunkBytes}.`);
  }

  const chunks: SourceChunk[] = [];
  let start = 0;
  while (start < buffer.length) {
    const hardEnd = Math.min(buffer.length, start + requestedChunkBytes);
    const minimum = start + Math.floor(requestedChunkBytes * 0.6);
    let end = hardEnd === buffer.length ? hardEnd : lastBoundary(buffer, start, hardEnd, minimum);
    if (end <= start) end = utf8Boundary(buffer, hardEnd, start);
    const bytes = buffer.subarray(start, end);
    chunks.push({
      id: `chunk-${String(chunks.length + 1).padStart(4, "0")}`,
      startByte: start,
      endByte: end,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      text: bytes.toString("utf8")
    });
    if (chunks.length > CHROME_DOCUMENT_LIMITS.maxChunks) {
      throw new CodexProError(`Chrome document requires more than ${CHROME_DOCUMENT_LIMITS.maxChunks} source chunks.`);
    }
    start = end;
  }
  if (!Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.text, "utf8"))).equals(buffer)) {
    throw new CodexProError("Chrome document chunking failed exact UTF-8 reconstruction.");
  }
  return chunks;
}

type Candidate = { id: string; text: string; root: string };

function groupCandidates(candidates: Candidate[]): Candidate[][] {
  const groups: Candidate[][] = [];
  let current: Candidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const framedBytes = Buffer.byteLength(`[${candidate.id}]\n${candidate.text}\n`, "utf8");
    if (framedBytes > CHROME_DOCUMENT_LIMITS.maxChunkBytes) {
      throw new CodexProError("Chrome document intermediate summary exceeded the reduction boundary.");
    }
    if (current.length && bytes + framedBytes > CHROME_DOCUMENT_LIMITS.maxChunkBytes) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(candidate);
    bytes += framedBytes;
  }
  if (current.length) groups.push(current);
  return groups;
}

function candidateText(group: Candidate[]): string {
  return group.map((item) => `[${item.id}]\n${item.text}`).join("\n\n");
}

export async function summarizeDocumentWithChrome2Api(input: ChromeDocumentSummaryInput, env: NodeJS.ProcessEnv = process.env) {
  const documentId = String(input.documentId ?? "document").trim() || "document";
  if (Buffer.byteLength(documentId, "utf8") > 1_024) throw new CodexProError("Chrome document id exceeds 1024 UTF-8 bytes.");
  const chunks = splitUtf8Document(input.text, input.chunkBytes);
  const normalizedFinal = normalizeChromeSummary({ ...input, text: chunks[0].text });
  const sourceRoot = canonicalRoot("codexpro.chrome-document.source.v1", [documentId, sha256(Buffer.from(input.text, "utf8"))]);
  const mapReceipts: Awaited<ReturnType<typeof summarizeWithChrome2Api>>[] = [];
  const reductionReceipts: Awaited<ReturnType<typeof summarizeWithChrome2Api>>[] = [];
  const finalInput = (text: string): ChromeSummaryInput => ({
    text,
    type: normalizedFinal.type,
    format: normalizedFinal.format,
    length: normalizedFinal.length,
    preference: normalizedFinal.preference,
    sharedContext: normalizedFinal.sharedContext,
    context: normalizedFinal.context,
    expectedInputLanguages: normalizedFinal.expectedInputLanguages,
    outputLanguage: normalizedFinal.outputLanguage || undefined,
    expectedContextLanguages: normalizedFinal.expectedContextLanguages,
    timeoutMs: normalizedFinal.timeoutMs
  });
  const mapInput = (text: string): ChromeSummaryInput => ({
    ...finalInput(text),
    type: "tldr",
    format: "plain-text",
    length: "long"
  });

  let finalReceipt: Awaited<ReturnType<typeof summarizeWithChrome2Api>>;
  let depth = 0;
  if (chunks.length === 1) {
    finalReceipt = await summarizeWithChrome2Api(finalInput(chunks[0].text), env);
  } else {
    for (const chunk of chunks) {
      const receipt = await summarizeWithChrome2Api(mapInput(chunk.text), env);
      mapReceipts.push(receipt);
    }

    let candidates: Candidate[] = mapReceipts.map((receipt, index) => ({
      id: chunks[index].id,
      text: receipt.summary,
      root: receipt.summary_root
    }));
    while (Buffer.byteLength(candidateText(candidates), "utf8") > CHROME_DOCUMENT_LIMITS.maxChunkBytes) {
      if (depth >= CHROME_DOCUMENT_LIMITS.maxReductionDepth) throw new CodexProError("Chrome document reduction exceeded its bounded depth.");
      const next: Candidate[] = [];
      for (const [groupIndex, group] of groupCandidates(candidates).entries()) {
        const receipt = await summarizeWithChrome2Api(mapInput(candidateText(group)), env);
        reductionReceipts.push(receipt);
        next.push({ id: `level-${depth + 1}-group-${groupIndex + 1}`, text: receipt.summary, root: receipt.summary_root });
      }
      if (next.length >= candidates.length) throw new CodexProError("Chrome document reduction did not converge.");
      candidates = next;
      depth += 1;
    }
    finalReceipt = await summarizeWithChrome2Api(finalInput(candidateText(candidates)), env);
  }
  const chunkManifestRoot = canonicalRoot("codexpro.chrome-document.chunks.v1", chunks.flatMap((chunk) => [
    chunk.id,
    String(chunk.startByte),
    String(chunk.endByte),
    chunk.sha256
  ]));
  const executionRoot = canonicalRoot("codexpro.chrome-document.execution.v1", [
    ...mapReceipts.map((receipt) => receipt.receipt_root),
    ...reductionReceipts.map((receipt) => receipt.receipt_root),
    finalReceipt.receipt_root
  ]);
  const requestReceipts = [...mapReceipts, ...reductionReceipts, finalReceipt];
  const providerCalls = requestReceipts.filter((receipt) => receipt.cache.disposition === "miss").length;
  const joinedRequests = requestReceipts.filter((receipt) => receipt.cache.disposition === "joined").length;
  return {
    schema: "codexpro.chrome-document-summary.receipt.v1",
    backend: "chrome2api-summarizer-compat",
    native_browser_api: false,
    authority_ceiling: "CANDIDATE_ONLY",
    document_id: documentId,
    document_bytes: Buffer.byteLength(input.text, "utf8"),
    source_root: sourceRoot,
    chunk_manifest_root: chunkManifestRoot,
    source_chunks: chunks.map(({ text: _text, ...chunk }) => chunk),
    map_receipt_roots: mapReceipts.map((receipt) => receipt.receipt_root),
    reduction_receipt_roots: reductionReceipts.map((receipt) => receipt.receipt_root),
    reduction_depth: depth,
    final: finalReceipt,
    cache: {
      scope: "process-local",
      requests: requestReceipts.length,
      provider_calls: providerCalls,
      reused_requests: requestReceipts.length - providerCalls,
      joined_requests: joinedRequests,
      all_stored: requestReceipts.every((receipt) => receipt.cache.stored)
    },
    execution_root: executionRoot,
    receipt_root: canonicalRoot("codexpro.chrome-document-summary.receipt.v1", [
      sourceRoot,
      chunkManifestRoot,
      executionRoot,
      finalReceipt.summary_root
    ])
  } as const;
}
