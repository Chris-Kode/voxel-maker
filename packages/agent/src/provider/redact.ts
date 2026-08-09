import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";

/**
 * Deterministic redaction for logs, transcripts, and diagnostics (plan
 * S12.4/S12.11, ADR-0010): secrets, paths, prompts, provider payloads,
 * and protected content are replaced by a fixed marker before anything is
 * written or exported. Redaction is pure and side-effect free, so every
 * consumer redacts identically.
 */

export const REDACTION_MARKER = "[REDACTED]";

/** Common secret patterns: bearer tokens, OpenAI keys, auth values. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\b(?:api[_-]?key|apikey|authorization|token|secret|password|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"',;]+/giu,
];

/** Protected content patterns: paths, URLs, home directories. */
const PROTECTED_PATTERNS: readonly RegExp[] = [
  /(?:https?|ftp):\/\/[^\s"'<>]+/giu,
  /(?:\\\\|\/)(?:Users|home)\/[^\s"'<>\\/]+/giu,
  /[A-Za-z]:\\Users\\[^\s"'<>\\]+/giu,
  /\/tmp\/[^\s"'<>/]+\/[^\s"'<>]+/gu,
];

/** True when the string contains the redaction marker. */
export function isRedacted(value: string): boolean {
  return value.includes(REDACTION_MARKER);
}

/** Replaces every occurrence of any known secret with the marker. */
export function redactSecrets(
  value: string,
  secrets: readonly string[],
): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(REDACTION_MARKER);
  }
  return out;
}

/** Applies all deterministic secret and protected-content patterns. */
export function redactDiagnostics(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS)
    out = out.replace(pattern, REDACTION_MARKER);
  for (const pattern of PROTECTED_PATTERNS)
    out = out.replace(pattern, REDACTION_MARKER);
  return out;
}

/**
 * Deep-redacts every string in a JSON tree with the secret patterns plus
 * explicit secret values; leaves the structure intact. Used by the
 * transcript and diagnostics exporters.
 */
/**
 * Hard nesting cap for redaction (issue #44): provider payloads and tool
 * results are untrusted, so a pathologically nested value must fail
 * structured instead of overflowing the stack. 256 levels is far above any
 * legitimate transcript/diagnostic entry.
 */
export const REDACT_MAX_DEPTH = 256;

const redactDepthError = (): WorkspaceError =>
  new WorkspaceError({
    family: "limit",
    code: "LIMIT_EXCEEDED",
    message: `Value exceeds the maximum nesting depth of ${String(REDACT_MAX_DEPTH)}`,
  });

export function redactJson(
  value: JsonValue,
  secrets: readonly string[] = [],
  depth = 0,
): JsonValue {
  if (depth > REDACT_MAX_DEPTH) throw redactDepthError();
  if (typeof value === "string") {
    return redactSecrets(redactDiagnostics(value), secrets);
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      (value as readonly JsonValue[]).map((item) =>
        redactJson(item, secrets, depth + 1),
      ),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactJson(item, secrets, depth + 1);
    }
    return Object.freeze(out);
  }
  return value;
}

/** Key names whose values are always treated as protected content. */
const PROTECTED_KEYS = new Set([
  "apikey",
  "authorization",
  "credential",
  "key",
  "password",
  "secret",
  "token",
]);

/**
 * Redacts every value whose key looks like a credential or payload field,
 * plus known secret patterns inside strings. Suitable for provider
 * payloads and diagnostics where keys may vary.
 */
export function redactProviderPayload(value: JsonValue, depth = 0): JsonValue {
  if (depth > REDACT_MAX_DEPTH) throw redactDepthError();
  if (Array.isArray(value)) {
    return Object.freeze(
      (value as readonly JsonValue[]).map((item) =>
        redactProviderPayload(item, depth + 1),
      ),
    );
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (PROTECTED_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTION_MARKER;
      } else {
        out[key] = redactProviderPayload(item, depth + 1);
      }
    }
    return Object.freeze(out);
  }
  if (typeof value === "string") {
    return redactDiagnostics(value);
  }
  return value;
}
