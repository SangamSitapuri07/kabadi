// Same-origin bridge for resolving or rejecting one dispute. A resolution carries
// only the corrected weight; the price is never sent from the browser.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'DISPUTE_UNAVAILABLE', 'Dispute handling is unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request, context: { params: Promise<{ requestId: string; action: string }> }) {
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
    const { requestId, action } = await context.params;
    if (!uuid.test(requestId)) return error(400, 'INVALID_REQUEST_ID', 'Request id is invalid.');
    if (action !== 'resolve' && action !== 'reject') return error(404, 'NOT_FOUND', 'That dispute action does not exist.');
    const keys = Object.keys(input as Record<string, unknown>);
    let body: string;
    if (action === 'reject') {
      if (keys.length !== 0) return error(400, 'INVALID_BODY', 'An empty JSON object is required.');
      body = '{}';
    } else {
      const grams = (input as Record<string, unknown>).correctedGrams;
      if (keys.length !== 1 || keys[0] !== 'correctedGrams' || !Number.isInteger(grams) ||
        (grams as number) < 1 || (grams as number) > 10000000) {
        return error(400, 'INVALID_WEIGHT', 'Corrected weight must be 1 to 10,000,000 grams.');
      }
      body = JSON.stringify({ correctedGrams: grams });
    }

    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL(`/api/v1/admin/disputes/${requestId.toLowerCase()}/${action}`, internal), {
      method: 'POST', headers: upstreamHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      const d = data.data as Record<string, unknown>;
      if (action === 'reject') {
        if (d.rejected !== true) return unavailable();
        payload = { data: { rejected: true } };
      } else {
        if (d.resolved !== true || !Number.isInteger(d.actualGrams) || !Number.isInteger(d.finalPaisePerKg) ||
          typeof d.finalAmountPaise !== 'string' || !/^\d{1,16}$/.test(d.finalAmountPaise)) return unavailable();
        payload = { data: { resolved: true, actualGrams: d.actualGrams, finalPaisePerKg: d.finalPaisePerKg, finalAmountPaise: d.finalAmountPaise } };
      }
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        INVALID_WEIGHT: [400, 'Corrected weight must be 1 to 10,000,000 grams.'],
        INVALID_REQUEST_ID: [400, 'Request id is invalid.'],
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Admin access is required.'],
        REQUEST_NOT_FOUND: [404, 'That request does not exist.'],
        NOT_COLLECTED: [409, 'Only a collected request can be disputed.'],
        NO_OPEN_DISPUTE: [409, 'There is no open dispute for this request.'],
        SAME_WEIGHT: [409, 'That is the weight already recorded; nothing to correct.'],
        DISPUTE_UNAVAILABLE: [503, 'Dispute handling is unavailable.'],
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
