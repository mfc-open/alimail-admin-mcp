// Keys are compared lower-cased with "-" and "_" removed.
const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "oldpassword",
  "clientsecret",
  "accesstoken",
  "authorization",
  "token",
  "secret",
  "confirmtoken",
]);

const MASK = "***";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** Deep-copies a value, masking values under sensitive keys and bearer tokens in strings. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") {
    return value.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 " + MASK) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) && v !== undefined && v !== null ? MASK : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
