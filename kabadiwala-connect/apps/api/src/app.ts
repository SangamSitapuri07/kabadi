import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCustomerDetails } from './customer-details.js';
import type { CustomerDetails } from './customer-details.js';
import { PAYMENT_PROVIDER, PAYOUT_METHODS, isMissingCollectorColumns, isPayoutMethod, parsePickup } from './pickups.js';
import { NOTIFICATION_PROVIDER, isNotificationEvent } from './notifications.js';
import type { CancelOutcome, CollectorOutcome, CreatePickupResult, DisputeOutcome, PayoutOutcome, Pickup } from './pickups.js';
import { categoryName, rateValue, utcTimestamp } from './catalog.js';
import type { CategoryPage, RatePage } from './catalog.js';

type AuthMount = {
  origin: string;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  resolveIdentity?: (cookie?: string) => Promise<{ userId: string | null; cookies: string[] }>;
  onboardCustomer?: (userId: string) => Promise<'ready' | 'forbidden'>;
  pickups?: {
    create: (userId: string, input: unknown) => Promise<CreatePickupResult | 'forbidden'>;
    list: (userId: string) => Promise<Pickup[] | 'forbidden'>;
    cancel: (userId: string, requestId: string, reason: string | null) => Promise<CancelOutcome | 'forbidden'>;
    raiseDispute: (userId: string, requestId: string, reason: string) => Promise<DisputeOutcome | 'forbidden'>;
  };
  accountView?: { for: (actorId: string) => Promise<{ roles: string[]; active: boolean }> };
  // The upward supply chain: lots held, sold up a tier, and their custody
  // history. Absent when the separate lot migration has not run.
  lots?: {
    openFromPickup(actorId: string, raw: unknown): Promise<unknown>;
    held(actorId: string): Promise<unknown>;
    sell(actorId: string, raw: unknown): Promise<unknown>;
    history(actorId: string, lotId: string): Promise<unknown>;
  };
  notifications?: {
    list: (actorId: string) => Promise<{ items: unknown[]; unread: number } | 'forbidden'>;
    markRead: (actorId: string, id: string) => Promise<{ read: true } | 'not-found' | 'forbidden'>;
    markAllRead: (actorId: string) => Promise<{ cleared: number } | 'forbidden'>;
  };
  payouts?: {
    unpaidCollectorDues: (actorId: string) => Promise<Pickup[] | 'forbidden'>;
    recordPayout: (actorId: string, requestId: string, method: unknown, reference: unknown, note: unknown) => Promise<PayoutOutcome | 'forbidden'>;
  };
  disputes?: {
    openDisputes: (actorId: string) => Promise<Pickup[] | 'forbidden'>;
    resolveDispute: (actorId: string, requestId: string, grams: unknown) => Promise<DisputeOutcome | 'forbidden'>;
    rejectDispute: (actorId: string, requestId: string) => Promise<DisputeOutcome | 'forbidden'>;
  };
  collector?: {
    open: (userId: string) => Promise<Pickup[] | 'forbidden'>;
    mine: (userId: string) => Promise<Pickup[] | 'forbidden'>;
    accept: (userId: string, requestId: string) => Promise<CollectorOutcome | 'forbidden'>;
    collect: (userId: string, requestId: string, grams: unknown) => Promise<CollectorOutcome | 'forbidden'>;
    release: (userId: string, requestId: string) => Promise<CollectorOutcome | 'forbidden'>;
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
  // Cancellation and release extend the row without changing its money. They
  // are validated the same way: a reason only exists on a cancelled row.
  const terminalState = (r: Pickup) => {
    const iso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
    if (r.cancelledAt !== null && !iso(r.cancelledAt)) throw Error('Invalid result');
    if (r.releasedAt !== null && !iso(r.releasedAt)) throw Error('Invalid result');
    if (r.cancellationReason !== null && (r.status !== 'cancelled' || !text(r.cancellationReason, 200))) throw Error('Invalid result');
    if ((r.status === 'cancelled') !== (r.cancelledAt !== null)) throw Error('Invalid result');
    // A dispute exists only on a collected request, and only with a reason and a
    // timestamp; a resolved one always carries its resolution time.
    const d = r.dispute;
    if (d !== null) {
      if (r.status !== 'collected') throw Error('Invalid result');
      if (!['open', 'resolved', 'rejected'].includes(d.status)) throw Error('Invalid result');
      if (!text(d.reason, 200) || !iso(d.raisedAt)) throw Error('Invalid result');
      if ((d.status === 'open') !== (d.resolvedAt === null)) throw Error('Invalid result');
      if (d.resolvedAt !== null && !iso(d.resolvedAt)) throw Error('Invalid result');
    }
    // A payout only exists on a collected request, and always with a method and
    // a timestamp; a half-written receipt is corrupt, not "unpaid".
    const pay = r.payout;
    if (pay !== null) {
      if (r.status !== 'collected') throw Error('Invalid result');
      if (!isPayoutMethod(pay.method)) throw Error('Invalid result');
      if (typeof pay.amountPaise !== 'string' || !/^\d{1,16}$/.test(pay.amountPaise) || !iso(pay.paidAt)) throw Error('Invalid result');
    }
    return { cancelledAt: r.cancelledAt, cancellationReason: r.cancellationReason,
      releasedAt: r.releasedAt, dispute: d, payout: pay };
  };
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
        if (!address || !['requested','accepted','collected','cancelled'].includes(r.status) || typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt)) ||
            !Number.isInteger(r.estimatedGrams) || r.estimatedGrams < 1 || r.estimatedGrams > 10000000 || !uuid.test(r.id)) throw Error('Invalid result');
        const priced = r.categoryId !== null;
        if (priced) {
          if (!uuid.test(r.categoryId as string) || !text(r.categoryName, 100) || !uuid.test(r.rateId as string) ||
              !Number.isInteger(r.paisePerKg) || (r.paisePerKg as number) < 0 || (r.paisePerKg as number) > 1000000000 || !paise(r.amountPaise)) throw Error('Invalid result');
        } else if (r.material === null || !text(r.material, 100)) throw Error('Invalid result');
        // A collected request is only returned once it is fully settled; a
        // half-written settlement is treated as corrupt rather than priced.
        const settled = r.status !== 'collected' ? settledEmpty : fullySettled(r);
        const terminal = terminalState(r);
        return {
          id: r.id, status: r.status, createdAt: r.createdAt, address, estimatedGrams: r.estimatedGrams,
          material: r.material, categoryId: r.categoryId, categoryName: r.categoryName,
          rateId: r.rateId, paisePerKg: r.paisePerKg, amountPaise: r.amountPaise, ...settled, ...terminal,
        };
      });
      // `notifications` tells the customer screen that no message is coming.
      // It is reported by the server so the UI never has to assume either way.
      res.json({ data: { pickups: projected, notifications: NOTIFICATION_PROVIDER } });
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
  // A customer can challenge a settled amount. The settlement is not hidden or
  // changed while open; an admin later re-weighs and re-prices at the frozen
  // collection rate.
  app.post('/api/v1/customer/pickups/:requestId/dispute', (req, res, next) => {
    if (!auth?.resolveIdentity || !auth.pickups) { pickupUnavailable(res); return; }
    if (req.get('origin') !== auth.origin) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
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
      // A reason is required here, unlike cancellation: an admin has to know
      // what to check before they can decide anything.
      const keys = Object.keys(body);
      const reason = (body as Record<string, unknown>).reason;
      if (keys.length !== 1 || keys[0] !== 'reason' || !text(reason, 200)) {
        res.status(400).json({ error: { code: 'INVALID_REASON', message: 'A reason of 1 to 200 characters is required.' } }); return;
      }
      const result = await auth!.pickups!.raiseDispute(id, requestId, reason as string);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer access is required.' } }); return; }
      if (result.outcome === 'raised') { res.json({ data: { raised: true } }); return; }
      const failures: Record<'not-found' | 'not-collected' | 'already-open', [number, string, string]> = {
        'not-found': [404, 'REQUEST_NOT_FOUND', 'That request does not exist.'],
        'not-collected': [409, 'NOT_COLLECTED', 'Only a collected request can be disputed.'],
        'already-open': [409, 'DISPUTE_OPEN', 'A dispute is already open for this request.'],
      };
      const [status, code, message] = failures[result.outcome as 'not-found' | 'not-collected' | 'already-open'];
      res.status(status).json({ error: { code, message } });
    } catch (error) { if (isMissingCollectorColumns(error)) pickupNeedsMigration(res); else pickupUnavailable(res); }
  });

  // Cancelling is the customer's own action on their own request. It stops a
  // request from sitting open forever; it is not a dispute or a refund, and a
  // collected request can never be cancelled.
  app.post('/api/v1/customer/pickups/:requestId/cancel', (req, res, next) => {
    if (!auth?.resolveIdentity || !auth.pickups) { pickupUnavailable(res); return; }
    if (req.get('origin') !== auth.origin) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
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
      // An optional reason is bounded text; it is never required, because a
      // customer should not have to justify cancelling their own request.
      const keys = Object.keys(body);
      const rawReason = (body as Record<string, unknown>).reason;
      if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'reason')) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Only an optional reason is accepted.' } }); return;
      }
      if (keys.length === 1 && rawReason !== undefined && !text(rawReason, 200)) {
        res.status(400).json({ error: { code: 'INVALID_REASON', message: 'The reason must be 1 to 200 characters.' } }); return;
      }
      const reason = keys.length === 1 ? (rawReason as string) : null;
      const result = await auth!.pickups!.cancel(id, requestId, reason);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Customer access is required.' } }); return; }
      if (result.outcome === 'cancelled') { res.json({ data: { cancelled: true } }); return; }
      const failures: Record<'not-found' | 'already-cancelled' | 'already-collected', [number, string, string]> = {
        'not-found': [404, 'REQUEST_NOT_FOUND', 'That request does not exist.'],
        'already-cancelled': [409, 'ALREADY_CANCELLED', 'This request is already cancelled.'],
        'already-collected': [409, 'ALREADY_COLLECTED', 'A collected request cannot be cancelled.'],
      };
      const [status, code, message] = failures[result.outcome];
      res.status(status).json({ error: { code, message } });
    } catch (error) { if (isMissingCollectorColumns(error)) pickupNeedsMigration(res); else pickupUnavailable(res); }
  });
  // ---- Admin dispute handling -------------------------------------------
  // The admin grant is checked inside the store's transaction, not trusted from
  // the route, so a stale session cannot resolve anything.
  const disputeUnavailable = (res: express.Response) => res.status(503).json({ error: { code: 'DISPUTE_UNAVAILABLE', message: 'Dispute handling is unavailable.' } });
  const disputeNeedsMigration = (res: express.Response) => res.status(503).json({ error: { code: 'PICKUP_SCHEMA_OUTDATED', message: 'Pickup storage needs its migration before disputes can be handled.' } });
  app.use('/api/v1/admin/disputes', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/admin/disputes', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.disputes) { disputeUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const rows = await auth.disputes.openDisputes(id);
      if (rows === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access is required.' } }); return; }
      if (!Array.isArray(rows) || rows.length > 50) throw Error('Invalid result');
      const projected = (rows as Pickup[]).map(r => {
        const address = parseCustomerDetails(r.address);
        if (!address || r.status !== 'collected' || !uuid.test(r.id) || r.dispute === null || r.dispute.status !== 'open' ||
            typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt)) ||
            !Number.isInteger(r.estimatedGrams) || !uuid.test(r.categoryId as string) || !text(r.categoryName, 100)) throw Error('Invalid result');
        return { id: r.id, status: r.status, createdAt: r.createdAt, address, estimatedGrams: r.estimatedGrams,
          categoryId: r.categoryId, categoryName: r.categoryName, rateId: r.rateId,
          paisePerKg: r.paisePerKg, amountPaise: r.amountPaise, ...fullySettled(r), ...terminalState(r) };
      });
      res.json({ data: { disputes: projected } });
    } catch (error) { if (isMissingCollectorColumns(error)) disputeNeedsMigration(res); else disputeUnavailable(res); }
  });

  // Resolving accepts a corrected weight; rejecting keeps the settlement. Both
  // require an exact Origin, a bounded body and a UUID in the path.
  for (const action of ['resolve', 'reject'] as const) {
    app.post(`/api/v1/admin/disputes/:requestId/${action}`, (req, res, next) => {
      if (!auth?.resolveIdentity || !auth.disputes) { disputeUnavailable(res); return; }
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
        let result: DisputeOutcome | 'forbidden';
        if (action === 'reject') {
          if (keys.length !== 0) { res.status(400).json({ error: { code: 'INVALID_BODY', message: 'An empty JSON object is required.' } }); return; }
          result = await auth!.disputes!.rejectDispute(id, requestId);
        } else {
          const grams = (body as Record<string, unknown>).correctedGrams;
          if (keys.length !== 1 || keys[0] !== 'correctedGrams' || typeof grams !== 'number' ||
              !Number.isInteger(grams) || grams < 1 || grams > 10000000) {
            res.status(400).json({ error: { code: 'INVALID_WEIGHT', message: 'Corrected weight must be 1 to 10,000,000 grams.' } }); return;
          }
          result = await auth!.disputes!.resolveDispute(id, requestId, grams);
        }
        if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access is required.' } }); return; }
        if (result.outcome === 'resolved') {
          res.json({ data: { resolved: true, actualGrams: result.actualGrams,
            finalPaisePerKg: result.finalPaisePerKg, finalAmountPaise: result.finalAmountPaise } }); return;
        }
        if (result.outcome === 'rejected') { res.json({ data: { rejected: true } }); return; }
        const failures: Record<'not-found' | 'not-collected' | 'none-open' | 'same-weight', [number, string, string]> = {
          'not-found': [404, 'REQUEST_NOT_FOUND', 'That request does not exist.'],
          'not-collected': [409, 'NOT_COLLECTED', 'Only a collected request can be disputed.'],
          'none-open': [409, 'NO_OPEN_DISPUTE', 'There is no open dispute for this request.'],
          'same-weight': [409, 'SAME_WEIGHT', 'That is the weight already recorded; nothing to correct.'],
        };
        const [status, code, message] = failures[result.outcome as 'not-found' | 'not-collected' | 'none-open' | 'same-weight'];
        res.status(status).json({ error: { code, message } });
      } catch (error) { if (isMissingCollectorColumns(error)) disputeNeedsMigration(res); else disputeUnavailable(res); }
    });
  }

  // ---- Who am I -----------------------------------------------------------
  // The only endpoint that answers "which panels should this person see". It is
  // a display hint, never an authorization decision: every other route still
  // checks the grant it needs, so a tampered answer buys nothing.
  // Roles decide which panels appear, so a cached answer could show the wrong
  // set after a grant or revoke. Never cache it.
  app.use('/api/v1/account/roles', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/account/roles', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.accountView) {
      res.status(503).json({ error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account details are unavailable.' } }); return;
    }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const view = await auth.accountView.for(id);
      const roles = view.roles.filter(r => ['customer', 'collector', 'admin'].includes(r));
      res.json({ data: { roles, active: view.active === true } });
    } catch { res.status(503).json({ error: { code: 'ACCOUNT_UNAVAILABLE', message: 'Account details are unavailable.' } }); }
  });

  // ---- In-app notifications ---------------------------------------------
  // Every signed-in account reads its own; no role is required, because every
  // role receives some. Nothing here sends anything outside the application.
  const notifyUnavailable = (res: express.Response) => res.status(503).json({ error: { code: 'NOTIFICATION_UNAVAILABLE', message: 'Notifications are unavailable.' } });
  const notifyNeedsMigration = (res: express.Response) => res.status(503).json({ error: { code: 'PICKUP_SCHEMA_OUTDATED', message: 'Pickup storage needs its migration before notifications can be read.' } });

  app.use('/api/v1/notifications', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.get('/api/v1/notifications', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.notifications) { notifyUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const result = await auth.notifications.list(id);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Sign-in is required.' } }); return; }
      if (!Array.isArray(result.items) || result.items.length > 50) throw Error('Invalid result');
      // Re-validate every row: a message is rendered directly, so a malformed
      // one must not reach the screen.
      const items = result.items.map(v => {
        const n = v as Record<string, unknown>;
        if (!uuid.test(String(n?.id ?? '')) || !isNotificationEvent(n.event) ||
            !(n.requestId === null || uuid.test(String(n.requestId))) ||
            !(n.detail === null || text(n.detail, 200)) ||
            typeof n.createdAt !== 'string' || Number.isNaN(Date.parse(n.createdAt)) ||
            !(n.readAt === null || (typeof n.readAt === 'string' && !Number.isNaN(Date.parse(n.readAt))))) throw Error('Invalid result');
        return { id: n.id, event: n.event, requestId: n.requestId, detail: n.detail, createdAt: n.createdAt, readAt: n.readAt };
      });
      const unread = items.filter(i => i.readAt === null).length;
      if (!Number.isInteger(result.unread) || result.unread !== unread) throw Error('Invalid result');
      res.json({ data: { notifications: items, unread, delivery: NOTIFICATION_PROVIDER } });
    } catch (error) { if (isMissingCollectorColumns(error)) notifyNeedsMigration(res); else notifyUnavailable(res); }
  });

  // Acknowledging is scoped to the caller's own rows by the store, so an id
  // belonging to somebody else is simply not found.
  app.post('/api/v1/notifications/:notificationId/read', (req, res, next) => {
    if (!auth?.resolveIdentity || !auth.notifications) { notifyUnavailable(res); return; }
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
      const notificationId = req.params.notificationId;
      if (!uuid.test(notificationId)) { res.status(400).json({ error: { code: 'INVALID_NOTIFICATION_ID', message: 'Notification id is invalid.' } }); return; }
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'An empty JSON object is required.' } }); return;
      }
      const result = await auth!.notifications!.markRead(id, notificationId);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Sign-in is required.' } }); return; }
      if (result === 'not-found') { res.status(404).json({ error: { code: 'NOTIFICATION_NOT_FOUND', message: 'That notification does not exist.' } }); return; }
      res.json({ data: { read: true } });
    } catch (error) { if (isMissingCollectorColumns(error)) notifyNeedsMigration(res); else notifyUnavailable(res); }
  });

  app.post('/api/v1/notifications/read-all', (req, res, next) => {
    if (!auth?.resolveIdentity || !auth.notifications) { notifyUnavailable(res); return; }
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
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'An empty JSON object is required.' } }); return;
      }
      const result = await auth!.notifications!.markAllRead(id);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Sign-in is required.' } }); return; }
      res.json({ data: { cleared: result.cleared } });
    } catch (error) { if (isMissingCollectorColumns(error)) notifyNeedsMigration(res); else notifyUnavailable(res); }
  });

  // ---- Admin payout ledger ----------------------------------------------
  // Recording a payment is deliberately not part of collection: settling an
  // amount and moving money are different decisions, often by different people.
  const payoutUnavailable = (res: express.Response) => res.status(503).json({ error: { code: 'PAYOUT_UNAVAILABLE', message: 'Payout recording is unavailable.' } });
  const payoutNeedsMigration = (res: express.Response) => res.status(503).json({ error: { code: 'PICKUP_SCHEMA_OUTDATED', message: 'Pickup storage needs its migration before payouts can be recorded.' } });
  // Reference and note are bounded, trimmed free text or absent.
  const optionalText = (value: unknown, max: number): value is string | null =>
    value === null || value === undefined || text(value, max);

  app.use('/api/v1/admin/payouts', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/v1/admin/payouts', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.payouts) { payoutUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const rows = await auth.payouts.unpaidCollectorDues(id);
      if (rows === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access is required.' } }); return; }
      if (!Array.isArray(rows) || rows.length > 50) throw Error('Invalid result');
      const projected = (rows as Pickup[]).map(r => {
        const address = parseCustomerDetails(r.address);
        if (!address || r.status !== 'collected' || !uuid.test(r.id) || r.payout !== null ||
            typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt)) ||
            !uuid.test(r.categoryId as string) || !text(r.categoryName, 100)) throw Error('Invalid result');
        const settled = fullySettled(r);
        return { id: r.id, status: r.status, createdAt: r.createdAt, address,
          categoryId: r.categoryId, categoryName: r.categoryName, estimatedGrams: r.estimatedGrams,
          amountPaise: r.amountPaise, ...settled, ...terminalState(r) };
      });
      // `payment` tells the UI whether anything can actually move money. It is
      // a constant today: no provider is configured, and saying so in the
      // response keeps that fact out of the client's imagination.
      res.json({ data: { dues: projected, payment: { ...PAYMENT_PROVIDER, methods: PAYOUT_METHODS }, notifications: NOTIFICATION_PROVIDER } });
    } catch (error) { if (isMissingCollectorColumns(error)) payoutNeedsMigration(res); else payoutUnavailable(res); }
  });

  app.post('/api/v1/admin/payouts/:requestId/pay', (req, res, next) => {
    if (!auth?.resolveIdentity || !auth.payouts) { payoutUnavailable(res); return; }
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
      const allowed = ['method', 'reference', 'note'];
      if (keys.length < 1 || keys.some(k => !allowed.includes(k))) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'Only method, reference and note are accepted.' } }); return;
      }
      const { method, reference, note } = body as Record<string, unknown>;
      if (!isPayoutMethod(method)) {
        res.status(400).json({ error: { code: 'INVALID_METHOD', message: `Method must be one of: ${PAYOUT_METHODS.join(', ')}.` } }); return;
      }
      // No amount is accepted: the amount is whatever the settlement says.
      if (!optionalText(reference, 100) || !optionalText(note, 200)) {
        res.status(400).json({ error: { code: 'INVALID_DETAILS', message: 'Reference must be 1-100 and note 1-200 characters.' } }); return;
      }
      const result = await auth!.payouts!.recordPayout(id, requestId, method,
        reference === undefined ? null : reference, note === undefined ? null : note);
      if (result === 'forbidden') { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admin access is required.' } }); return; }
      if (result.outcome === 'paid') {
        res.json({ data: { paid: true, amountPaise: result.amountPaise, method: result.method } }); return;
      }
      const failures: Record<'not-found' | 'not-collected' | 'already-paid' | 'disputed', [number, string, string]> = {
        'not-found': [404, 'REQUEST_NOT_FOUND', 'That request does not exist.'],
        'not-collected': [409, 'NOT_COLLECTED', 'Only a collected request can be paid out.'],
        'already-paid': [409, 'ALREADY_PAID', 'This request has already been paid.'],
        'disputed': [409, 'DISPUTE_OPEN', 'An open dispute must be resolved before paying.'],
      };
      const [status, code, message] = failures[result.outcome];
      res.status(status).json({ error: { code, message } });
    } catch (error) { if (isMissingCollectorColumns(error)) payoutNeedsMigration(res); else payoutUnavailable(res); }
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
        if (!address || !['requested','accepted','collected','cancelled'].includes(r.status) || !uuid.test(r.id) ||
            typeof r.createdAt !== 'string' || Number.isNaN(Date.parse(r.createdAt)) ||
            !Number.isInteger(r.estimatedGrams) || r.estimatedGrams < 1 || r.estimatedGrams > 10000000) throw Error('Invalid result');
        if (r.categoryId === null) throw Error('Invalid result');
        if (!uuid.test(r.categoryId) || !text(r.categoryName, 100) || !uuid.test(r.rateId as string) ||
            !Number.isInteger(r.paisePerKg) || (r.paisePerKg as number) < 0 || (r.paisePerKg as number) > 1000000000 ||
            r.amountPaise === null || !paiseOk(r.amountPaise)) throw Error('Invalid result');
        const settled = r.status === 'collected' ? fullySettled(r) : settledEmpty;
        return { id: r.id, status: r.status, createdAt: r.createdAt, address, estimatedGrams: r.estimatedGrams,
          material: r.material, categoryId: r.categoryId, categoryName: r.categoryName,
          rateId: r.rateId, paisePerKg: r.paisePerKg, amountPaise: r.amountPaise, ...settled, ...terminalState(r) };
      });
      res.json({ data: { pickups: projected } });
    } catch (error) { if (isMissingCollectorColumns(error)) collectorNeedsMigration(res); else collectorUnavailable(res); }
  });

  // One guarded shape for both collector mutations: exact origin, bounded JSON,
  // then the session, then the store's own authorization and state checks.
  for (const action of ['accept', 'collect', 'release'] as const) {
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
        if (action === 'accept' || action === 'release') {
          if (keys.length !== 0) { res.status(400).json({ error: { code: 'INVALID_BODY', message: 'An empty JSON object is required.' } }); return; }
          result = action === 'accept'
            ? await auth!.collector!.accept(id, requestId)
            : await auth!.collector!.release(id, requestId);
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
        if (result.outcome === 'released') { res.json({ data: { released: true } }); return; }
        if (result.outcome === 'collected') {
          res.json({ data: { collected: true, actualGrams: result.actualGrams,
            finalPaisePerKg: result.finalPaisePerKg, finalAmountPaise: result.finalAmountPaise,
            finalRateId: result.finalRateId } });
          return;
        }
        const failures: Record<'not-found' | 'already-accepted' | 'not-accepted' | 'already-collected'
          | 'no-rate' | 'legacy-request' | 'own-request' | 'cancelled' | 'not-owner', [number, string, string]> = {
          'not-found': [404, 'REQUEST_NOT_FOUND', 'That request does not exist.'],
          'already-accepted': [409, 'ALREADY_ACCEPTED', 'Another collector already accepted this request.'],
          'not-accepted': [409, 'NOT_ACCEPTED', 'Accept this request before recording a collection.'],
          'already-collected': [409, 'ALREADY_COLLECTED', 'This request was already collected.'],
          'no-rate': [409, 'NO_RATE', 'No rate is in force for that category.'],
          'legacy-request': [409, 'LEGACY_REQUEST', 'Older free-text requests cannot be priced.'],
          'own-request': [409, 'OWN_REQUEST', 'A collector cannot accept their own request.'],
          'cancelled': [409, 'REQUEST_CANCELLED', 'The customer cancelled this request.'],
          'not-owner': [409, 'NOT_YOUR_CLAIM', 'Another collector holds this request.'],
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
  // ---------- upward supply chain (tiers 1-4) ----------
  app.use('/api/v1/lots', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const lotsUnavailable = (res: express.Response) =>
    res.status(503).json({ error: { code: 'LOTS_UNAVAILABLE', message: 'Lot storage is unavailable. Run the lot migration.' } });
  const lotForbidden = (res: express.Response) =>
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'An active supply-chain account is required.' } });
  // Same outcome vocabulary as the pickup routes: one code per real reason, so a
  // client never has to guess why a custody move was refused.
  const lotConflicts: Record<string, [number, string, string]> = {
    'not-found': [404, 'LOT_NOT_FOUND', 'No such lot.'],
    'not-holder': [403, 'NOT_HOLDER', 'This account is not holding that lot.'],
    'already-sold': [409, 'ALREADY_SOLD', 'That lot has already been sold.'],
    'not-collector': [403, 'NOT_COLLECTOR', 'Only a collector can take custody of a collected pickup.'],
    'pickup-not-collected': [409, 'PICKUP_NOT_COLLECTED', 'Only a collected pickup can become a lot.'],
    'pickup-already-lotted': [409, 'PICKUP_ALREADY_LOTTED', 'That pickup is already in custody as a lot.'],
    'not-a-chain-account': [403, 'NOT_A_CHAIN_ACCOUNT', 'This account holds no tier in the supply chain.'],
    'no-next-tier': [409, 'NO_NEXT_TIER', 'A recycler is the end of the chain: there is nothing to sell upward to.'],
    'buyer-not-next-tier': [409, 'NO_BUYER', 'No active account holds the next tier up.'],
    'buyer-same-account': [409, 'SAME_ACCOUNT', 'An account cannot buy its own lot.'],
    'invalid-weight': [400, 'INVALID_WEIGHT', 'That weight is more than the lot holds.'],
  };
  const lotOutcome = (res: express.Response, result: unknown): void => {
    if (result === 'forbidden') { lotForbidden(res); return; }
    if (result === 'not-found') { res.status(404).json({ error: { code: 'LOT_NOT_FOUND', message: 'No such lot.' } }); return; }
    const outcome = (result as { outcome: string }).outcome;
    if (outcome === 'opened' || outcome === 'sold') { res.json({ data: result }); return; }
    const mapped = lotConflicts[outcome];
    if (!mapped) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'That request was refused.' } }); return; }
    res.status(mapped[0]).json({ error: { code: mapped[1], message: mapped[2] } });
  };

  app.get('/api/v1/lots', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.lots) { lotsUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      if ([...new URL(req.url, 'http://x').searchParams.keys()].length) {
        res.status(400).json({ error: { code: 'INVALID_QUERY', message: 'The lot list takes no parameters.' } }); return;
      }
      const rows = await auth.lots.held(id);
      if (rows === 'forbidden') { lotForbidden(res); return; }
      res.json({ data: { lots: rows } });
    } catch { lotsUnavailable(res); }
  });

  app.get('/api/v1/lots/:lotId/history', async (req, res) => {
    if (!auth?.resolveIdentity || !auth.lots) { lotsUnavailable(res); return; }
    try {
      const id = await detailsAuth(req, res); if (id === null) return;
      const result = await auth.lots.history(id, req.params.lotId);
      if (result === 'forbidden') { lotForbidden(res); return; }
      if (result === 'not-found') { res.status(404).json({ error: { code: 'LOT_NOT_FOUND', message: 'No such lot.' } }); return; }
      res.json({ data: { sales: result } });
    } catch { lotsUnavailable(res); }
  });

  // Both mutations: exact origin, bounded body, session, then the store's own
  // grant and state checks inside its transaction.
  for (const [path, method] of [['/api/v1/lots', 'openFromPickup'], ['/api/v1/lots/sell', 'sell']] as const) {
    app.post(path, (req, res, next) => {
      if (!auth?.resolveIdentity || !auth.lots) { lotsUnavailable(res); return; }
      if (req.get('origin') !== auth!.origin) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Request origin is not allowed.' } }); return; }
      const length = req.get('content-length');
      if (!length || !/^\d+$/.test(length) || Number(length) > 4096 || req.get('transfer-encoding')) {
        res.status(413).json({ error: { code: 'INVALID_BODY', message: 'Request body is invalid or too large.' } }); return;
      }
      next();
    }, express.json({ limit: '4kb', strict: true }), async (req, res) => {
      try {
        const id = await detailsAuth(req, res); if (id === null) return;
        const store = auth!.lots!;
        const result = await (method === 'sell' ? store.sell(id, req.body) : store.openFromPickup(id, req.body));
        lotOutcome(res, result);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Invalid')) {
          res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'That request was not valid.' } }); return;
        }
        lotsUnavailable(res);
      }
    });
  }

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
