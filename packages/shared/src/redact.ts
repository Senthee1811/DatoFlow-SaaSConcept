/** Log paths that must never be written (NFR-SEC-05). Used by every pino logger. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.tokenHash',
  '*.secret',
  '*.secretEnc',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  'password',
  'token',
  'secret',
];

const SENSITIVE_KEY = /pass(word)?|token|secret|api[-_]?key|authorization|cookie/i;

/** Deep-copies a value for audit metadata, dropping any key that looks like a credential. */
export function stripSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSensitive(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = stripSensitive(v);
    }
    return out as T;
  }
  return value;
}
