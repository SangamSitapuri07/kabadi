// Narrow same-origin bridge, never a general API proxy. Do not log profile data.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'PICKUP_UNAVAILABLE', 'Test pickup requests are unavailable.');
const limits = { name: 100, addressLine: 200, city: 100, state: 100, postalCode: 20 } as const;
type Details = Record<keyof typeof limits, string>;
function project(input: unknown, exact: boolean): Details | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const keys = Object.keys(limits) as (keyof typeof limits)[];
  if (exact && Object.keys(value).length !== keys.length) return null;
  const result = {} as Details;
  for (const key of keys) {
    const field = value[key];
    if (!Object.hasOwn(value, key) || typeof field !== 'string' || /[\uD800-\uDFFF]/u.test(field)) return null;
    const trimmed = field.trim();
    if (!trimmed || Array.from(trimmed).length > limits[key] || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) return null;
    result[key] = trimmed;
  }
  return result;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parsePickup(input: unknown): {requestKey:string; categoryId:string; estimatedGrams:number} | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (Object.keys(v).length !== 3 ||
      typeof v.requestKey !== 'string' || !uuid.test(v.requestKey) ||
      typeof v.categoryId !== 'string' || !uuid.test(v.categoryId) ||
      !Number.isInteger(v.estimatedGrams) || (v.estimatedGrams as number) < 1 || (v.estimatedGrams as number) > 10000000) return null;
  return {requestKey:v.requestKey.toLowerCase(), categoryId:v.categoryId.toLowerCase(), estimatedGrams:v.estimatedGrams as number};
}
// The bridge re-validates every field it forwards; the API still owns the
// authorization and the pricing decision.
function parseEstimate(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>;
  if (!uuid.test(String(v.categoryId ?? '')) || !uuid.test(String(v.rateId ?? '')) ||
      typeof v.categoryName !== 'string' || !v.categoryName.trim() || Array.from(v.categoryName).length > 100 ||
      /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.categoryName) ||
      !Number.isInteger(v.paisePerKg) || (v.paisePerKg as number) < 0 || (v.paisePerKg as number) > 1000000000 ||
      typeof v.amountPaise !== 'string' || !/^\d{1,16}$/.test(v.amountPaise)) return null;
  return { categoryId:v.categoryId as string, categoryName:v.categoryName, rateId:v.rateId as string,
    paisePerKg:v.paisePerKg as number, amountPaise:v.amountPaise };
}
async function handle(request: Request, method: 'GET' | 'POST') {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    let body: string | undefined;
    if (method === 'POST') {
      if (request.headers.get('origin') !== expected.origin) return error(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
      if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'INVALID_CONTENT_TYPE', 'JSON is required.');
      const reader = request.body?.getReader();
      if (!reader) return error(400, 'INVALID_BODY', 'Test pickup requests are invalid.');
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
      catch { return error(400, 'INVALID_BODY', 'Test pickup requests are invalid.'); }
      const pickup = parsePickup(input);
      if (!pickup) return error(400, 'INVALID_BODY', 'Test pickup request is invalid.');
      body = JSON.stringify(pickup);
    }
    const origin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie');
    if (cookie) upstreamHeaders.set('cookie', cookie);
    if (method === 'POST') { upstreamHeaders.set('content-type', 'application/json'); upstreamHeaders.set('origin', expected.origin); }
    const upstream = await fetch(new URL('/api/v1/customer/pickups', origin), {
      method, headers: upstreamHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      if (method === 'POST' && 'created' in data.data && typeof data.data.created === 'boolean' && 'estimate' in data.data) {
        const estimate = parseEstimate(data.data.estimate);
        if (!estimate) return unavailable();
        payload = { data: { created: data.data.created, estimate } };
      }
      else if (method === 'GET' && 'pickups' in data.data && Array.isArray(data.data.pickups) && data.data.pickups.length <= 50) {
        const pickups = data.data.pickups.map((r: unknown) => {
          if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error('Invalid response');
          const v = r as Record<string, unknown>;
          const address = project(v.address, false);
          if (!address || !['requested','accepted','collected'].includes(String(v.status)) ||
              !uuid.test(String(v.id ?? '')) ||
              typeof v.createdAt !== 'string' || Number.isNaN(Date.parse(v.createdAt)) ||
              !Number.isInteger(v.estimatedGrams)) throw Error('Invalid response');
          // A settled request must carry its measured weight and final amount;
          // anything half-filled is rejected rather than shown as a price.
          const settled = v.status !== 'collected' ? {
            actualGrams:null, finalRateId:null, finalPaisePerKg:null, finalAmountPaise:null, collectedAt:null,
          } : (
            Number.isInteger(v.actualGrams) && uuid.test(String(v.finalRateId ?? '')) &&
            Number.isInteger(v.finalPaisePerKg) && /^\d{1,16}$/.test(String(v.finalAmountPaise ?? '')) &&
            typeof v.collectedAt === 'string' && !Number.isNaN(Date.parse(v.collectedAt))
          ) ? {
            actualGrams:v.actualGrams, finalRateId:v.finalRateId, finalPaisePerKg:v.finalPaisePerKg,
            finalAmountPaise:v.finalAmountPaise, collectedAt:v.collectedAt,
          } : (() => { throw Error('Invalid response'); })();
          // Either a priced item with a snapshot, or a legacy free-text request.
          if (v.categoryId !== null) {
            const estimate = parseEstimate({ categoryId:v.categoryId, categoryName:v.categoryName, rateId:v.rateId, paisePerKg:v.paisePerKg, amountPaise:v.amountPaise });
            if (!estimate) throw Error('Invalid response');
            return { id:v.id, status:v.status, createdAt:v.createdAt, address, estimatedGrams:v.estimatedGrams,
              material:null, ...estimate, ...settled };
          }
          if (typeof v.material !== 'string' || !v.material.trim() || Array.from(v.material).length > 100 ||
              /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.material)) throw Error('Invalid response');
          return { id:v.id, status:v.status, createdAt:v.createdAt, address, estimatedGrams:v.estimatedGrams,
            material:v.material, categoryId:null, categoryName:null, rateId:null, paisePerKg:null, amountPaise:null,
            ...settled };
        });
        payload = { data: { pickups } };
      } else return unavailable();
    } else if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'code' in data.error && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = { INVALID_BODY:[400, 'Test pickup request is invalid.'], SIGN_IN_REQUIRED:[401, 'Sign-in is required.'], FORBIDDEN:[403, 'Customer access is required.'], PROFILE_REQUIRED:[409, 'Save customer details first.'], REQUEST_CONFLICT:[409, 'This request key was already used.'], UNKNOWN_CATEGORY:[409, 'That category is not available.'], NO_RATE:[409, 'No rate is active for that category yet.'], PICKUP_UNAVAILABLE:[503, 'Test pickup requests are unavailable.'] };
      const entry = messages[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
      payload = { error: { code:data.error.code, message:entry[1] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
export function GET(request: Request) { return handle(request, 'GET'); }
export function POST(request: Request) { return handle(request, 'POST'); }
