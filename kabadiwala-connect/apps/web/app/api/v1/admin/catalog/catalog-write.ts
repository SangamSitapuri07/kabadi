// Narrow, same-origin development bridge for admin catalog writes. It never
// decides authorization: the API checks the active admin grant inside its write
// transaction. This layer only refuses cross-site requests, bounds the body,
// forwards cookies and projects a limited response.
import { loadWorkspaceEnv } from '../../../../env';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers });
const unavailable = () => error(503, 'CATALOG_UNAVAILABLE', 'Catalog administration is unavailable.');
const invalid = (code: string, message: string) => error(400, code, message);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// Category names mirror the API's normalization so the browser cannot widen it.
function categoryName(input: unknown): string | null {
  if (typeof input !== 'string' || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(input)) return null;
  const value = input.trim();
  return value && Array.from(value).length <= 100 ? value : null;
}
function timestamp(input: unknown): string | null {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return null;
  const date = new Date(input);
  return Number.isFinite(date.getTime()) && date.toISOString() === input ? input : null;
}
const rateValue = (input: unknown): input is number => typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= 1_000_000_000;

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if ((request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { ok: false, response: error(415, 'INVALID_CONTENT_TYPE', 'JSON is required.') };
  }
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: invalid('INVALID_BODY', 'Catalog write is invalid.') };
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); return { ok: false, response: error(413, 'INVALID_BODY', 'Request body is invalid or too large.') }; }
    parts.push(value);
  }
  const raw = new Uint8Array(size); let offset = 0;
  for (const part of parts) { raw.set(part, offset); offset += part.length; }
  try { return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }; }
  catch { return { ok: false, response: invalid('INVALID_BODY', 'Catalog write is invalid.') }; }
}

export async function writeCatalog(request: Request, categoryId?: string) {
  try {
    const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN;
    if (!publicOrigin) return unavailable();
    const expected = new URL(publicOrigin);
    if (expected.origin !== publicOrigin || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(expected.hostname)))) return unavailable();
    // Refuse cross-site writes even when no cookies are present, and never
    // accept an origin taken from a forwarded header.
    if (request.headers.get('origin') !== expected.origin) return error(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
    const key = request.headers.get('idempotency-key');
    if (!key || !uuid.test(key)) return invalid('INVALID_KEY', 'A valid idempotency key is required.');
    if (categoryId !== undefined && !uuid.test(categoryId)) return invalid('INVALID_BODY', 'Category or rate is invalid.');

    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value;
    let payload: string;
    if (categoryId === undefined) {
      if (!object(body) || Object.keys(body).length !== 1 || !('name' in body)) return invalid('INVALID_BODY', 'Category is invalid.');
      const name = categoryName(body.name);
      if (!name) return invalid('INVALID_BODY', 'Category is invalid.');
      payload = JSON.stringify({ name });
    } else {
      if (!object(body) || Object.keys(body).length !== 2 || !('effectiveFrom' in body) || !('paisePerKg' in body)) return invalid('INVALID_BODY', 'Rate is invalid.');
      const at = timestamp(body.effectiveFrom);
      if (!at || !rateValue(body.paisePerKg)) return invalid('INVALID_BODY', 'Rate is invalid.');
      payload = JSON.stringify({ effectiveFrom: at, paisePerKg: body.paisePerKg });
    }

    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const target = new URL(categoryId === undefined ? '/api/v1/admin/catalog/categories' : `/api/v1/admin/catalog/categories/${categoryId.toLowerCase()}/rates`, internal);
    const upstreamHeaders = new Headers();
    upstreamHeaders.set('content-type', 'application/json');
    upstreamHeaders.set('origin', expected.origin);
    upstreamHeaders.set('idempotency-key', key.toLowerCase());
    const cookie = request.headers.get('cookie');
    if (cookie) upstreamHeaders.set('cookie', cookie);
    const upstream = await fetch(target, { method: 'POST', headers: upstreamHeaders, body: payload, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const data: unknown = await upstream.json();
    let out: object;
    if (upstream.status === 201 && object(data) && object(data.data) && typeof data.data.id === 'string' && uuid.test(data.data.id)) {
      out = { data: { id: data.data.id } };
    } else if (object(data) && object(data.error) && typeof data.error.code === 'string') {
      const allowed: Record<string, [number, string]> = {
        INVALID_BODY: [400, 'Catalog write is invalid.'], INVALID_KEY: [400, 'A valid idempotency key is required.'],
        SIGN_IN_REQUIRED: [401, 'Sign-in is required.'], FORBIDDEN: [403, 'Admin access is required.'],
        NOT_FOUND: [404, 'Category not found.'], KEY_CONFLICT: [409, 'This key was used for a different catalog write.'],
        CATEGORY_EXISTS: [409, 'That category already exists.'], INVALID_RATE_TIME: [409, 'Rate time must be in the future and later than existing rates.'],
        CATALOG_UNAVAILABLE: [503, 'Catalog administration is unavailable.'],
      };
      const entry = allowed[data.error.code];
      if (!entry || entry[0] !== upstream.status) return unavailable();
      out = { error: { code: data.error.code, message: entry[1] } };
    } else return unavailable();
    const responseHeaders = new Headers(headers);
    for (const refreshed of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', refreshed);
    return Response.json(out, { status: upstream.status, headers: responseHeaders });
  } catch { return unavailable(); }
}
