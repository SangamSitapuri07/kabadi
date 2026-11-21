// Same-origin bridge for recording that a payout happened. The browser never
// sends an amount: the API pays whatever the settled settlement says.
import { loadWorkspaceEnv } from '../../../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'PAYOUT_UNAVAILABLE', 'Payout recording is unavailable.');
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
    const value = input as Record<string, unknown>;
    const keys = Object.keys(value);
    // method is required; reference and note are optional. Anything else --
    // notably an amount -- is refused rather than silently dropped.
    if (keys.length < 1 || keys.some(key => key !== 'method' && key !== 'reference' && key !== 'note')) {
      return error(400, 'INVALID_BODY', 'Only method, reference and note are accepted.');
    }
    const { method, reference, note } = value;
    if (method !== 'cash' && method !== 'transfer' && method !== 'adjustment') {
      return error(400, 'INVALID_METHOD', 'Method must be cash, transfer or adjustment.');
    }
    const ok = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && !!v.trim() &&
      Array.from(v.trim()).length <= max && !/[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.trim()));
    if (!ok(reference, 100) || !ok(note, 200)) {
      return error(400, 'INVALID_DETAILS', 'Reference must be 1-100 and note 1-200 characters.');
    }
    const body = JSON.stringify({ method,
      reference: typeof reference === 'string' ? reference.trim() : null,
      note: typeof note === 'string' ? note.trim() : null });

    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL(`/api/v1/admin/payouts/${requestId.toLowerCase()}/pay`, internal), {
      method: 'POST', headers: upstreamHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      const d = data.data as Record<string, unknown>;
      if (d.paid !== true || typeof d.amountPaise !== 'string' || !/^\d{1,16}$/.test(d.amountPaise)) return unavailable();
      payload = { data: { paid: true, amountPaise: d.amountPaise, method: d.method } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        INVALID_BODY: [400, 'Only method, reference and note are accepted.'],
        INVALID_METHOD: [400, 'Method must be cash, transfer or adjustment.'],
        INVALID_DETAILS: [400, 'Reference must be 1-100 and note 1-200 characters.'],
        INVALID_REQUEST_ID: [400, 'Request id is invalid.'],
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Admin access is required.'],
        REQUEST_NOT_FOUND: [404, 'That request does not exist.'],
        NOT_COLLECTED: [409, 'Only a collected request can be paid out.'],
        ALREADY_PAID: [409, 'This request has already been paid.'],
        DISPUTE_OPEN: [409, 'An open dispute must be resolved before paying.'],
        PAYOUT_UNAVAILABLE: [503, 'Payout recording is unavailable.'],
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
