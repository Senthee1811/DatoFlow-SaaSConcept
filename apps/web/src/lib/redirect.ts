/**
 * Only same-origin paths are allowed as a post-sign-in destination (NFR-SEC-03).
 * Anything else, including protocol-relative `//host` and backslash tricks, falls back to /app.
 */
export function safeNext(next: string | null | undefined, fallback = '/app'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\'))
    return fallback;
  try {
    const url = new URL(next, 'http://datoflow.invalid');
    if (url.origin !== 'http://datoflow.invalid') return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
