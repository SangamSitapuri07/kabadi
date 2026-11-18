// Narrow same-origin bridge, never a general API proxy. Do not log profile data.
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'DETAILS_UNAVAILABLE', 'Customer details are unavailable.');
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
async function handle(request: Request, method: 'GET' | 'PUT') {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    let body: string | undefined;
    if (method === 'PUT') {
      if (request.headers.get('origin') !== expected.origin) return error(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
      if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return error(415, 'INVALID_CONTENT_TYPE', 'JSON is required.');
      const reader = request.body?.getReader();
      if (!reader) return error(400, 'INVALID_BODY', 'Customer details are invalid.');
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
      catch { return error(400, 'INVALID_BODY', 'Customer details are invalid.'); }
      const details = project(input, true);
      if (!details) return error(400, 'INVALID_BODY', 'Customer details are invalid.');
      body = JSON.stringify(details);
    }
    const origin = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return unavailable();
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie');
    if (cookie) upstreamHeaders.set('cookie', cookie);
    if (method === 'PUT') { upstreamHeaders.set('content-type', 'application/json'); upstreamHeaders.set('origin', expected.origin); }
    const upstream = await fetch(new URL('/api/v1/account/customer/details', origin), {
      method, headers: upstreamHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    const data: unknown = await upstream.json();
    let payload: object;
    if (upstream.status === 200 && data && typeof data === 'object' && 'data' in data && data.data && typeof data.data === 'object') {
      if (method === 'PUT' && 'saved' in data.data && data.data.saved === true) payload = { data: { saved: true } };
      else if (method === 'GET' && 'details' in data.data) {
        const details = data.data.details === null ? null : project(data.data.details, false);
        if (data.data.details !== null && !details) return unavailable();
        payload = { data: { details } };
      } else return unavailable();
    } else if ([400, 401, 403, 503].includes(upstream.status) && data && typeof data === 'object' && 'error' in data && data.error &&
        typeof data.error === 'object' && 'code' in data.error &&
        data.error.code === ({ 400: 'INVALID_BODY', 401: 'SIGN_IN_REQUIRED', 403: 'FORBIDDEN', 503: 'DETAILS_UNAVAILABLE' } as Record<number, string>)[upstream.status]) {
      payload = { error: { code: data.error.code, message: ({ 400: 'Customer details are invalid.', 401: 'Sign-in is required.', 403: 'Customer details are not available for this account.', 503: 'Customer details are unavailable.' } as Record<number, string>)[upstream.status] } };
    } else return unavailable();
    const out = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) out.append('set-cookie', refreshed);
    return Response.json(payload, { status: upstream.status, headers: out });
  } catch { return unavailable(); }
}
export function GET(request: Request) { return handle(request, 'GET'); }
export function PUT(request: Request) { return handle(request, 'PUT'); }
