// Narrow same-origin read bridge for the admin payout queue. The API decides
// whether the caller is an admin, and it alone decides the amount owed.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'PAYOUT_UNAVAILABLE', 'Payout recording is unavailable.');
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
    if ([...new URL(request.url).searchParams.keys()].length) return error(400, 'INVALID_QUERY', 'The payout queue takes no parameters.');
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(new URL('/api/v1/admin/payouts', internal), {
      headers: upstreamHeaders, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && object(data) && object(data.data) && Array.isArray(data.data.dues) && data.data.dues.length <= 50) {
      const dues = data.data.dues.map((v: unknown) => {
        if (!object(v)) throw Error('Invalid due');
        const address = projectAddress(v.address);
        // Every field is re-checked because this is the one screen where an
        // admin is about to hand over money: a half-filled row is rejected.
        if (!address || !uuid.test(String(v.id ?? '')) || v.status !== 'collected' ||
          typeof v.categoryName !== 'string' || !v.categoryName.trim() ||
          typeof v.amountPaise !== 'string' || !/^\d{1,16}$/.test(v.amountPaise) ||
          !Number.isInteger(v.finalPaisePerKg) || !Number.isInteger(v.actualGrams) ||
          !Number.isInteger(v.estimatedGrams) || typeof v.collectedAt !== 'string' ||
          Number.isNaN(Date.parse(v.collectedAt)) ||
          (v.dispute !== null && v.dispute !== undefined)) throw Error('Invalid due');
        return { id: v.id, categoryName: v.categoryName, address,
          estimatedGrams: v.estimatedGrams, actualGrams: v.actualGrams,
          finalPaisePerKg: v.finalPaisePerKg, amountPaise: v.amountPaise, collectedAt: v.collectedAt };
      });
      // Same rule as the customer bridge: forward only a report that promises
      // nothing, because this build can send nothing.
      const reported = (data as { data: { notifications?: unknown } }).data.notifications;
      let notifications: { configured: boolean; channels: string[]; delivery: 'none' } | null = null;
      if (reported !== undefined) {
        if (!reported || typeof reported !== 'object' || Array.isArray(reported) ||
            (reported as Record<string, unknown>).configured !== false ||
            !Array.isArray((reported as Record<string, unknown>).channels) ||
            ((reported as Record<string, unknown>).channels as unknown[]).length !== 0 ||
            (reported as Record<string, unknown>).delivery !== 'none') throw Error('Invalid response');
        notifications = { configured: false, channels: [], delivery: 'none' };
      }
      payload = { data: { dues, notifications } };
    } else if (object(data) && object(data.error) && typeof data.error.code === 'string') {
      const messages: Record<string, [number, string]> = {
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'],
        FORBIDDEN: [403, 'Admin access is required.'],
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
