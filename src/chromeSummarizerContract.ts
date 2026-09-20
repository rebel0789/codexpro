import { CodexProError } from "./guard.js";

export const SUMMARY_TYPES = ["key-points", "tldr", "teaser", "headline"] as const;
export const SUMMARY_FORMATS = ["markdown", "plain-text"] as const;
export const SUMMARY_LENGTHS = ["short", "medium", "long"] as const;
export const SUMMARY_PREFERENCES = ["auto", "speed", "capability"] as const;
export const SUMMARY_LANGUAGES = ["en", "ja", "es", "de", "fr"] as const;

export type SummaryType = typeof SUMMARY_TYPES[number];
export type SummaryFormat = typeof SUMMARY_FORMATS[number];
export type SummaryLength = typeof SUMMARY_LENGTHS[number];
export type SummaryPreference = typeof SUMMARY_PREFERENCES[number];

export interface ChromeSummaryInput {
  text: string;
  type?: SummaryType;
  format?: SummaryFormat;
  length?: SummaryLength;
  preference?: SummaryPreference;
  sharedContext?: string;
  context?: string;
  expectedInputLanguages?: string[];
  outputLanguage?: string;
  expectedContextLanguages?: string[];
  timeoutMs?: number;
}

export const CHROME_SUMMARY_LIMITS = Object.freeze({
  maxTextBytes: 60_000,
  maxSharedContextBytes: 4_096,
  maxRequestContextBytes: 4_096,
  maxLanguagesPerField: 5
});

export const CHROME_SUMMARY_CACHE_LIMITS = Object.freeze({
  maxEntries: 128,
  maxBytes: 8_000_000
});

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new CodexProError(`Chrome summarizer ${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function boundedText(value: unknown, maxBytes: number, field: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new CodexProError(`Chrome summarizer ${field} must be text of at most ${maxBytes} UTF-8 bytes.`);
  }
  return value.trim();
}

function languages(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CHROME_SUMMARY_LIMITS.maxLanguagesPerField) {
    throw new CodexProError(`Chrome summarizer ${field} must contain at most five language codes.`);
  }
  const normalized = value.map((item) => String(item).toLowerCase());
  if (normalized.some((item) => !SUMMARY_LANGUAGES.includes(item as typeof SUMMARY_LANGUAGES[number]))) {
    throw new CodexProError(`Chrome summarizer languages are currently limited to: ${SUMMARY_LANGUAGES.join(", ")}.`);
  }
  return [...new Set(normalized)].sort();
}

export function normalizeChromeSummary(input: ChromeSummaryInput) {
  if (typeof input.text !== "string" || !input.text.trim()) {
    throw new CodexProError("Chrome summarizer text must be non-empty.");
  }
  if (Buffer.byteLength(input.text, "utf8") > CHROME_SUMMARY_LIMITS.maxTextBytes) {
    throw new CodexProError(`Chrome summarizer text exceeds ${CHROME_SUMMARY_LIMITS.maxTextBytes} UTF-8 bytes.`);
  }
  const outputLanguage = input.outputLanguage === undefined ? "" : String(input.outputLanguage).toLowerCase();
  if (outputLanguage && !SUMMARY_LANGUAGES.includes(outputLanguage as typeof SUMMARY_LANGUAGES[number])) {
    throw new CodexProError(`Chrome summarizer outputLanguage must be one of: ${SUMMARY_LANGUAGES.join(", ")}.`);
  }
  return {
    text: input.text,
    type: oneOf(input.type, SUMMARY_TYPES, "key-points", "type"),
    format: oneOf(input.format, SUMMARY_FORMATS, "markdown", "format"),
    length: oneOf(input.length, SUMMARY_LENGTHS, "short", "length"),
    preference: oneOf(input.preference, SUMMARY_PREFERENCES, "auto", "preference"),
    sharedContext: boundedText(input.sharedContext, CHROME_SUMMARY_LIMITS.maxSharedContextBytes, "sharedContext"),
    context: boundedText(input.context, CHROME_SUMMARY_LIMITS.maxRequestContextBytes, "context"),
    expectedInputLanguages: languages(input.expectedInputLanguages, "expectedInputLanguages"),
    outputLanguage,
    expectedContextLanguages: languages(input.expectedContextLanguages, "expectedContextLanguages"),
    timeoutMs: input.timeoutMs
  } as const;
}

export function chromeSummarizerContract() {
  return {
    schema: "codexpro.chrome-summarizer.contract.v1",
    native_reference: "https://developer.chrome.com/docs/ai/summarizer-api",
    backend: "chrome2api-summarizer-compat",
    native_browser_api: false,
    compatibility_notes: {
      language_hints_are_advisory: true,
      preference_is_advisory: true,
      generated_output_is_untrusted: true,
      authority_ceiling: "CANDIDATE_ONLY"
    },
    options: {
      type: SUMMARY_TYPES,
      format: SUMMARY_FORMATS,
      length: SUMMARY_LENGTHS,
      preference: SUMMARY_PREFERENCES,
      languages: SUMMARY_LANGUAGES,
      shared_context: true,
      request_context: true
    },
    lifecycle: {
      native_availability_states: ["unavailable", "downloadable", "downloading", "available"],
      native_user_activation_may_be_required_for_download: true,
      native_downloadprogress_monitor: true,
      native_batch: true,
      native_streaming: true,
      compatibility_backend_batch_only: true
    },
    large_documents: {
      action: "chrome_summarize_document",
      corpus_action: "chrome_summarize_corpus",
      method: "deterministic UTF-8 chunks -> TLDR/long map -> bounded reduction -> requested final mode",
      corpus_method: "bounded top-level glob -> exact byte hashes -> unique-content summaries -> per-path aliases",
      canonical_identity_uses_source_bytes_not_provider_quota: true,
      source_chunks_are_exactly_reconstructable: true,
      max_document_bytes: 2_000_000,
      max_chunk_bytes: 48_000,
      max_chunks: 64,
      max_reduction_depth: 6
    },
    cache: {
      scope: "process-local",
      identity: "endpoint + source root + normalized options root",
      concurrent_identical_requests_joined: true,
      failures_cached: false,
      ...CHROME_SUMMARY_CACHE_LIMITS
    },
    limits: CHROME_SUMMARY_LIMITS
  } as const;
}
