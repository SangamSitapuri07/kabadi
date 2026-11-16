import type { Express } from 'express';

// The development API is internal to the machine running the web server.
// Do not expose it on a network interface; deployment topology needs review.
export function listenLocally(app: Express, port: number) {
  return app.listen(port, '127.0.0.1');
}
