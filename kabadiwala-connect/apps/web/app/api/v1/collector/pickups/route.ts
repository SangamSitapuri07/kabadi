// Narrow same-origin bridge for the collector's own work queue. It forwards no
// collector id and no price: the API derives both from the session and catalog.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'COLLECTOR_UNAVAILABLE', 'Collector actions are unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const limits = { name: 100, addressLine: 200, city: 100, state: 100, postalCode: 20 } as const;
type Address = Record<keyof typeof limits, string>;

function project(input: unknown, exact: boolean): Address | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(limits) as (keyof typeof limits)[];
  if (exact && Object.keys(value).length !== keys.length) return null;
  const result = {} as Address;
  for (const key of keys) {
    const field = value[key];
    if (!Object.hasOwn(value, key) || typeof field !== 'string' || /[\uD800-\uDFFF]/u.test(field)) return null;
    const trimmed = field.trim();
    if (!trimmed || Array.from(trimmed).length > limits[key] || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) return null;
    result[key] = trimmed;
  }
  return result;
}

const money = (value: unknown) => typeof value === 'string' && /^\d{1,16}$/.test(value);

// Every field a collector will act on is re-validated here. A stored row that is
// half-settled fails closed rather than being shown as a confirmed amount.
function projectPickup(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid response');
  const v = input as Record<string, unknown>;
  const address = project(v.address, false);
  if (!address || !uuid.test(String(v.id ?? '')) || !['requested', 'accepted', 'collected', 'cancelled'].includes(String(v.status)) ||
    typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt)) ||
    !Number.isInteger(v.estimatedGrams) || (v.estimatedGrams as number) < 1 || (v.estimatedGrams as number) > 10000000 ||
    !uuid.test(String(v.categoryId ?? '')) || typeof v.categoryName !== 'string' || !v.categoryName.trim() ||
    Array.from(v.categoryName).length > 100 || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.categoryName) ||
    !uuid.test(String(v.rateId ?? '')) || !Number.isInteger(v.paisePerKg) ||
    (v.paisePerKg as number) < 0 || (v.paisePerKg as number) > 1000000000 || !money(v.amountPaise)) throw Error('Invalid response');
  const base = { id: v.id as string, status: v.status as 'requested' | 'accepted' | 'collected' | 'cancelled',
    createdAt: v.createdAt, address, estimatedGrams: v.estimatedGrams as number,
    categoryId: v.categoryId as string, categoryName: v.categoryName as string, rateId: v.rateId as string,
    paisePerKg: v.paisePerKg as number, amountPaise: v.amountPaise as string };
  if (v.status !== 'collected') return { ...base, actualGrams: null, finalRateId: null, finalPaisePerKg: null, finalAmountPaise: null, collectedAt: null };
  if (!Number.isInteger(v.actualGrams) || !uuid.test(String(v.finalRateId ?? '')) ||
    !Number.isInteger(v.finalPaisePerKg) || !money(v.finalAmountPaise) ||
    typeof v.collectedAt !== 'string' || Number.isNaN(Date.parse(v.collectedAt))) throw Error('Invalid response');
  return { ...base, actualGrams: v.actualGrams as number, finalRateId: v.finalRateId as string,
    finalPaisePerKg: v.finalPaisePerKg as number, finalAmountPaise: v.finalAmountPaise as string, collectedAt: v.collectedAt };
}

async function internal(): Promise<URL | null> {
  const internalOrigin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
  if (!['http:', 'https:'].includes(internalOrigin.protocol) || internalOrigin.username || internalOrigin.password ||
    internalOrigin.pathname !== '/' || internalOrigin.search || internalOrigin.hash) return null;
  return internalOrigin;
}

export async function GET(request: Request) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    const query = new URL(request.url).searchParams;
    const view = query.get('view');
    if ([...query.keys()].length !== 1 || (view !== 'open' && view !== 'mine')) {
      return error(400, 'INVALID_VIEW', 'View must be open or mine.');
    }
    const origin = await internal();
    if (!origin) return unavailable();
    const target = new URL('/api/v1/collector/pickups', origin);
    target.searchParams.set('view', view);
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(target, { headers: upstreamHeaders, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object' &&
      'pickups' in data.data && Array.isArray(data.data.pickups) && data.data.pickups.length <= 50) {
      payload = { data: { pickups: data.data.pickups.map(projectPickup) } };
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' &&
      'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Collector access is required.'],
        INVALID_VIEW: [400, 'View must be open or mine.'],
        COLLECTOR_UNAVAILABLE: [503, 'Collector actions are unavailable.'],
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
