import { createApp } from './app.js';
import { createAuthRuntime, readAuthConfig } from './auth.js';
import { listenLocally } from './listen.js';

const rawPort = process.env.PORT ?? '4000';
if (!/^[0-9]+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
  console.error('PORT must be an integer between 1 and 65535.');
  process.exit(1);
}
const port = Number(rawPort);
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
let mount: Parameters<typeof createApp>[0];
try {
  const config = readAuthConfig(process.env);
  if (config) {
    runtime = createAuthRuntime(config);
    const status = await runtime.schemaStatus();
    if (status.missing || status.problems) throw new Error('Authentication schema is not ready.');
    mount = { origin: config.origin, handler: runtime.handler };
  }
} catch {
  console.error('Authentication could not start; check configuration and schema.');
  if (runtime) await runtime.close();
  process.exit(1);
}
const server = listenLocally(createApp(mount), port);
server.once('listening', () => {
  console.log(`API listening on port ${port} (loopback only)`);
});
server.on('error', async () => {
  console.error('API server failed to listen.');
  if (runtime) await runtime.close();
  process.exitCode = 1;
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async (error) => {
    if (error) { console.error('API shutdown failed.'); process.exitCode = 1; }
    if (runtime) {
      try { await runtime.close(); } catch { console.error('Authentication database shutdown failed.'); process.exitCode = 1; }
    }
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
