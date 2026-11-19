import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCustomerDetails } from './customer-details.js';
import type { CustomerDetails } from './customer-details.js';
import { isMissingCollectorColumns, parsePickup } from './pickups.js';
import type { CollectorOutcome, CreatePickupResult, Pickup } from './pickups.js';
import { categoryName, rateValue, utcTimestamp } from './catalog.js';
import type { CategoryPage, RatePage } from './catalog.js';

type AuthMount = {
  origin: string;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  resolveIdentity?: (cookie?: string) => Promise<{ userId: string | null; cookies: string[] }>;
  onboardCustomer?: (userId: string) => Promise<'ready' | 'forbidden'>;
  pickups?: { create: (userId: string, input: unknown) => Promise<CreatePickupResult | 'forbidden'>; list: (userId: string) => Promise<Pickup[] | 'forbidden'> };
  collector?: {
    open: (userId: string) => Promise<Pickup[] | 'forbidden'>;
    mine: (userId: string) => Promise<Pickup[] | 'forbidden'>;
    accept: (userId: string, requestId: string) => Promise<CollectorOutcome | 'forbidden'>;
    collect: (userId: string, requestId: string, grams: unknown) => Promise<CollectorOutcome | 'forbidden'>;
  };
  catalog?: { listCategories: (actorId:string, after:string | null) => Promise<CategoryPage | 'forbidden'>; listRates: (actorId:string, categoryId:string, after:string | null) => Promise<RatePage | 'not-found' | 'forbidden'>; createCategory: (actorId: string, name: unknown, key:string) => Promise<{id:string} | 'duplicate' | 'conflict' | 'forbidden'>; addRate: (actorId: string, categoryId: string, effectiveFrom: unknown, rate: unknown, key:string) => Promise<{id:string} | 'invalid-time' | 'not-found' | 'conflict' | 'forbidden'> };
  customerDetails?: { read: (userId: string) => Promise<CustomerDetails | null | 'forbidden'>; write: (userId: string, input: unknown) => Promise<'saved' | 'forbidden'> };
};

// Bounded, already-trimmed user-visible text; rejects control characters.
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && Array.from(value).length <= max && !/[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(value);

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
  // A half-migrated database is an operator problem with a known fix, so it gets
  // its own code instead of the generic unavailable message.
  const pickupNeedsMigration = (res: express.Response) => res.status(503).json({ error: { code: 'PICKUP_SCHEMA_OUTDATED', message: 'Pickup storage needs its migration before requests can be read.' } });
  const settledEmpty = { actualGrams: null, finalRateId: null, finalPaisePerKg: null, finalAmountPaise: null, collectedAt: null };
  // The measured weight and the collection-time amount are the customer's
  // receipt, so every field is present together or the row is rejected.
  const fullySettled = (r: Pickup) => {
    if (!Number.isInteger(r.actualGrams) || (r.actualGrams as number) < 1 || (r.actualGrams as number) > 10000000 ||
        !uuid.test(r.finalRateId as string) || !Number.isInteger(r.finalPaisePerKg) ||
        (r.finalPaisePerKg as number) < 0 || (r.finalPaisePerKg as number) > 1000000000 ||
        typeof r.finalAmountPaise !== 'string' || !/^\d{1,16}$/.test(r.finalAmountPaise) ||
        typeof r.collectedAt !== 'string' || Number.isNaN(Date.parse(r.collectedAt))) throw Error('Invalid result');
    return { actualGrams: r.actualGrams, finalRateId: r.finalRateId, finalPaisePerKg: r.finalPaisePerKg,
      finalAmountPaise: r.finalAmountPaise, collectedAt: r.collectedAt };
  };
  app.use('/api/v1/customer/pickups', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/customer/pickups', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.pickups) { pickupUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const result = await auth.pickups.list(id);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer access is required.' } }); return; }
      if (!Array.isArray(result) || result.length > 50) throw Error('Invalid result');
      const paise = (value: unknown) => typeof value === 'string' && /^\d{1,16}$/.test(value) && BigInt(value) <= 10000000000000n;
      // Each stored row is re-validated so a malformed record cannot reach the
      // client, and the two shapes (priced item or legacy free text) stay apart.
      const projected = result.map(r => {
        const address = parseCustomerDetails(r.address);
        if (!address || !['requested','accepted','collected'].includes(r.status) || typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt)) ||
            !Number.isInteger(r.estimatedGrams) || r.estimatedGrams < 1 || r.estimatedGrams > 10000000 || !uuid.test(r.id)) throw Error('Invalid result');
        const priced = r.categoryId !== null;
        if (priced) {
          if (!uuid.test(r.categoryId as string) || !text(r.categoryName, 100) || !uuid.test(r.rateId as string) ||
              !Number.isInteger(r.paisePerKg) || (r.paisePerKg as number) < 0 || (r.paisePerKg as number) > 1000000000 || !paise(r.amountPaise)) throw Error('Invalid result');
        } else if (r.material === null || !text(r.material, 100)) throw Error('Invalid result');
        // A collected request is only returned once it is fully settled; a
        // half-written settlement is treated as corrupt rather than priced.
        const settled = r.status !== 'collected' ? settledEmpty : fullySettled(r);
        return {
          id: r.id, status: r.status, createdAt: r.createdAt, address, estimatedGrams: r.estimatedGrams,
          material: r.material, categoryId: r.categoryId, categoryName: r.categoryName,
          rateId: r.rateId, paisePerKg: r.paisePerKg, amountPaise: r.amountPaise, ...settled,
        };
      });
      res.json({ data: { pickups: projected } });
    } catch (error) { if (isMissingCollectorColumns(error)) pickupNeedsMigration(res); else pickupUnavailable(res); }
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
      if (result.outcome === 'missing-profile') { res.status(409).json({ error: { code: 'PROFILE_REQUIRED', message: 'Save customer details first.' } }); return; }
      if (result.outcome === 'conflict') { res.status(409).json({ error: { code: 'REQUEST_CONFLICT', message: 'This request key was already used.' } }); return; }
      if (result.outcome === 'unknown-category') { res.status(409).json({ error: { code: 'UNKNOWN_CATEGORY', message: 'That category is not available.' } }); return; }
      if (result.outcome === 'no-rate') { res.status(409).json({ error: { code: 'NO_RATE', message: 'No rate is active for that category yet.' } }); return; }
      if (result.outcome !== 'created' && result.outcome !== 'replayed') throw Error('Invalid result');
      const { estimate } = result;
      // The amount is computed by the server from a snapshotted rate; the client
      // cannot supply grams-per-rupee, a rate or an amount.
      if (!uuid.test(estimate.categoryId) || !text(estimate.categoryName, 100) || !uuid.test(estimate.rateId) ||
          !Number.isInteger(estimate.paisePerKg) || estimate.paisePerKg < 0 || estimate.paisePerKg > 1000000000 ||
          typeof estimate.amountPaise !== 'string' || !/^\d{1,16}$/.test(estimate.amountPaise)) throw Error('Invalid estimate');
      res.json({ data: { created: result.outcome === 'created', estimate } });
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
  // ---- Collector surface -------------------------------------------------
  // The actor always comes from the session; the store re-checks the collector
  // grant inside its transaction, so a browser cannot claim the role.
  app.use('/api/v1/collector/pickups', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const collectorUnavailable = (res: express.Response) =>
    res.status(503).json({ error: { code: 'COLLECTOR_UNAVAILABLE', message: 'Collector actions are unavailable.' } });
  const collectorNeedsMigration = (res: express.Response) =>
    res.status(503).json({ error: { code: 'PICKUP_SCHEMA_OUTDATED', message: 'Pickup storage needs its migration before the collector queue can be used.' } });

  app.get('/api/v1/collector/pickups', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.collector) { collectorUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const view = req.query.view;
      if (view !== 'open' && view !== 'mine') {
        res.status(400).json({ error: { code: 'INVALID_VIEW', message: 'View must be open or mine.' } }); return;
      }
      const rows = view === 'open' ? await auth.collector.open(id) : await auth.collector.mine(id);
      if (rows === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Collector access is required.' } }); return; }
      // Re-use the customer projection: a collector sees the same validated
      // address and money shape, never a raw stored row.
      const paiseOk = (value: unknown) => value === null || (typeof value === 'string' && /^\d{1,16}$/.test(value));
      const projected = (rows as Pickup[]).map(r => {
        const address = parseCustomerDetails(r.address);
        if (!address || !['requested','accepted','collected'].includes(r.status) || !uuid.test(r.id) ||
            typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt)) ||
            !Number.isInteger(r.estimatedGrams) || r.estimatedGrams < 1 || r.estimatedGrams > 10000000) throw Error('Invalid result');
        if (r.categoryId === null) throw Error('Invalid result');
        if (!uuid.test(r.categoryId) || !text(r.categoryName, 100) || !uuid.test(r.rateId as string) ||
            !Number.isInteger(r.paisePerKg) || (r.paisePerKg as number) < 0 || (r.paisePerKg as number) > 1000000000 ||
            r.amountPaise === null || !paiseOk(r.amountPaise)) throw Error('Invalid result');
        const settled = r.status === 'collected' ? fullySettled(r) : settledEmpty;
        return { id: r.id, status: r.status, createdAt: r.createdAt, address, estimatedGrams: r.estimatedGrams,
          material: r.material, categoryId: r.categoryId, categoryName: r.categoryName,
          rateId: r.rateId, paisePerKg: r.paisePerKg, amountPaise: r.amountPaise, ...settled };
      });
      res.json({ data: { pickups: projected } });
    } catch (error) { if (isMissingCollectorColumns(error)) collectorNeedsMigration(res); else collectorUnavailable(res); }
  });

  // One guarded shape for both collector mutations: exact origin, bounded JSON,
  // then the session, then the store's own authorization and state checks.
  for (const action of ['accept', 'collect'] as const) {
    app.post(`/api/v1/collector/pickups/:requestId/${action}`, (req, res, next) => {
      if (!auth?.resolveIdentity || !auth.collector) { collectorUnavailable(res); return; }
      if (req.get('origin') !== auth!.origin) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
      const length = req.get('content-length');
      if (!length || !/^\d+$/.test(length) || Number(length) > 4096 || req.get('transfer-encoding')) {
        res.status(413).json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' } }); return;
      }
      if (!req.is('application/json')) { res.status(415).json({ error: { code: 'INVALID_CONTENT_TYPE', message: 'JSON is required.' } }); return; }
      next();
    }, express.json({ limit: '4kb', strict: true }), async (req, res) => {
      try {
        const id = await detailsAuth(req, res); if (id === null) return;
        const requestId = req.params.requestId;
        if (!uuid.test(requestId)) { res.status(400).json({ error: { code: 'INVALID_REQUEST_ID', message: 'Request id is invalid.' } }); return; }
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          res.status(400).json({ error: { code: 'INVALID_BODY', message: 'A JSON object is required.' } }); return;
        }
        const keys = Object.keys(body);
        let result: CollectorOutcome | 'forbidden';
        if (action === 'accept') {
          if (keys.length !== 0) { res.status(400).json({ error: { code: 'INVALID_BODY', message: 'An empty JSON object is required.' } }); return; }
          result = await auth!.collector!.accept(id, requestId);
        } else {
          if (keys.length !== 1 || !('actualGrams' in body)) {
            res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Only actualGrams is accepted.' } }); return;
          }
          // The weight is validated before the store so a bad number is a clear
          // 400 rather than a sanitized upstream failure.
          const grams = (body as Record<string, unknown>).actualGrams;
          if (typeof grams !== 'number' || !Number.isInteger(grams) || grams < 1 || grams > 10000000) {
            res.status(400).json({ error: { code: 'INVALID_WEIGHT', message: 'Actual weight must be 1 to 10,000,000 grams.' } }); return;
          }
          result = await auth!.collector!.collect(id, requestId, grams);
        }
        if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Collector access is required.' } }); return; }
        if (result.outcome === 'accepted') { res.json({ data: { accepted: true } }); return; }
        if (result.outcome === 'collected') {
          res.json({ data: { collected: true, actualGrams: result.actualGrams,
            finalPaisePerKg: result.finalPaisePerKg, finalAmountPaise: result.finalAmountPaise,
            finalRateId: result.finalRateId } });
          return;
        }
        const failures: Record<'not-found' | 'already-accepted' | 'not-accepted' | 'already-collected' | 'no-rate' | 'legacy-request', [number, string, string]> = {
          'not-found': [404, 'REQUEST_NOT_FOUND', 'That request does not exist.'],
          'already-accepted': [409, 'ALREADY_ACCEPTED', 'Another collector already accepted this request.'],
          'not-accepted': [409, 'NOT_ACCEPTED', 'Accept this request before recording a collection.'],
          'already-collected': [409, 'ALREADY_COLLECTED', 'This request was already collected.'],
          'no-rate': [409, 'NO_RATE', 'No rate is in force for that category.'],
          'legacy-request': [409, 'LEGACY_REQUEST', 'Older free-text requests cannot be priced.'],
        };
        const [status, code, message] = failures[result.outcome];
        res.status(status).json({ error: { code, message } });
      } catch (error) { if (isMissingCollectorColumns(error)) collectorNeedsMigration(res); else collectorUnavailable(res); }
    });
  }

  app.post('/api/v1/admin/catalog/categories', catalogWrite, express.json({limit:'4kb',strict:true}), async (req, res) => {
    const body: unknown = req.body, key = req.get('idempotency-key');
    if (!key || !uuid.test(key)) { res.status(400).json({error:{code:'INVALID_KEY',message:'A valid idempotency key is required.'}}); return; }
    if (!record(body) || Object.keys(body).length !== 1 || !('name' in body) || !categoryName(body.name)) { res.status(400).json({error:{code:'INVALID_BODY',message:'Category is invalid.'}}); return; }
    try {
      const actor = await detailsAuth(req, res); if (actor === null) return;
      const result = await auth!.catalog!.createCategory(actor, body.name, key.toLowerCase());
      if (result === 'forbidden') { res.status(403).json({error:{code:'FORBIDDEN',message:'Admin access is required.'}}); return; }
      if (result === 'conflict') { res.status(409).json({error:{code:'KEY_CONFLICT',message:'This key was used for a different catalog write.'}}); return; }
      if (result === 'duplicate') { res.status(409).json({error:{code:'CATEGORY_EXISTS',message:'Category already exists.'}}); return; }
      if (!result || typeof result.id !== 'string' || !uuid.test(result.id)) throw Error('Invalid result');
      res.status(201).json({data:{id:result.id}});
    } catch { catalogUnavailable(res); }
  });
  app.post('/api/v1/admin/catalog/categories/:categoryId/rates', catalogWrite, express.json({limit:'4kb',strict:true}), async (req, res) => {
    const body: unknown = req.body, categoryId = req.params.categoryId, key = req.get('idempotency-key');
    if (!key || !uuid.test(key)) { res.status(400).json({error:{code:'INVALID_KEY',message:'A valid idempotency key is required.'}}); return; }
    if (typeof categoryId !== 'string' || !uuid.test(categoryId) || !record(body) || Object.keys(body).length !== 2 || !('effectiveFrom' in body) || !('paisePerKg' in body) || !utcTimestamp(body.effectiveFrom) || rateValue(body.paisePerKg) === null) { res.status(400).json({error:{code:'INVALID_BODY',message:'Rate is invalid.'}}); return; }
    try {
      const actor = await detailsAuth(req, res); if (actor === null) return;
      const result = await auth!.catalog!.addRate(actor, categoryId, body.effectiveFrom, body.paisePerKg, key.toLowerCase());
      if (result === 'forbidden') { res.status(403).json({error:{code:'FORBIDDEN',message:'Admin access is required.'}}); return; }
      if (result === 'not-found') { res.status(404).json({error:{code:'NOT_FOUND',message:'Category not found.'}}); return; }
      if (result === 'conflict') { res.status(409).json({error:{code:'KEY_CONFLICT',message:'This key was used for a different catalog write.'}}); return; }
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
