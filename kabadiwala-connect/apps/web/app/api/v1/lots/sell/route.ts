// Same-origin bridge for selling a lot one tier up. The browser names the lot,
// the weight and the asking price; it never names a buyer. Who may buy is the
// API's decision from the grant tables, not the seller's.
import { loadWorkspaceEnv } from '../../../../env';
export const dynamic = 'force-dynamic';
loadWorkspaceEnv();
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'LOTS_UNAVAILABLE', 'Lot actions are unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    for (const part of parts) { raw.set(part, offset); offset += part.length; }
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return error(400, 'INVALID_BODY', 'Request is invalid.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return error(400, 'INVALID_BODY', 'Request is invalid.');
    const v = input as Record<string, unknown>;
    const keys = Object.keys(v);
    if (keys.length !== 3 || keys.some(key => !['lotId', 'grams', 'pricePaise'].includes(key))) {
      return error(400, 'INVALID_BODY', 'Exactly a lot id, a weight and a price are required.');
    }
    // Paise as a decimal string, exactly as the API requires: a price that has
    // been through floating point is not a price.
    if (!uuid.test(String(v.lotId ?? '')) || !Number.isInteger(v.grams) ||
      (v.grams as number) < 1 || (v.grams as number) > 10000000 ||
      typeof v.pricePaise !== 'string' || !/^\d{1,16}$/.test(v.pricePaise)) {
      return error(400, 'INVALID_BODY', 'Request is invalid.');
    }
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password ||
      internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers({ 'content-type': 'application/json', origin: expected.origin });
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL('/api/v1/lots/sell', internal), {
      method: 'POST', headers: upstreamHeaders,
      body: JSON.stringify({ lotId: String(v.lotId).toLowerCase(), grams: v.grams, pricePaise: v.pricePaise }),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      const d = data.data as Record<string, unknown>;
      // The API answers with its outcome envelope. A sold lot is the only success
      // shape here; anything else is a bug, not a display problem, so it fails
      // closed rather than showing a sale that may not have happened.
      const sale = d.sale as Record<string, unknown> | undefined;
      if (d.outcome !== 'sold' || !sale || !Number.isInteger(sale.grams) ||
        typeof sale.pricePaise !== 'string' || !/^\d{1,16}$/.test(sale.pricePaise) ||
        !['collector', 'shop', 'mandi', 'recycler'].includes(String(sale.buyerTier))) return unavailable();
      payload = { data: { sold: true, grams: sale.grams as number, pricePaise: sale.pricePaise,
        buyerTier: sale.buyerTier as string } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'An active supply-chain account is required.'],
        NOT_HOLDER: [403, 'This account is not holding that lot.'],
        NOT_A_CHAIN_ACCOUNT: [403, 'This account holds no tier in the supply chain.'],
        LOT_NOT_FOUND: [404, 'No such lot.'],
        INVALID_REQUEST: [400, 'Request is invalid.'],
        INVALID_WEIGHT: [400, 'That weight is more than the lot holds.'],
        ALREADY_SOLD: [409, 'That lot has already been sold.'],
        NO_NEXT_TIER: [409, 'A recycler is the end of the chain: there is nothing to sell upward to.'],
        NO_BUYER: [409, 'No active account holds the next tier up.'],
        SAME_ACCOUNT: [409, 'An account cannot buy its own lot.'],
        LOTS_UNAVAILABLE: [503, 'Lot storage is unavailable. Run the lot migration.'],
      };
      const entry = messages[data.error.code];
      if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
