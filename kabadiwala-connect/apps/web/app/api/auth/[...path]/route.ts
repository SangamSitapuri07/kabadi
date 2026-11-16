// Explicit, same-origin auth bridge. No arbitrary proxy paths or forwarded hosts.
export const dynamic = 'force-dynamic';
const fail = () => Response.json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Sign-in is unavailable.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });

async function forward(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const allowed = (request.method === 'GET' && ['/api/auth/callback/google', '/api/auth/get-session'].includes(url.pathname)) ||
      (request.method === 'POST' && ['/api/auth/sign-in/social', '/api/auth/sign-out'].includes(url.pathname));
    if (!allowed) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return fail();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
        (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return fail();
    if (request.method === 'POST' && request.headers.get('origin') !== expected.origin) {
      return Response.json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    const origin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return fail();
    const upstream = new URL(url.pathname + (url.pathname === '/api/auth/callback/google' ? url.search : ''), origin);
    const headers = new Headers();
    for (const name of ['cookie', 'origin', 'content-type']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (request.method === 'POST') {
      // Bound the stream, including requests lacking Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return new Response(null, { status: 400, headers: { 'Cache-Control': 'no-store' } });
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 8192) { await reader.cancel(); return new Response(null, { status: 413, headers: { 'Cache-Control': 'no-store' } }); }
        parts.push(value);
      }
      body = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
    }
    const result = await fetch(upstream, { method: request.method, headers, body, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const out = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    // Validate and project the API status instead of relaying arbitrary data.
    // A failed or malformed upstream response must not imply authentication.
    if (url.pathname === '/api/auth/get-session') {
      if (!result.ok) return fail();
      const data: unknown = await result.json();
      if (!data || typeof data !== 'object' || !('authenticated' in data) || typeof data.authenticated !== 'boolean') return fail();
      for (const cookie of result.headers.getSetCookie()) out.append('set-cookie', cookie);
      return Response.json({ authenticated: data.authenticated }, { headers: out });
    }
    const contentType = result.headers.get('content-type');
    if (contentType) out.set('content-type', contentType);
    const location = result.headers.get('location');
    // Better Auth may attach a Google Location header to a 200 JSON response.
    // Only forward actual redirects, and only back to the configured app origin.
    if (location && result.status >= 300 && result.status < 400) {
      const destination = new URL(location, expected.origin);
      if (destination.origin !== expected.origin) return fail();
      out.set('location', destination.href);
    }
    for (const cookie of result.headers.getSetCookie()) out.append('set-cookie', cookie);
    return new Response(result.body, { status: result.status, headers: out });
  } catch { return fail(); }
}
export const GET = forward;
export const POST = forward;
