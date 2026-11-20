// Same-origin bridge for one lot's custody history. The API decides whether the
// caller may see the lot at all and masks the prices of trades they were not
// part of; this route only re-validates the shape before the browser sees it.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'LOTS_UNAVAILABLE', 'Lot history is unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function projectSale(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid response');
  const v = input as Record<string, unknown>;
  if (!uuid.test(String(v.id ?? '')) || !uuid.test(String(v.lotId ?? '')) ||
    !Number.isInteger(v.grams) || (v.grams as number) < 1 || (v.grams as number) > 10000000 ||
    (v.pricePaise !== null && !(typeof v.pricePaise === 'string' && /^\d{1,16}$/.test(v.pricePaise))) ||
    (v.buyerLotId !== null && !uuid.test(String(v.buyerLotId))) ||
    typeof v.recordedAt !== 'string' || Number.isNaN(Date.parse(v.recordedAt)) ||
    !['seller', 'buyer', 'observer'].includes(String(v.party))) throw Error('Invalid response');
  return { id: v.id as string, lotId: v.lotId as string, grams: v.grams as number,
    pricePaise: v.pricePaise as string | null, buyerLotId: v.buyerLotId as string | null,
    recordedAt: v.recordedAt, party: v.party as 'seller' | 'buyer' | 'observer' };
}

export async function GET(request: Request, context: { params: Promise<{ lotId: string }> }) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) {
      return unavailable();
    }
    if ([...new URL(request.url).searchParams.keys()].length) return error(400, 'INVALID_QUERY', 'Lot history takes no parameters.');
    const { lotId } = await context.params;
    if (!uuid.test(lotId)) return error(400, 'INVALID_LOT_ID', 'Lot id is invalid.');
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password ||
      internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL(`/api/v1/lots/${lotId.toLowerCase()}/history`, internal), {
      headers: upstreamHeaders, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data &&
      typeof data.data === 'object' && 'sales' in data.data && Array.isArray(data.data.sales) && data.data.sales.length <= 200) {
      payload = { data: { sales: data.data.sales.map(projectSale) } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'An active supply-chain account is required.'],
        LOT_NOT_FOUND: [404, 'No such lot.'],
        INVALID_LOT_ID: [400, 'Lot id is invalid.'],
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
