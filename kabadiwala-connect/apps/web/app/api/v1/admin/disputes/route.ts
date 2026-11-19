// Narrow same-origin read bridge for the admin dispute queue. The API decides
// whether the caller is an admin; this only projects what it returns.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'DISPUTE_UNAVAILABLE', 'Dispute handling is unavailable.');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const limits = { name: 100, addressLine: 200, city: 100, state: 100, postalCode: 20 } as const;

function projectAddress(input: unknown) {
  if (!object(input)) return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim() || Array.from(value).length > limits[key]) return null;
    out[key] = value;
  }
  return out;
}

export async function GET(request: Request) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    if ([...new URL(request.url).searchParams.keys()].length) return error(400, 'INVALID_QUERY', 'The dispute queue takes no parameters.');
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL('/api/v1/admin/disputes', internal), {
      headers: upstreamHeaders, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && object(data) && object(data.data) && Array.isArray(data.data.disputes) && data.data.disputes.length <= 50) {
      const disputes = data.data.disputes.map((v: unknown) => {
        if (!object(v)) throw Error('Invalid dispute');
        const address = projectAddress(v.address);
        const dispute = v.dispute;
        if (!address || !uuid.test(String(v.id ?? '')) || typeof v.categoryName !== 'string' ||
          typeof v.finalAmountPaise !== 'string' || !/^\d{1,16}$/.test(v.finalAmountPaise) ||
          !Number.isInteger(v.finalPaisePerKg) || !Number.isInteger(v.actualGrams) ||
          !Number.isInteger(v.estimatedGrams) || !object(dispute) || dispute.status !== 'open' ||
          typeof dispute.reason !== 'string' || typeof dispute.raisedAt !== 'string') throw Error('Invalid dispute');
        return { id: v.id, categoryName: v.categoryName, address, estimatedGrams: v.estimatedGrams,
          actualGrams: v.actualGrams, finalPaisePerKg: v.finalPaisePerKg, finalAmountPaise: v.finalAmountPaise,
          dispute: { reason: dispute.reason, raisedAt: dispute.raisedAt } };
      });
      payload = { data: { disputes } };
    } else if (object(data) && object(data.error) && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Admin access is required.'],
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
