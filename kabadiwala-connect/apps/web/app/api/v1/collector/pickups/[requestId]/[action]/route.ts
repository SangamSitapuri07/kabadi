// Same-origin bridge for accept/collect. The body is rebuilt from primitives so
// a browser cannot smuggle in a collector id, a rate or an amount.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'COLLECTOR_UNAVAILABLE', 'Collector actions are unavailable.');

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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return error(400, 'INVALID_REQUEST_ID', 'Request id is invalid.');
    if (action !== 'accept' && action !== 'collect') return error(404, 'NOT_FOUND', 'That collector action does not exist.');

    const keys = Object.keys(input as Record<string, unknown>);
    let body: string;
    if (action === 'accept') {
      if (keys.length !== 0) return error(400, 'INVALID_BODY', 'An empty JSON object is required.');
      body = '{}';
    } else {
      const grams = (input as Record<string, unknown>).actualGrams;
      if (keys.length !== 1 || !Number.isInteger(grams) || (grams as number) < 1 || (grams as number) > 10000000) {
        return error(400, 'INVALID_WEIGHT', 'Actual weight must be 1 to 10,000,000 grams.');
      }
      body = JSON.stringify({ actualGrams: grams });
    }

    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL(`/api/v1/collector/pickups/${requestId.toLowerCase()}/${action}`, internal), {
      method: 'POST', headers: upstreamHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      const d = data.data as Record<string, unknown>;
      if (action === 'accept') {
        if (d.accepted !== true) return unavailable();
        payload = { data: { accepted: true } };
      } else {
        if (d.collected !== true || !Number.isInteger(d.actualGrams) || !Number.isInteger(d.finalPaisePerKg) ||
          typeof d.finalAmountPaise !== 'string' || !/^\d{1,16}$/.test(d.finalAmountPaise) ||
          typeof d.finalRateId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(d.finalRateId)) return unavailable();
        payload = { data: { collected: true, actualGrams: d.actualGrams, finalPaisePerKg: d.finalPaisePerKg,
          finalAmountPaise: d.finalAmountPaise, finalRateId: d.finalRateId } };
      }
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        INVALID_BODY: [400, 'Request is invalid.'],
        INVALID_WEIGHT: [400, 'Actual weight must be 1 to 10,000,000 grams.'],
        INVALID_REQUEST_ID: [400, 'Request id is invalid.'],
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Collector access is required.'],
        REQUEST_NOT_FOUND: [404, 'That request does not exist.'],
        ALREADY_ACCEPTED: [409, 'Another collector already accepted this request.'],
        NOT_ACCEPTED: [409, 'Accept this request before recording a collection.'],
        ALREADY_COLLECTED: [409, 'This request was already collected.'],
        NO_RATE: [409, 'No rate is in force for that category.'],
        LEGACY_REQUEST: [409, 'Older free-text requests cannot be priced.'],
        COLLECTOR_UNAVAILABLE: [503, 'Collector actions are unavailable.'],
      };
      const entry = messages[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
