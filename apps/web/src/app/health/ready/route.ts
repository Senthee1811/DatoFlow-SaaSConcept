export const dynamic = 'force-dynamic';

/** Ready when the API it depends on is ready. */
export async function GET() {
  try {
    const res = await fetch(
      new URL('/health/ready', process.env.API_URL ?? 'http://localhost:4000'),
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(2500),
      },
    );
    const ok = res.ok;
    return Response.json(
      { status: ok ? 'ok' : 'down', checks: { api: ok ? 'ok' : 'down' } },
      { status: ok ? 200 : 503 },
    );
  } catch {
    return Response.json({ status: 'down', checks: { api: 'down' } }, { status: 503 });
  }
}
