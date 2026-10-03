export type CodexProTelemetryKind = "request" | "tool" | "session";

export type CodexProTelemetryEvent = {
  seq: number;
  ts: string;
  kind: CodexProTelemetryKind;
  event: string;
  requestId?: string;
  mcpSessionId?: string;
  clientSessionFingerprint?: string;
  jsonRpcId?: string | number | null;
  jsonRpcMethod?: string;
  requestedTool?: string;
  tool?: string;
  callId?: number;
  state?: string;
  status?: string;
  durationMs?: number;
  elapsedMs?: number;
  activeRequests?: number;
  idleForMs?: number;
  requestActiveForAtLeastMs?: number;
  transportCount?: number;
  args?: unknown;
  result?: unknown;
  httpMethod?: string;
  path?: string;
  statusCode?: number;
};

const configuredCapacity = Number(process.env.CODEXPRO_TELEMETRY_CAPACITY ?? 4_000);
const capacity = Number.isFinite(configuredCapacity)
  ? Math.max(200, Math.min(20_000, Math.floor(configuredCapacity)))
  : 4_000;

const events: CodexProTelemetryEvent[] = [];
let nextSeq = 1;

export function recordTelemetry(event: Omit<CodexProTelemetryEvent, "seq">): CodexProTelemetryEvent {
  const stored: CodexProTelemetryEvent = {
    ...event,
    seq: nextSeq++
  };
  events.push(stored);
  if (events.length > capacity) {
    events.splice(0, events.length - capacity);
  }
  return stored;
}

export function telemetrySnapshot(options: {
  sinceSeq?: number;
  limit?: number;
  clientSessionFingerprint?: string;
} = {}): {
  capacity: number;
  retained: number;
  firstSeq: number | null;
  latestSeq: number;
  events: CodexProTelemetryEvent[];
} {
  const sinceSeq = Number.isFinite(options.sinceSeq) ? Math.max(0, Math.floor(options.sinceSeq!)) : 0;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(2_000, Math.floor(options.limit!))) : 200;
  const fingerprint = options.clientSessionFingerprint?.trim();

  const filtered = events.filter((event) => {
    if (event.seq <= sinceSeq) return false;
    if (fingerprint && event.clientSessionFingerprint !== fingerprint) return false;
    return true;
  });
  const selected = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;

  return {
    capacity,
    retained: events.length,
    firstSeq: events.length ? events[0].seq : null,
    latestSeq: nextSeq - 1,
    events: selected
  };
}

export function resetTelemetryForTest(): void {
  events.splice(0, events.length);
  nextSeq = 1;
}
