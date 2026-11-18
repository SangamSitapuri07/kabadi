import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCustomerDetails } from './customer-details.js';
import type { CustomerDetails } from './customer-details.js';

type AuthMount = {
  origin: string;
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  resolveIdentity?: (cookie?: string) => Promise<{ userId: string | null; cookies: string[] }>;
  onboardCustomer?: (userId: string) => Promise<'ready' | 'forbidden'>;
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
