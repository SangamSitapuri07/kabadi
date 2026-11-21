// Same-origin bridge for acknowledging in-app notifications. Marking read takes
// no input: the body must be an empty object, and the API scopes the update to
// the caller's own rows, so an id belonging to somebody else is a plain 404.
import { loadWorkspaceEnv } from '../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'NOTIFICATION_UNAVAILABLE', 'Notifications are unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function bridge(request: Request, path: string) {
  const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
  if (!publicOrigin) return unavailable();
  const expected = new URL(publicOrigin);
  if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
    (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
  if (request.headers.get('origin') !== expected.origin) return error(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'INVALID_CONTENT_TYPE', 'JSON is required.');
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
  for (const part of parts) { raw.set(part, offset); offset += part.length; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { return error(400, 'INVALID_BODY', 'Request is invalid.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input as object).length !== 0) {
    return error(400, 'INVALID_BODY', 'An empty JSON object is required.');
  }
  const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
  if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
  const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
  const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
  const upstream = await fetch(new URL(path, internal), {
    method: 'POST', headers: upstreamHeaders, body: '{}', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  const data: unknown = await upstream.json();
  let payload: object;
  if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
    const d = data.data as Record<string, unknown>;
    if (d.read === true) payload = { data: { read: true } };
    else if (Number.isInteger(d.cleared) && (d.cleared as number) >= 0) payload = { data: { cleared: d.cleared } };
    else return unavailable();
  } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
    'code' in data.error && typeof data.error.code === 'string') {
    const messages: Record<string, [number, string]> = {
      INVALID_BODY: [400, 'An empty JSON object is required.'],
      INVALID_NOTIFICATION_ID: [400, 'Notification id is invalid.'],
      SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
      FORBIDDEN: [403, 'Sign-in is required.'],
      NOTIFICATION_NOT_FOUND: [404, 'That notification does not exist.'],
      NOTIFICATION_UNAVAILABLE: [503, 'Notifications are unavailable.'],
      PICKUP_SCHEMA_OUTDATED: [503, 'Pickup storage needs its migration; the database is behind the application.'],
    };
    const entry = messages[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
    payload = { error: { code: data.error.code, message: entry[1] } };
  } else return unavailable();
  const out = new Headers(headers);
  for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
  return Response.json(payload, { status: upstream.status, headers: out });
}

export async function POST(request: Request) {
  try { return await bridge(request, '/api/v1/notifications/read-all'); }
  catch { return unavailable(); }
}
