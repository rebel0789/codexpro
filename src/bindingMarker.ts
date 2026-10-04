import { createHash } from "node:crypto";

export const CODEXPRO_BINDING_MARKER_PREFIX = "cpb1_";
const BINDING_MARKER_DOMAIN = "codexpro-binding-v1:";

export function normalizeBindingFingerprint(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{12,128}$/.test(normalized)) return undefined;
  return normalized.slice(0, 12);
}

export function bindingMarkerForFingerprint(value: unknown): string | undefined {
  const fingerprint = normalizeBindingFingerprint(value);
  if (!fingerprint) return undefined;
  const digest = createHash("sha256")
    .update(BINDING_MARKER_DOMAIN, "utf8")
    .update(fingerprint, "utf8")
    .digest("hex")
    .slice(0, 24);
  return CODEXPRO_BINDING_MARKER_PREFIX + digest;
}

export function bindingMarkerFromCorrelation(snapshot: Record<string, unknown> | undefined): string | undefined {
  const clientCorrelation = snapshot?.clientCorrelation;
  if (!clientCorrelation || typeof clientCorrelation !== "object" || Array.isArray(clientCorrelation)) return undefined;
  const fingerprint = (clientCorrelation as Record<string, unknown>)["x-openai-session-fingerprint"];
  return bindingMarkerForFingerprint(fingerprint);
}
