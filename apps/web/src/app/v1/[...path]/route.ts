import type { NextRequest } from 'next/server';

/**
 * Same-origin proxy to the API. The browser, the cookies and the API share one origin, so
 * SameSite=Lax session cookies work without CORS. API_URL is read at request time.
 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
];

async function proxy(req: NextRequest) {
  const target = new URL(
    req.nextUrl.pathname + req.nextUrl.search,
    process.env.API_URL ?? 'http://localhost:4000',
  );
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.set('x-forwarded-host', req.headers.get('host') ?? '');
  headers.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''));

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      {
        type: 'about:blank',
        title: 'Service unavailable',
        status: 503,
        code: 'INTERNAL',
        detail: 'The API is not reachable',
      },
      { status: 503, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const out = new Headers(upstream.headers);
  // fetch already decoded the body.
  out.delete('content-encoding');
  out.delete('content-length');
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';
