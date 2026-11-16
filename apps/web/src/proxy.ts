import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIES = ['datoflow.session_token', '__Secure-datoflow.session_token'];

/**
 * Sends signed-out visitors of /app to sign-in. This only checks that a session cookie exists;
 * the API checks the session itself on every request.
 */
export function proxy(req: NextRequest) {
  const signedIn = SESSION_COOKIES.some((name) => req.cookies.has(name));
  if (signedIn) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/sign-in';
  url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/app/:path*'] };
