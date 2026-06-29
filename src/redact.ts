const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const COMMON_TOKEN_PATTERN = /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g;
const BEARER_TOKEN_PATTERN = /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const QUERY_TOKEN_PATTERN = /([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'`<>]{8,}/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}\s*=\s*(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_FIELD_PATTERN = /(["']?[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}["']?\s*:\s*)(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_PATTERNS = [OPENAI_SECRET_PATTERN, COMMON_TOKEN_PATTERN, BEARER_TOKEN_PATTERN, QUERY_TOKEN_PATTERN, SECRET_ASSIGNMENT_PATTERN, SECRET_FIELD_PATTERN];

export function hasSecretValue(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (!isPlaceholderSecret(match[0])) return true;
    }
  }
  return false;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT_PATTERN, (match) => isPlaceholderSecret(match) ? match : redactSecretAssignment(match))
    .replace(SECRET_FIELD_PATTERN, (match, prefix) => isPlaceholderSecret(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(BEARER_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(QUERY_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(OPENAI_SECRET_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]")
    .replace(COMMON_TOKEN_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
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
    normalized.includes("process.env.") ||
    normalized.includes("import.meta.env.") ||
    normalized.includes("os.environ") ||
    normalized.includes("getenv(") ||
    normalized === "sk-..." ||
    normalized.endsWith("=sk-...")
  );
}

function redactSecretAssignment(value: string): string {
  const index = value.indexOf("=");
  if (index < 0) return "[REDACTED_SECRET]";
  return `${value.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
}
