import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCustomerDetails } from './customer-details.js';
import type { CustomerDetails } from './customer-details.js';
import { parsePickup } from './pickups.js';
import type { Pickup } from './pickups.js';
import { categoryName, rateValue, utcTimestamp } from './catalog.js';
import type { CategoryPage, RatePage } from './catalog.js';

type AuthMount = {
  origin: string;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  resolveIdentity?: (cookie?: string) => Promise<{ userId: string | null; cookies: string[] }>;
  onboardCustomer?: (userId: string) => Promise<'ready' | 'forbidden'>;
  pickups?: { create: (userId: string, input: unknown) => Promise<'created' | 'missing-profile' | 'conflict' | 'forbidden'>; list: (userId: string) => Promise<Pickup[] | 'forbidden'> };
  catalog?: { listCategories: (actorId:string, after:string | null) => Promise<CategoryPage | 'forbidden'>; listRates: (actorId:string, categoryId:string, after:string | null) => Promise<RatePage | 'not-found' | 'forbidden'>; createCategory: (actorId: string, name: unknown) => Promise<{id:string} | 'duplicate' | 'forbidden'>; addRate: (actorId: string, categoryId: string, effectiveFrom: unknown, rate: unknown) => Promise<{id:string} | 'invalid-time' | 'not-found' | 'forbidden'> };
  customerDetails?: { read: (userId: string) => Promise<CustomerDetails | null | 'forbidden'>; write: (userId: string, input: unknown) => Promise<'saved' | 'forbidden'> };
};

// Never echo parser errors or unexpected exception messages to clients.
export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const type = typeof error === 'object' && error !== null && 'type' in error
    ? error.type
    : undefined;
  if (type === 'entity.parse.failed') {
    response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body.' } });
    return;
  }
  if (type === 'entity.too.large') {
    response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
    return;
  }
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' } });
};

export function createApp(auth?: AuthMount) {
  const app = express();
  app.disable('x-powered-by');
  // Narrow auth surface; mount before Express JSON parsing. Callback is a GET
  // from Google; every state-changing request requires the configured origin,
  // including when the browser has no existing cookies.
  app.all('/api/auth/*splat', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const permitted = (request.method === 'GET' && ['/api/auth/callback/google', '/api/auth/get-session'].includes(request.path)) ||
      (request.method === 'POST' && ['/api/auth/sign-in/social', '/api/auth/sign-out'].includes(request.path));
    if (!permitted) { response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }); return; }
    if (!auth) { response.status(503).json({ error: { code: 'AUTH_UNAVAILABLE', message: 'Sign-in is not configured.' } }); return; }
    if (request.method === 'POST') {
      if (request.get('origin') !== auth.origin) { response.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
      const length = request.get('content-length');
      if (!length || !/^\d+$/.test(length) || Number(length) > 8192 || request.get('transfer-encoding')) {
        response.status(413).json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' } }); return;
      }
      if (!request.is('application/json')) { response.status(415).json({ error: { code: 'INVALID_CONTENT_TYPE', message: 'JSON is required.' } }); return; }
    }
    await auth.handler(request, response);
  });
  // This one mutation uses a validated session ID, accepts no user/role fields,
  // and is separate from the Better Auth surface. No arbitrary account writes.
  app.post('/api/v1/account/customer', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!auth?.resolveIdentity || !auth.onboardCustomer) {
      response.status(503).json({ error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Customer setup is unavailable.' } }); return;
    }
    if (request.get('origin') !== auth.origin) {
      response.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return;
    }
    const length = request.get('content-length');
    if (!length || !/^\d+$/.test(length) || Number(length) > 1024 || request.get('transfer-encoding')) {
      response.status(413).json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' } }); return;
    }
    if (!request.is('application/json')) {
      response.status(415).json({ error: { code: 'INVALID_CONTENT_TYPE', message: 'JSON is required.' } }); return;
    }
    next();
  }, express.json({ limit: '1kb', strict: true }), async (request, response) => {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length !== 0) {
      response.status(400).json({ error: { code: 'INVALID_BODY', message: 'An empty JSON object is required.' } }); return;
    }
    try {
      // The first middleware already verified these dependencies exist.
      const identity = await auth!.resolveIdentity!(request.headers.cookie);
      if (!identity || !Array.isArray(identity.cookies) || !identity.cookies.every(cookie => typeof cookie === 'string') ||
          (identity.userId !== null && (typeof identity.userId !== 'string' || !identity.userId.trim()))) throw new Error('Invalid identity');
      if (identity.cookies.length) response.append('Set-Cookie', identity.cookies);
      if (identity.userId === null) {
        response.status(401).json({ error: { code: 'SIGN_IN_REQUIRED', message: 'Sign-in is required.' } }); return;
      }
      const result = await auth!.onboardCustomer!(identity.userId);
      if (result === 'forbidden') {
        response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer setup is not allowed.' } }); return;
      }
      if (result !== 'ready') throw new Error('Invalid onboarding result');
      response.json({ data: { customer: 'ready' } });
    } catch {
      response.status(503).json({ error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Customer setup is unavailable.' } });
    }
  });
  // No customer IDs are accepted in the URL, headers or body. The store also
  // checks current customer membership in the transaction for each operation.
  const detailsUnavailable = (response: express.Response) => response.status(503).json({ error: { code: 'DETAILS_UNAVAILABLE', message: 'Customer details are unavailable.' } });
  const detailsAuth = async (request: express.Request, response: express.Response): Promise<string | null> => {
    const identity = await auth!.resolveIdentity!(request.headers.cookie);
    if (!identity || !Array.isArray(identity.cookies) || !identity.cookies.every(cookie => typeof cookie === 'string') ||
        (identity.userId !== null && (typeof identity.userId !== 'string' || !identity.userId.trim()))) throw new Error('Invalid identity');
    if (identity.cookies.length) response.append('Set-Cookie', identity.cookies);
    if (identity.userId === null) { response.status(401).json({ error: { code: 'SIGN_IN_REQUIRED', message: 'Sign-in is required.' } }); return null; }
    return identity.userId;
  };
  const detailsForbidden = (response: express.Response) => response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer details are not available for this account.' } });
  app.use('/api/v1/account/customer/details', (_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/account/customer/details', async (request, response) => {
    if (!auth?.resolveIdentity || !auth.customerDetails) { detailsUnavailable(response); return; }
    try {
      const userId = await detailsAuth(request, response); if (userId === null) return;
      const result = await auth.customerDetails.read(userId);
      if (result === 'forbidden') { detailsForbidden(response); return; }
      const projected = result === null ? null : parseCustomerDetails(result);
      if (result !== null && !projected) throw new Error('Invalid stored details');
      response.json({ data: { details: projected } });
    } catch { detailsUnavailable(response); }
  });
  app.put('/api/v1/account/customer/details', (request, response, next) => {
    if (!auth?.resolveIdentity || !auth.customerDetails) { detailsUnavailable(response); return; }
    if (request.get('origin') !== auth.origin) { response.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
    const length = request.get('content-length');
    if (!length || !/^\d+$/.test(length) || Number(length) > 4096 || request.get('transfer-encoding')) {
      response.status(413).json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' } }); return;
    }
    if (!request.is('application/json')) { response.status(415).json({ error: { code: 'INVALID_CONTENT_TYPE', message: 'JSON is required.' } }); return; }
    next();
  }, express.json({ limit: '4kb', strict: true }), async (request, response) => {
    const details = parseCustomerDetails(request.body);
    if (!details) { response.status(400).json({ error: { code: 'INVALID_BODY', message: 'Customer details are invalid.' } }); return; }
    try {
      const userId = await detailsAuth(request, response); if (userId === null) return;
      const result = await auth!.customerDetails!.write(userId, details);
      if (result === 'forbidden') { detailsForbidden(response); return; }
      if (result !== 'saved') throw new Error('Invalid store result');
      response.json({ data: { saved: true } });
    } catch { detailsUnavailable(response); }
  });
  const pickupUnavailable = (res: express.Response) => res.status(503).json({ error: { code: 'PICKUP_UNAVAILABLE', message: 'Test pickup requests are unavailable.' } });
  app.use('/api/v1/customer/pickups', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/customer/pickups', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.pickups) { pickupUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const result = await auth.pickups.list(id);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer access is required.' } }); return; }
      if (!Array.isArray(result) || result.length > 50) throw Error('Invalid result');
      const projected = result.map(r => {
        const input = parsePickup({ requestKey: r.id, material: r.material, estimatedGrams: r.estimatedGrams });
        const address = parseCustomerDetails(r.address);
        if (!input || !address || r.status !== 'requested' || typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt))) throw Error('Invalid result');
        return { id:r.id, material:input.material, estimatedGrams:input.estimatedGrams, status:r.status, createdAt:r.createdAt, address };
      });
      res.json({ data: { pickups: projected } });
    } catch { pickupUnavailable(res); }
  });
  app.post('/api/v1/customer/pickups', (req, res, next) => {
    if (!auth?.resolveIdentity || !auth.pickups) { pickupUnavailable(res); return; }
    if (req.get('origin') !== auth.origin) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
    const length = req.get('content-length');
    if (!length || !/^\d+$/.test(length) || Number(length) > 4096 || req.get('transfer-encoding')) { res.status(413).json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' } }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: { code: 'INVALID_CONTENT_TYPE', message: 'JSON is required.' } }); return; }
    next();
  }, express.json({ limit:'4kb', strict:true }), async (req, res) => {
    const input = parsePickup(req.body);
    if (!input) { res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Test pickup request is invalid.' } }); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const result = await auth!.pickups!.create(id, input);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer access is required.' } }); return; }
      if (result === 'missing-profile') { res.status(409).json({ error: { code: 'PROFILE_REQUIRED', message: 'Save customer details first.' } }); return; }
      if (result === 'conflict') { res.status(409).json({ error: { code: 'REQUEST_CONFLICT', message: 'This request key was already used.' } }); return; }
      if (result !== 'created') throw Error('Invalid result');
      res.json({ data: { created: true } });
    } catch { pickupUnavailable(res); }
  });
  // Development-only admin writes. Identity comes exclusively from the session;
  // the catalog store checks the active admin grant inside the write transaction.
  // No route here provisions roles or bypasses catalog schema migration.
  const catalogUnavailable = (res: express.Response) => res.status(503).json({ error: { code:'CATALOG_UNAVAILABLE', message:'Catalog administration is unavailable.' } });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const catalogWrite: express.RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!auth?.resolveIdentity || !auth.catalog) { catalogUnavailable(res); return; }
    if (req.get('origin') !== auth.origin) { res.status(403).json({error:{code:'INVALID_ORIGIN',message:'Request origin is not allowed.'}}); return; }
    const length = req.get('content-length');
    if (!length || !/^\d+$/.test(length) || Number(length) > 4096 || req.get('transfer-encoding')) { res.status(413).json({error:{code:'INVALID_BODY',message:'Request body is invalid or too large.'}}); return; }
    if (!req.is('application/json')) { res.status(415).json({error:{code:'INVALID_CONTENT_TYPE',message:'JSON is required.'}}); return; }
    next();
  };
  // Pages are UUID-ordered, not a point-in-time snapshot. The cursor is an
  // opaque position, not a filter or authorization claim.
  const cursor = (query: express.Request['query']): string | null | undefined => {
    if (Object.keys(query).some(key => key !== 'after')) return undefined;
    if (query.after === undefined) return null;
    return typeof query.after === 'string' && uuid.test(query.after) ? query.after : undefined;
  };
  app.get('/api/v1/admin/catalog/categories', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!auth?.resolveIdentity || !auth.catalog) { catalogUnavailable(res); return; }
    const after = cursor(req.query);
    if (after === undefined) { res.status(400).json({error:{code:'INVALID_CURSOR',message:'Catalog cursor is invalid.'}}); return; }
    try {
      const actor = await detailsAuth(req,res); if (actor === null) return;
      const result = await auth.catalog.listCategories(actor, after);
      if (result === 'forbidden') { res.status(403).json({error:{code:'FORBIDDEN',message:'Admin access is required.'}}); return; }
      if (!result || !Array.isArray(result.categories) || result.categories.length > 50 || (result.nextAfter !== null && (typeof result.nextAfter !== 'string' || !uuid.test(result.nextAfter)))) throw Error('Invalid catalog page');
      const categories = result.categories.map(c => {
        if (!c || typeof c.id !== 'string' || !uuid.test(c.id) || !categoryName(c.name) || typeof c.active !== 'boolean') throw Error('Invalid category');
        return {id:c.id, name:c.name, active:c.active};
      });
      res.json({data:{categories,nextAfter:result.nextAfter}});
    } catch { catalogUnavailable(res); }
  });
  app.get('/api/v1/admin/catalog/categories/:categoryId/rates', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!auth?.resolveIdentity || !auth.catalog) { catalogUnavailable(res); return; }
    const after = cursor(req.query), categoryId = req.params.categoryId;
    if (after === undefined || typeof categoryId !== 'string' || !uuid.test(categoryId)) { res.status(400).json({error:{code:'INVALID_CURSOR',message:'Category or catalog cursor is invalid.'}}); return; }
    try {
      const actor = await detailsAuth(req,res); if (actor === null) return;
      const result = await auth.catalog.listRates(actor, categoryId, after);
      if (result === 'forbidden') { res.status(403).json({error:{code:'FORBIDDEN',message:'Admin access is required.'}}); return; }
      if (result === 'not-found') { res.status(404).json({error:{code:'NOT_FOUND',message:'Category not found.'}}); return; }
      if (!result || !Array.isArray(result.rates) || result.rates.length > 50 || (result.nextAfter !== null && (typeof result.nextAfter !== 'string' || !uuid.test(result.nextAfter)))) throw Error('Invalid rate page');
      const rates = result.rates.map(r => {
        if (!r || typeof r.id !== 'string' || !uuid.test(r.id) || !utcTimestamp(r.effectiveFrom) || rateValue(r.paisePerKg) === null) throw Error('Invalid rate');
        return {id:r.id,effectiveFrom:r.effectiveFrom,paisePerKg:r.paisePerKg};
      });
      res.json({data:{rates,nextAfter:result.nextAfter}});
    } catch { catalogUnavailable(res); }
  });
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  app.post('/api/v1/admin/catalog/categories', catalogWrite, express.json({limit:'4kb',strict:true}), async (req, res) => {
    const body: unknown = req.body;
    if (!record(body) || Object.keys(body).length !== 1 || !('name' in body) || !categoryName(body.name)) { res.status(400).json({error:{code:'INVALID_BODY',message:'Category is invalid.'}}); return; }
    try {
      const actor = await detailsAuth(req, res); if (actor === null) return;
      const result = await auth!.catalog!.createCategory(actor, body.name);
      if (result === 'forbidden') { res.status(403).json({error:{code:'FORBIDDEN',message:'Admin access is required.'}}); return; }
      if (result === 'duplicate') { res.status(409).json({error:{code:'CATEGORY_EXISTS',message:'Category already exists.'}}); return; }
      if (!result || typeof result.id !== 'string' || !uuid.test(result.id)) throw Error('Invalid result');
      res.status(201).json({data:{id:result.id}});
    } catch { catalogUnavailable(res); }
  });
  app.post('/api/v1/admin/catalog/categories/:categoryId/rates', catalogWrite, express.json({limit:'4kb',strict:true}), async (req, res) => {
    const body: unknown = req.body, categoryId = req.params.categoryId;
    if (typeof categoryId !== 'string' || !uuid.test(categoryId) || !record(body) || Object.keys(body).length !== 2 || !('effectiveFrom' in body) || !('paisePerKg' in body) || !utcTimestamp(body.effectiveFrom) || rateValue(body.paisePerKg) === null) { res.status(400).json({error:{code:'INVALID_BODY',message:'Rate is invalid.'}}); return; }
    try {
      const actor = await detailsAuth(req, res); if (actor === null) return;
      const result = await auth!.catalog!.addRate(actor, categoryId, body.effectiveFrom, body.paisePerKg);
      if (result === 'forbidden') { res.status(403).json({error:{code:'FORBIDDEN',message:'Admin access is required.'}}); return; }
      if (result === 'not-found') { res.status(404).json({error:{code:'NOT_FOUND',message:'Category not found.'}}); return; }
      if (result === 'invalid-time') { res.status(409).json({error:{code:'INVALID_RATE_TIME',message:'Rate time must be future and later than existing rates.'}}); return; }
      if (!result || typeof result.id !== 'string' || !uuid.test(result.id)) throw Error('Invalid result');
      res.status(201).json({data:{id:result.id}});
    } catch { catalogUnavailable(res); }
  });
  app.use(express.json({ limit: '32kb' }));

  // Liveness only: this does not check a database or report service readiness.
  app.get('/api/v1/health/live', (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ data: { status: 'alive', service: 'api' } });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
  });
  app.use(errorHandler);
  return app;
}
