const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const COMMON_TOKEN_PATTERN = /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g;
const BEARER_TOKEN_PATTERN = /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const CLI_TOKEN_PATTERN = /((?:\bngrok\s+config\s+add-authtoken|\bcloudflared\s+service\s+install|--(?:token|access-token|auth-token|api[_-]?key|authtoken))(?:=|\s+))[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_TOKEN_PATTERN = /([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'`<>]{8,}/gi;
const CODEXPRO_TOKEN_ASSIGNMENT_PATTERN = /\b(codexpro_token\s*=\s*)(?:"[^"\r\n]{8,512}"|'[^'\r\n]{8,512}'|`[^`\r\n]{8,512}`|[A-Za-z0-9_./+=-]{8,512})/gi;
const CODEXPRO_TOKEN_FIELD_PATTERN = /(["']?codexpro_token["']?\s*:\s*)(?:"[^"\r\n]{8,512}"|'[^'\r\n]{8,512}'|`[^`\r\n]{8,512}`|[A-Za-z0-9_./+=-]{8,512})/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}\s*=\s*(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_FIELD_PATTERN = /(["']?[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}["']?\s*:\s*)(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_PATTERNS = [OPENAI_SECRET_PATTERN, COMMON_TOKEN_PATTERN, BEARER_TOKEN_PATTERN, CLI_TOKEN_PATTERN, QUERY_TOKEN_PATTERN, CODEXPRO_TOKEN_ASSIGNMENT_PATTERN, CODEXPRO_TOKEN_FIELD_PATTERN, SECRET_ASSIGNMENT_PATTERN, SECRET_FIELD_PATTERN];

export function hasSecretValue(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (
        !isPlaceholderSecret(match[0]) &&
        !isCodeReferenceMatch(text, match.index, match[0], pattern)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(CODEXPRO_TOKEN_ASSIGNMENT_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(CODEXPRO_TOKEN_FIELD_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(CLI_TOKEN_PATTERN, (match, prefix) => isPlaceholderSecret(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (match, offset, input) =>
      isPlaceholderSecret(match) || isCodeAssignmentReference(input, offset, match)
        ? match
        : redactSecretAssignment(match))
    .replace(SECRET_FIELD_PATTERN, (match, prefix, offset, input) =>
      isPlaceholderSecret(match) || isTypeFieldReference(input, offset, match)
        ? match
        : `${prefix}[REDACTED_SECRET]`)
    .replace(BEARER_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(QUERY_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(OPENAI_SECRET_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]")
    .replace(COMMON_TOKEN_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
}

function isCodeReferenceMatch(text: string, offset: number, match: string, pattern: RegExp): boolean {
  if (pattern === SECRET_ASSIGNMENT_PATTERN) return isCodeAssignmentReference(text, offset, match);
  if (pattern === SECRET_FIELD_PATTERN) return isTypeFieldReference(text, offset, match);
  return false;
}

function isCodeAssignmentReference(text: string, offset: number, match: string): boolean {
  const separator = match.indexOf("=");
  if (separator < 0) return false;

  const value = match.slice(separator + 1).trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)) return false;

  return /\b(?:const|let|var)\s+$/.test(text.slice(0, offset));
}

function isTypeFieldReference(text: string, offset: number, match: string): boolean {
  const separator = match.indexOf(":");
  if (separator < 0 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(match.slice(separator + 1).trim())) return false;

  const prefix = text.slice(0, offset);
  const declarationPattern = /(?:^|\n)\s*(?:type\s+[A-Za-z_$][A-Za-z0-9_$]*(?:<[^>\n]+>)?\s*=\s*|interface\s+[A-Za-z_$][A-Za-z0-9_$]*(?:<[^>\n]+>)?\s*)\{/g;
  let openBrace = -1;
  for (const declaration of prefix.matchAll(declarationPattern)) {
    openBrace = declaration.index! + declaration[0].lastIndexOf("{");
  }
  if (openBrace < 0) return false;

  const body = prefix.slice(openBrace + 1, offset);
  // Fail closed when comments or quoted text make the declaration boundary ambiguous.
  if (/["'`/]/.test(body)) return false;

  let depth = 1;
  for (const character of body) {
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return false;
  }
  return depth > 0;
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
    normalized.includes("replace-with-long-random-token") ||
    normalized.includes("keep-this-codexpro-token-stable") ||
    normalized.includes("keep-this-stable-token") ||
    normalized.includes("your-ngrok-token") ||
    normalized.includes("your-token") ||
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
