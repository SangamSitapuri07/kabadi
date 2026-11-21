// Same-origin bridge for development sign-in. It rebuilds the body from two
// primitives so a browser cannot smuggle a name, a role or an account id, and
// it never forwards an arbitrary path upstream.
import { loadWorkspaceEnv } from '../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'DEV_SIGNIN_UNAVAILABLE', 'Development sign-in is not enabled.');

export async function POST(request: Request) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) {
      return unavailable();
    }
    if (request.headers.get('origin') !== expected.origin) return error(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
    if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error(415, 'INVALID_CONTENT_TYPE', 'JSON is required.');
    }
    const reader = request.body?.getReader();
    if (!reader) return error(400, 'INVALID_BODY', 'Request is invalid.');
    const parts: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return error(413, 'INVALID_BODY', 'Request body is invalid or too large.'); }
      parts.push(value);
    }
    const raw = new Uint8Array(size); let offset = 0;
    for (const part of parts) { raw.set(part, offset); offset += part.byteLength; }
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return error(400, 'INVALID_BODY', 'Request is invalid.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return error(400, 'INVALID_BODY', 'Request is invalid.');
    const v = input as Record<string, unknown>;
    const keys = Object.keys(v);
    if (keys.length !== 2 || keys.some(key => key !== 'email' && key !== 'password')) {
      return error(400, 'INVALID_BODY', 'Exactly an email and a password are required.');
    }
    const email = typeof v.email === 'string' ? v.email.trim().toLowerCase() : '';
    const password = typeof v.password === 'string' ? v.password : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,63}@example\.test$/.test(email) || password.length < 12 || password.length > 200) {
      return error(400, 'INVALID_BODY', 'Use an @example.test address and a password of at least 12 characters.');
    }
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password ||
      internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstream = await fetch(new URL('/api/v1/dev/sign-in', internal), {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json', origin: expected.origin }),
      body: JSON.stringify({ email, password }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    const out = new Headers(headers);
    let payload: object;
    if (upstream.status === 201 && data && typeof data === 'object' && 'data' in data && data.data &&
      typeof data.data === 'object' && (data.data as Record<string, unknown>).created === true) {
      payload = { data: { created: true } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        DEV_SIGNIN_UNAVAILABLE: [503, 'Development sign-in is not enabled.'],
        INVALID_REQUEST: [400, 'Use an @example.test address and a password of at least 12 characters.'],
        ACCOUNT_EXISTS: [409, 'That test account already exists. Sign in through the normal screen.'],
        INVALID_ORIGIN: [403, 'Request origin is not allowed.'],
      };
      const entry = messages[data.error.code];
      if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie', cookie);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
