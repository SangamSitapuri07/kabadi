// Narrow same-origin read bridge for the signed-in account's in-app inbox. The
// API decides who the caller is; this only projects what it returns.
import { loadWorkspaceEnv } from '../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'NOTIFICATION_UNAVAILABLE', 'Notifications are unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// The nine events the server may send. Anything else means the two sides have
// drifted, so the whole response is refused rather than partly rendered.
const EVENTS = ['pickup-requested','pickup-accepted','pickup-collected','pickup-cancelled','claim-released',
  'dispute-raised','dispute-resolved','dispute-rejected','payout-recorded'];

export async function GET(request: Request) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    if ([...new URL(request.url).searchParams.keys()].length) return error(400, 'INVALID_QUERY', 'The inbox takes no parameters.');
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL('/api/v1/notifications', internal), {
      headers: upstreamHeaders, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && object(data) && object(data.data) && Array.isArray(data.data.notifications) && data.data.notifications.length <= 50) {
      const notifications = data.data.notifications.map((v: unknown) => {
        if (!object(v)) throw Error('Invalid notification');
        // A message is rendered verbatim, so every field is checked here too.
        if (!uuid.test(String(v.id ?? '')) || !EVENTS.includes(String(v.event)) ||
          !(v.requestId === null || uuid.test(String(v.requestId))) ||
          !(v.detail === null || (typeof v.detail === 'string' && !!v.detail.trim() && Array.from(v.detail).length <= 200)) ||
          typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt)) ||
          !(v.readAt === null || (typeof v.readAt === 'string' && !Number.isNaN(Date.parse(v.readAt))))) throw Error('Invalid notification');
        return { id: v.id, event: v.event, requestId: v.requestId, detail: v.detail, createdAt: v.createdAt, readAt: v.readAt };
      });
      const unread = notifications.filter(n => n.readAt === null).length;
      // The two delivery facts stay separate: the inbox works, external
      // channels do not, and the UI must be able to say both.
      payload = { data: { notifications, unread, delivery: { inApp: true, external: [] } } };
    } else if (object(data) && object(data.error) && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Sign-in is required.'],
        NOTIFICATION_UNAVAILABLE: [503, 'Notifications are unavailable.'],
        PICKUP_SCHEMA_OUTDATED: [503, 'Pickup storage needs its migration; the database is behind the application.'],
      };
      const entry = messages[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
