import { createHash } from "node:crypto";
import { canonicalRoot } from "./chrome2ApiContract.js";
import {
  CHROME_DOCUMENT_LIMITS,
  type ChromeDocumentSummaryInput,
  summarizeDocumentWithChrome2Api
} from "./chromeDocumentSummarizer.js";
import { CodexProError } from "./guard.js";

export const CHROME_CORPUS_LIMITS = Object.freeze({
  maxDocuments: 64,
  maxTotalBytes: 8_000_000,
  maxDocumentIdBytes: 1_024
});

export interface ChromeCorpusDocument {
  documentId: string;
  text: string;
}

export interface ChromeCorpusSummaryInput extends Omit<ChromeDocumentSummaryInput, "text" | "documentId"> {
  documents: readonly ChromeCorpusDocument[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function summarizeCorpusWithChrome2Api(
  input: ChromeCorpusSummaryInput,
  env: NodeJS.ProcessEnv = process.env
) {
  if (!Array.isArray(input.documents) || input.documents.length === 0) {
    throw new CodexProError("Chrome corpus summarizer requires at least one document.");
  }
  if (input.documents.length > CHROME_CORPUS_LIMITS.maxDocuments) {
    throw new CodexProError(`Chrome corpus exceeds ${CHROME_CORPUS_LIMITS.maxDocuments} documents.`);
  }

  const seenIds = new Set<string>();
  let totalBytes = 0;
  const documents = input.documents.map((document) => {
    const documentId = String(document.documentId);
    if (!documentId.trim() || Buffer.byteLength(documentId, "utf8") > CHROME_CORPUS_LIMITS.maxDocumentIdBytes) {
      throw new CodexProError("Chrome corpus document ids must be non-empty and at most 1024 UTF-8 bytes.");
    }
    if (seenIds.has(documentId)) throw new CodexProError(`Chrome corpus contains duplicate document id: ${documentId}`);
    seenIds.add(documentId);
    if (typeof document.text !== "string" || !document.text.trim()) {
      throw new CodexProError(`Chrome corpus document must be non-empty UTF-8 text: ${documentId}`);
    }
    const bytes = Buffer.byteLength(document.text, "utf8");
    if (bytes > CHROME_DOCUMENT_LIMITS.maxDocumentBytes) {
      throw new CodexProError(`Chrome corpus document exceeds ${CHROME_DOCUMENT_LIMITS.maxDocumentBytes} UTF-8 bytes: ${documentId}`);
    }
    totalBytes += bytes;
    if (totalBytes > CHROME_CORPUS_LIMITS.maxTotalBytes) {
      throw new CodexProError(`Chrome corpus exceeds ${CHROME_CORPUS_LIMITS.maxTotalBytes} total UTF-8 bytes.`);
    }
    return { documentId, text: document.text, bytes, sha256: sha256(document.text) };
  }).sort((left, right) => compareText(left.documentId, right.documentId));

  const groups = new Map<string, { text: string; documents: typeof documents }>();
  for (const document of documents) {
    const group = groups.get(document.sha256);
    if (group) {
      if (group.text !== document.text) throw new CodexProError("Chrome corpus content hash collision detected.");
      group.documents.push(document);
    } else {
      groups.set(document.sha256, { text: document.text, documents: [document] });
    }
  }

  const contentSummaries = [];
  const { documents: _documents, ...summaryOptions } = input;
  for (const [contentSha256, group] of [...groups.entries()].sort(([left], [right]) => compareText(left, right))) {
    const receipt = await summarizeDocumentWithChrome2Api({
      ...summaryOptions,
      text: group.text,
      documentId: `content:${contentSha256}`
    }, env);
    contentSummaries.push({
      content_sha256: contentSha256,
      document_ids: group.documents.map((document) => document.documentId),
      receipt
    });
  }

  const summariesByHash = new Map(contentSummaries.map((summary) => [summary.content_sha256, summary]));
  const aliases = documents.map((document) => {
    const summary = summariesByHash.get(document.sha256)!;
    const sourceRoot = canonicalRoot("codexpro.chrome-document.source.v1", [document.documentId, document.sha256]);
    return {
      document_id: document.documentId,
      document_bytes: document.bytes,
      content_sha256: document.sha256,
      source_root: sourceRoot,
      summary_receipt_root: summary.receipt.receipt_root,
      alias_receipt_root: canonicalRoot("codexpro.chrome-corpus.alias.v1", [
        document.documentId,
        document.sha256,
        sourceRoot,
        summary.receipt.receipt_root
      ])
    };
  });
  const corpusRoot = canonicalRoot("codexpro.chrome-document-corpus.v2", aliases.flatMap((alias) => [
    alias.document_id,
    String(alias.document_bytes),
    alias.content_sha256,
    alias.source_root,
    alias.alias_receipt_root
  ]));
  const executionRoot = canonicalRoot("codexpro.chrome-corpus.execution.v1", contentSummaries.flatMap((summary) => [
    summary.content_sha256,
    summary.receipt.receipt_root
  ]));
  const providerCalls = contentSummaries.reduce((total, summary) => total + summary.receipt.cache.provider_calls, 0);
  const requests = contentSummaries.reduce((total, summary) => total + summary.receipt.cache.requests, 0);
  return {
    schema: "codexpro.chrome-corpus-summary.receipt.v1",
    backend: "chrome2api-summarizer-compat",
    native_browser_api: false,
    authority_ceiling: "CANDIDATE_ONLY",
    document_count: documents.length,
    unique_content_count: contentSummaries.length,
    total_bytes: totalBytes,
    corpus_root: corpusRoot,
    aliases,
    content_summaries: contentSummaries,
    cache: {
      scope: "process-local",
      requests,
      provider_calls: providerCalls,
      reused_requests: requests - providerCalls
    },
    execution_root: executionRoot,
    receipt_root: canonicalRoot("codexpro.chrome-corpus-summary.receipt.v1", [corpusRoot, executionRoot])
  } as const;
}
