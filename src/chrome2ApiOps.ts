import { performance } from "node:perf_hooks";
import {
  canonicalRoot,
  CHROME2API_LIMITS,
  CHROME2API_MODEL,
  chrome2ApiContract,
  resolveChrome2ApiUrl
} from "./chrome2ApiContract.js";
import { CodexProError } from "./guard.js";

type JsonRecord = Record<string, unknown>;

export interface Chrome2ApiCompletionInput {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

function asRecord(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodexProError(message);
  return value as JsonRecord;
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < CHROME2API_LIMITS.minTimeoutMs || timeout > CHROME2API_LIMITS.maxTimeoutMs) {
    throw new CodexProError(`Chrome2api timeout must be ${CHROME2API_LIMITS.minTimeoutMs}-${CHROME2API_LIMITS.maxTimeoutMs} ms.`);
  }
  return timeout;
}

function validateCompletion(input: Chrome2ApiCompletionInput) {
  if (typeof input.prompt !== "string" || (input.system !== undefined && typeof input.system !== "string")) {
    throw new CodexProError("Chrome2api accepts text prompt and system fields only.");
  }
  const promptBytes = Buffer.byteLength(input.prompt, "utf8");
  const system = input.system ?? "";
  const systemBytes = Buffer.byteLength(system, "utf8");
  if (!input.prompt.trim() || promptBytes > CHROME2API_LIMITS.maxPromptBytes) {
    throw new CodexProError(`Chrome2api prompt must be non-empty and at most ${CHROME2API_LIMITS.maxPromptBytes} UTF-8 bytes.`);
  }
  if (systemBytes > CHROME2API_LIMITS.maxSystemBytes || promptBytes + systemBytes > CHROME2API_LIMITS.maxInputBytes) {
    throw new CodexProError("Chrome2api system/prompt input exceeds its bounded text contract.");
  }
  const maxTokens = input.maxTokens ?? 256;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > CHROME2API_LIMITS.maxTokens) {
    throw new CodexProError(`Chrome2api max_tokens must be 1-${CHROME2API_LIMITS.maxTokens}.`);
  }
  const temperature = input.temperature ?? 0.2;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new CodexProError("Chrome2api temperature must be between 0 and 2.");
  }
  return { system, maxTokens, temperature, timeoutMs: boundedTimeout(input.timeoutMs) };
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CHROME2API_LIMITS.maxOutputBytes) {
        await reader.cancel();
        throw new CodexProError("Chrome2api response exceeded its byte boundary.");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

async function requestJson(url: URL, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > CHROME2API_LIMITS.maxOutputBytes) {
      throw new CodexProError("Chrome2api response exceeded its declared byte boundary.");
    }
    const bytes = await readBoundedBody(response);
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new CodexProError("Chrome2api returned non-JSON output.");
    }
    if (!response.ok) {
      const error = asRecord(body, "Chrome2api request failed.");
      const nested = error.error && typeof error.error === "object" ? error.error as JsonRecord : undefined;
      const detail = typeof nested?.message === "string" ? nested.message.slice(0, 500) : `HTTP ${response.status}`;
      throw new CodexProError(`Chrome2api rejected the request: ${detail}`);
    }
    return body;
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    if (controller.signal.aborted) throw new CodexProError(`Chrome2api timed out after ${timeoutMs} ms.`);
    throw new CodexProError(`Chrome2api loopback request failed: ${error instanceof Error ? error.message : "unknown error"}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function chrome2ApiStatus(timeoutMs = 5_000, env: NodeJS.ProcessEnv = process.env) {
  const started = performance.now();
  const contract = chrome2ApiContract(env);
  try {
    const base = resolveChrome2ApiUrl(env);
    const body = asRecord(await requestJson(new URL("models", base), { method: "GET" }, boundedTimeout(timeoutMs)), "Chrome2api returned an invalid model list.");
    const data = Array.isArray(body.data) ? body.data : [];
    const models = data
      .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string");
    const ready = models.includes(CHROME2API_MODEL);
    return {
      schema: "codexpro.chrome2api.status.v1",
      state: ready ? "ready" : "model-missing",
      ready,
      required_model: CHROME2API_MODEL,
      advertised_models: models.slice(0, 32),
      latency_ms: Math.round(performance.now() - started),
      error: null,
      contract
    };
  } catch (error) {
    return {
      schema: "codexpro.chrome2api.status.v1",
      state: contract.endpoint.configuration_valid ? "unavailable" : "invalid-configuration",
      ready: false,
      required_model: CHROME2API_MODEL,
      advertised_models: [] as string[],
      latency_ms: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : "Chrome2api status failed.",
      contract
    };
  }
}

export async function completeWithChrome2Api(input: Chrome2ApiCompletionInput, env: NodeJS.ProcessEnv = process.env) {
  const admitted = validateCompletion(input);
  const base = resolveChrome2ApiUrl(env);
  const messages = [
    ...(admitted.system ? [{ role: "system", content: admitted.system }] : []),
    { role: "user", content: input.prompt }
  ];
  const request = {
    model: CHROME2API_MODEL,
    messages,
    max_tokens: admitted.maxTokens,
    temperature: admitted.temperature,
    n: 1,
    stream: false
  };
  const body = asRecord(await requestJson(
    new URL("chat/completions", base),
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) },
    admitted.timeoutMs
  ), "Chrome2api returned an invalid completion object.");
  if (body.model !== CHROME2API_MODEL) {
    throw new CodexProError("Chrome2api completion returned an unexpected model identity.");
  }
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0] && typeof choices[0] === "object" && !Array.isArray(choices[0]) ? choices[0] as JsonRecord : null;
  const message = first?.message && typeof first.message === "object" && !Array.isArray(first.message) ? first.message as JsonRecord : null;
  const content = message?.content;
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > CHROME2API_LIMITS.maxOutputBytes) {
    throw new CodexProError("Chrome2api completion failed content validation.");
  }
  const endpoint = base.toString().replace(/\/$/, "");
  const requestRoot = canonicalRoot("codexpro.chrome2api.request.v1", [
    endpoint,
    CHROME2API_MODEL,
    admitted.system,
    input.prompt,
    String(admitted.maxTokens),
    String(admitted.temperature)
  ]);
  const responseRoot = canonicalRoot("codexpro.chrome2api.response.v1", [content]);
  const finishReason = typeof first?.finish_reason === "string" && first.finish_reason.length <= 64 ? first.finish_reason : "unknown";
  return {
    schema: "codexpro.chrome2api.receipt.v1",
    provider: "chrome2api-loopback",
    endpoint,
    model: CHROME2API_MODEL,
    content,
    finish_reason: finishReason,
    request_root: requestRoot,
    response_root: responseRoot,
    receipt_root: canonicalRoot("codexpro.chrome2api.receipt.v1", [requestRoot, responseRoot, CHROME2API_MODEL, finishReason])
  };
}
