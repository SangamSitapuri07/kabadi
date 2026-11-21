// Narrow same-origin bridge for cancelling one's own request. The optional
// reason is re-validated here; no other field is ever forwarded.
import { loadWorkspaceEnv } from '../../../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'PICKUP_UNAVAILABLE', 'Test pickup requests are unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ requestId: string }> }) {
  try {
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
    if (!input || typeof input !== 'object' || Array.isArray(input)) return error(400, 'INVALID_BODY', 'Request is invalid.');
    const { requestId } = await context.params;
    if (!uuid.test(requestId)) return error(400, 'INVALID_REQUEST_ID', 'Request id is invalid.');
    const keys = Object.keys(input as Record<string, unknown>);
    let body = '{}';
    if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'reason')) return error(400, 'INVALID_BODY', 'Only an optional reason is accepted.');
    if (keys.length === 1) {
      const reason = (input as Record<string, unknown>).reason;
      if (typeof reason !== 'string' || !reason.trim() || reason.trim() !== reason ||
        Array.from(reason).length > 200 || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(reason)) {
        return error(400, 'INVALID_REASON', 'The reason must be 1 to 200 characters.');
      }
      body = JSON.stringify({ reason });
    }

    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL(`/api/v1/customer/pickups/${requestId.toLowerCase()}/cancel`, internal), {
      method: 'POST', headers: upstreamHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data &&
      typeof data.data === 'object' && (data.data as Record<string, unknown>).cancelled === true) {
      payload = { data: { cancelled: true } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        INVALID_BODY: [400, 'Request is invalid.'],
        INVALID_REASON: [400, 'The reason must be 1 to 200 characters.'],
        INVALID_REQUEST_ID: [400, 'Request id is invalid.'],
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Customer access is required.'],
        REQUEST_NOT_FOUND: [404, 'That request does not exist.'],
        ALREADY_CANCELLED: [409, 'This request is already cancelled.'],
        ALREADY_COLLECTED: [409, 'A collected request cannot be cancelled.'],
        PICKUP_SCHEMA_OUTDATED: [503, 'Pickup storage needs its migration; the database is behind the application.'],
        PICKUP_UNAVAILABLE: [503, 'Test pickup requests are unavailable.'],
      };
      const entry = messages[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
