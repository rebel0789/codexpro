const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]+|[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]*\s*=\s*[^\s]+)/gi;

export function hasSecretValue(text: string): boolean {
  SECRET_VALUE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECRET_VALUE_PATTERN.exec(text)) !== null) {
    if (!isPlaceholderSecret(match[0])) return true;
  }
  return false;
}

export function redactSensitiveText(text: string): string {
  SECRET_VALUE_PATTERN.lastIndex = 0;
  return text.replace(SECRET_VALUE_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
}

export function redactStructured<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactStructured(item, depth + 1);
  }
  return out as T;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("[redacted_secret]") ||
    normalized.includes("replace-me") ||
    normalized.includes("your-api-key-here") ||
    normalized.includes("<openai_api_key>") ||
    normalized === "sk-..." ||
    normalized.endsWith("=sk-...")
  );
}
