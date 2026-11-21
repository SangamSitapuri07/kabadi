// Narrow, read-only development catalog bridge. The API authorizes every read.
import { loadWorkspaceEnv } from '../../../../env';
const headers = {'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const unavailable = () => Response.json({error:{code:'CATALOG_UNAVAILABLE',message:'Catalog administration is unavailable.'}},{status:503,headers});
const invalid = () => Response.json({error:{code:'INVALID_CURSOR',message:'Category or catalog cursor is invalid.'}},{status:400,headers});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v:unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString() === v;
};
export async function readCatalog(request:Request, categoryId?:string) {
  try {
    const expected = new URL(process.env.AUTH_PUBLIC_ORIGIN ?? '');
    if (expected.origin !== process.env.AUTH_PUBLIC_ORIGIN || expected.username || expected.password || expected.pathname !== '/' || expected.search || expected.hash ||
      (expected.protocol !== 'https:' && !(expected.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(expected.hostname)))) return unavailable();
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(k=>k !== 'after') || query.getAll('after').length > 1 || (query.has('after') && !uuid.test(query.get('after') ?? '')) || (categoryId !== undefined && !uuid.test(categoryId))) return invalid();
    const internal = new URL(process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:4000');
    if (!['http:','https:'].includes(internal.protocol) || internal.username || internal.password || internal.pathname !== '/' || internal.search || internal.hash) return unavailable();
    const path = categoryId ? `/api/v1/admin/catalog/categories/${categoryId.toLowerCase()}/rates` : '/api/v1/admin/catalog/categories';
    const target = new URL(path, internal);
    if (query.has('after')) target.searchParams.set('after',query.get('after')!);
    const upstreamHeaders = new Headers();
    const cookie = request.headers.get('cookie'); if (cookie) upstreamHeaders.set('cookie',cookie);
    const upstream = await fetch(target,{headers:upstreamHeaders,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
    const data:unknown = await upstream.json(); let payload:object;
    if (upstream.status === 200 && object(data) && object(data.data)) {
      const page = data.data, next = page.nextAfter;
      if (next !== null && (typeof next !== 'string' || !uuid.test(next))) return unavailable();
      if (categoryId) {
        if (!Array.isArray(page.rates) || page.rates.length > 50) return unavailable();
        const rates = page.rates.map((v:unknown) => {
          if (!object(v) || typeof v.id !== 'string' || !uuid.test(v.id) || !timestamp(v.effectiveFrom) || typeof v.paisePerKg !== 'number' || !Number.isInteger(v.paisePerKg) || v.paisePerKg < 0 || v.paisePerKg > 1000000000) throw Error('Invalid rate');
          return {id:v.id,effectiveFrom:v.effectiveFrom,paisePerKg:v.paisePerKg};
        });
        payload={data:{rates,nextAfter:next}};
      } else {
        if (!Array.isArray(page.categories) || page.categories.length > 50) return unavailable();
        const categories = page.categories.map((v:unknown) => {
          if (!object(v) || typeof v.id !== 'string' || !uuid.test(v.id) || typeof v.name !== 'string' || !v.name.trim() || Array.from(v.name).length > 100 || /[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(v.name) || typeof v.active !== 'boolean') throw Error('Invalid category');
          return {id:v.id,name:v.name,active:v.active};
        });
        payload={data:{categories,nextAfter:next}};
      }
    } else if (object(data) && object(data.error) && typeof data.error.code === 'string') {
      const allowed:Record<string,[number,string]> = {SIGN_IN_REQUIRED:[401,'Sign-in is required.'],FORBIDDEN:[403,'Admin access is required.'],NOT_FOUND:[404,'Category not found.'],INVALID_CURSOR:[400,'Category or catalog cursor is invalid.'],CATALOG_UNAVAILABLE:[503,'Catalog administration is unavailable.']};
      const entry = allowed[data.error.code]; if (!entry || entry[0] !== upstream.status) return unavailable();
      payload={error:{code:data.error.code,message:entry[1]}};
    } else return unavailable();
    const out=new Headers(headers); for (const cookie of upstream.headers.getSetCookie()) out.append('set-cookie',cookie);
    return Response.json(payload,{status:upstream.status,headers:out});
  } catch { return unavailable(); }
}
