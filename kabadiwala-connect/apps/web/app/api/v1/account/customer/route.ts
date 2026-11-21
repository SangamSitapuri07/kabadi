// Narrow bridge for customer self-onboarding, not a general-purpose API proxy.
import { loadWorkspaceEnv } from '../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'ACCOUNT_UNAVAILABLE', 'Customer setup is unavailable.');

export async function POST(request: Request) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    if (request.headers.get('origin') !== expected.origin) return error(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error(415, 'INVALID_CONTENT_TYPE', 'JSON is required.');
    }
    const reader = request.body?.getReader();
    if (!reader) return error(400, 'INVALID_BODY', 'An empty JSON object is required.');
    const parts: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) { await reader.cancel(); return error(413, 'INVALID_BODY', 'Request body is invalid or too large.'); }
      parts.push(value);
    }
    const raw = new Uint8Array(size); let offset = 0;
    for (const part of parts) { raw.set(part, offset); offset += part.length; }
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return error(400, 'INVALID_BODY', 'An empty JSON object is required.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
      return error(400, 'INVALID_BODY', 'An empty JSON object is required.');
    }
    const origin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return unavailable();
    const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
    const cookie = request.headers.get('cookie');
    if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL('/api/v1/account/customer', origin), {
      method: 'POST', headers: upstreamHeaders, body: '{}', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object' &&
      'customer' in data.data && data.data.customer === 'ready') {
      payload = { data: { customer: 'ready' } };
    } else if ([401, 403, 503].includes(upstream.status) && data && typeof data === 'object' && 'error' in data && data.error &&
      typeof data.error === 'object' && 'code' in data.error &&
      data.error.code === ({ 401: 'SIGN_IN_REQUIRED', 403: 'FORBIDDEN', 503: 'ACCOUNT_UNAVAILABLE' } as Record<number, string>)[upstream.status]) {
      payload = { error: { code: data.error.code, message: ({ 401: 'Sign-in is required.', 403: 'Customer setup is not allowed.', 503: 'Customer setup is unavailable.' } as Record<number, string>)[upstream.status] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
