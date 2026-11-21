// Same-origin read bridge for the dashboard shell: who is signed in, and what
// roles they hold.
//
// The shell renders navigation from this, so it must never invent a role. Roles
// are filtered to the six this build knows, and a signed-out answer is passed
// through as `signedIn: false` -- a first visit to a dashboard URL is normal, not
// an error, and turning it into a 401 would make the page look broken.
import { loadWorkspaceEnv } from '../../../../env';

export const dynamic = 'force-dynamic';
loadWorkspaceEnv();

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const KNOWN = ['customer', 'collector', 'shop', 'mandi', 'recycler', 'admin'] as const;

const error = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'ACCOUNT_UNAVAILABLE', 'Account details are unavailable.');

export async function GET(request: Request) {
  try {
    // Same origin rules as every other bridge: this must not be usable as an open
    // proxy, and local HTTP is tolerated only for loopback development origins.
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (
      expected.origin !== publicOrigin ||
      expected.username ||
      expected.password ||
      expected.pathname !== '/' ||
      expected.search ||
      expected.hash ||
      (expected.protocol !== 'https:' &&
        !(
          expected.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)
        ))
    ) {
      return unavailable();
    }

    if ([...new URL(request.url).searchParams.keys()].length) {
      return error(400, 'INVALID_QUERY', 'The dashboard session takes no parameters.');
    }

    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (
      !['http:', 'https:'].includes(internal.protocol) ||
      internal.username ||
      internal.password ||
      internal.pathname !== '/' ||
      internal.search ||
      internal.hash
    ) {
      return unavailable();
    }

    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie');
    if (cookie) upstreamHeaders.set('cookie', cookie);

    const upstream = await fetch(new URL('/api/v1/auth/dashboard-session', internal), {
      headers: upstreamHeaders,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });

    const data: unknown = await upstream.json();

    if (
      upstream.status === 200 &&
      data &&
      typeof data === 'object' &&
      'signedIn' in data &&
      typeof data.signedIn === 'boolean' &&
      'roles' in data &&
      Array.isArray(data.roles) &&
      'displayName' in data &&
      (data.displayName === null || typeof data.displayName === 'string')
    ) {
      const roles = [
        ...new Set(
          data.roles.filter(
            (role): role is (typeof KNOWN)[number] =>
              typeof role === 'string' && (KNOWN as readonly string[]).includes(role),
          ),
        ),
      ];
      const out = new Headers(headers);
      for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
      return Response.json(
        { signedIn: data.signedIn, roles, displayName: data.displayName },
        { status: 200, headers: out },
      );
    }

    return unavailable();
  } catch {
    return unavailable();
  }
}
