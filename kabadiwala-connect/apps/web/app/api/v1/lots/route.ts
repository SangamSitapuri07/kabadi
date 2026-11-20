// Same-origin bridge for the caller's own holdings and for opening a lot from a
// pickup they collected. The body is rebuilt from two primitives: the browser
// never states a weight, a cost, or which account holds the lot.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'LOTS_UNAVAILABLE', 'Lot actions are unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = (value: unknown): value is string => typeof value === 'string' && /^\d{1,16}$/.test(value);

function originHeader(): URL | null {
  const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
  if (!publicOrigin) return null;
  const expected = new URL(publicOrigin);
  if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' ||
    expected.search || expected.hash ||
    (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) {
    return null;
  }
  return expected;
}

function internal(): URL | null {
  const origin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash) return null;
  return origin;
}

// Every field the UI acts on is re-checked here. A stored row that fails any of
// these is dropped: a half-understood lot is worse than a missing one.
function projectLot(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid response');
  const v = input as Record<string, unknown>;
  if (!uuid.test(String(v.id ?? '')) || typeof v.material !== 'string' || !v.material.trim() ||
    Array.from(v.material).length > 100 || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.material) ||
    !Number.isInteger(v.grams) || (v.grams as number) < 1 || (v.grams as number) > 10000000 ||
    !money(v.costPaise) || v.status !== 'held' ||
    typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt)) ||
    (v.parentLotId !== null && !uuid.test(String(v.parentLotId))) ||
    (v.sourcePickupId !== null && !uuid.test(String(v.sourcePickupId)))) throw Error('Invalid response');
  return { id: v.id as string, material: v.material, grams: v.grams as number, costPaise: v.costPaise,
    status: 'held' as const, createdAt: v.createdAt, parentLotId: v.parentLotId as string | null,
    sourcePickupId: v.sourcePickupId as string | null };
}

const outcomeMessages: Record<string, [number, string]> = {
  SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
  FORBIDDEN: [403, 'An active supply-chain account is required.'],
  NOT_HOLDER: [403, 'This account is not holding that lot.'],
  NOT_COLLECTOR: [403, 'Only a collector can take custody of a collected pickup.'],
  NOT_A_CHAIN_ACCOUNT: [403, 'This account holds no tier in the supply chain.'],
  LOT_NOT_FOUND: [404, 'No such lot.'],
  INVALID_REQUEST: [400, 'Request is invalid.'],
  INVALID_BODY: [400, 'Request is invalid.'],
  INVALID_ORIGIN: [403, 'Request origin is not allowed.'],
  ALREADY_SOLD: [409, 'That lot has already been sold.'],
  PICKUP_NOT_COLLECTED: [409, 'Only a collected pickup can become a lot.'],
  PICKUP_ALREADY_LOTTED: [409, 'That pickup is already in custody as a lot.'],
  NO_NEXT_TIER: [409, 'A recycler is the end of the chain: there is nothing to sell upward to.'],
  NO_BUYER: [409, 'No active account holds the next tier up.'],
  SAME_ACCOUNT: [409, 'An account cannot buy its own lot.'],
  INVALID_WEIGHT: [400, 'That weight is more than the lot holds.'],
  LOTS_UNAVAILABLE: [503, 'Lot storage is unavailable. Run the lot migration.'],
};

async function forward(path: string, cookie: string | null, expected: URL, body?: string): Promise<Response> {
  const target = internal();
  if (!target) return unavailable();
  const upstreamHeaders = new Headers();
  if (body !== undefined) { upstreamHeaders.set('content-type', 'application/json'); upstreamHeaders.set('origin', expected.origin); }
  if (cookie) upstreamHeaders.set('cookie', cookie);
  const upstream = await fetch(new URL(path, target), {
    method: body === undefined ? 'GET' : 'POST', headers: upstreamHeaders, body,
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  const data: unknown = await upstream.json();
  let payload: object;
  if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
    const d = data.data as Record<string, unknown>;
    if (Array.isArray(d.lots)) {
      if (d.lots.length > 100) return unavailable();
      payload = { data: { lots: d.lots.map(projectLot) } };
    } else if (d.outcome === 'opened') {
      // Opening a lot answers with the new lot; it is listed from the next read.
      payload = { data: { opened: true, lot: projectLot(d.lot) } };
    } else return unavailable();
  } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
    'code' in data.error && typeof data.error.code === 'string') {
    const entry = outcomeMessages[data.error.code];
    if (!entry || entry[0] !== upstream.status) return unavailable();
    payload = { error: { code: data.error.code, message: entry[1] } };
  } else return unavailable();
  const out = new Headers(headers);
  for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
  return Response.json(payload, { status: upstream.status, headers: out });
}

export async function GET(request: Request) {
  try {
    const expected = originHeader(); if (!expected) return unavailable();
    // No parameters: listing your own holdings takes none, and accepting one
    // would invite a caller to ask for somebody else's.
    if ([...new URL(request.url).searchParams.keys()].length) return error(400, 'INVALID_QUERY', 'The lot list takes no parameters.');
    return await forward('/api/v1/lots', request.headers.get('cookie'), expected);
  } catch { return unavailable(); }
}

export async function POST(request: Request) {
  try {
    const expected = originHeader(); if (!expected) return unavailable();
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
    if (keys.length !== 2 || keys.some(key => key !== 'pickupId' && key !== 'material')) {
      return error(400, 'INVALID_BODY', 'Exactly a pickup id and a material are required.');
    }
    const material = typeof v.material === 'string' ? v.material.trim() : '';
    if (!uuid.test(String(v.pickupId ?? '')) || !material || Array.from(material).length > 100 ||
      /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(material)) return error(400, 'INVALID_BODY', 'Request is invalid.');
    return await forward('/api/v1/lots', request.headers.get('cookie'), expected,
      JSON.stringify({ pickupId: String(v.pickupId).toLowerCase(), material }));
  } catch { return unavailable(); }
}
