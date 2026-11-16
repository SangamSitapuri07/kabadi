import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';

type AuthMount = { origin: string; handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> };

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
