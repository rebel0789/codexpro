import { createHash } from "node:crypto";
import { CodexProError } from "./guard.js";

export const CHROME2API_MODEL = "chrome-gemini-nano";
export const CHROME2API_DEFAULT_URL = "http://127.0.0.1:11435/v1";
export const CHROME2API_LIMITS = Object.freeze({
  maxPromptBytes: 65_536,
  maxSystemBytes: 16_384,
  maxInputBytes: 81_920,
  maxOutputBytes: 262_144,
  maxTokens: 2_048,
  minTimeoutMs: 2_000,
  maxTimeoutMs: 120_000
});

export function canonicalRoot(schema: string, fields: readonly string[]): string {
  const framed = [schema, ...fields]
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}\n`)
    .join("");
  return createHash("sha256").update(framed, "utf8").digest("hex");
}

export function resolveChrome2ApiUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.CODEXPRO_CHROME2API_URL?.trim() || CHROME2API_DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CodexProError("CODEXPRO_CHROME2API_URL must be a valid loopback HTTP URL ending in /v1.");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || (host !== "127.0.0.1" && host !== "[::1]") || parsed.username || parsed.password) {
    throw new CodexProError("Chrome2api is restricted to an unauthenticated literal loopback HTTP endpoint.");
  }
  if ((parsed.pathname !== "/v1" && parsed.pathname !== "/v1/") || parsed.search || parsed.hash) {
    throw new CodexProError("CODEXPRO_CHROME2API_URL must end at the /v1 API root without query or fragment data.");
  }
  parsed.pathname = "/v1/";
  return parsed;
}

export function chrome2ApiContract(env: NodeJS.ProcessEnv = process.env) {
  let baseUrl: string | null = null;
  let configurationValid = true;
  let configurationError: string | null = null;
  try {
    baseUrl = resolveChrome2ApiUrl(env).toString().replace(/\/$/, "");
  } catch (error) {
    configurationValid = false;
    configurationError = error instanceof Error ? error.message : "Invalid Chrome2api configuration.";
  }
  return {
    schema: "codexpro.chrome2api.contract.v1",
    donor: {
      repository: "xszwow/Chrome2api",
      commit: "406c5c7a33a6c364c0bd42892250ad1b6a103dad",
      integration: "loopback-http-wrap"
    },
    endpoint: { base_url: baseUrl, configuration_valid: configurationValid, configuration_error: configurationError },
    model: CHROME2API_MODEL,
    operations: ["status", "text-completion"],
    boundaries: {
      loopback_literal_only: true,
      endpoint_from_model: false,
      authorization_forwarded: false,
      cookies_or_browser_profile_forwarded: false,
      local_file_or_media_inputs: false,
      redirects_allowed: false,
      streaming: false,
      proprietary_assets_bundled: false
    },
    limits: CHROME2API_LIMITS,
    proof: {
      request_root: "sha256-framed-canonical-fields",
      response_root: "sha256-utf8-content",
      receipt_root: "sha256-framed-request-and-response-roots"
    }
  } as const;
}
