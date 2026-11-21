// Same-origin read bridge for the caller's own roles. Only the six chain roles
// may come back, and anything else is dropped rather than trusted: which panels appear is
// a display hint, while every route still enforces its own grant.
import { loadWorkspaceEnv } from '../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'ACCOUNT_UNAVAILABLE', 'Account details are unavailable.');
const KNOWN = ['customer', 'collector', 'shop', 'mandi', 'recycler', 'admin'];

export async function GET(request: Request) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    if ([...new URL(request.url).searchParams.keys()].length) return error(400, 'INVALID_QUERY', 'Roles take no parameters.');
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL('/api/v1/account/roles', internal), {
      headers: upstreamHeaders, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      const d = data.data as Record<string, unknown>;
      if (!Array.isArray(d.roles) || typeof d.active !== 'boolean') return unavailable();
      const roles = [...new Set(d.roles.filter((r: unknown) => typeof r === 'string' && KNOWN.includes(r)))] as string[];
      payload = { data: { roles, active: d.active } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Sign-in is required.'],
        ACCOUNT_UNAVAILABLE: [503, 'Account details are unavailable.'],
      };
      const entry = messages[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
