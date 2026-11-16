import { createAuthRuntime, readAuthConfig } from './auth.js';

// Deliberately separate from application startup. This changes the target DB.
if (process.env.AUTH_MIGRATION_CONFIRM !== 'yes') {
  console.error('Set AUTH_MIGRATION_CONFIRM=yes only for a disposable development database.');
  process.exit(1);
}
let runtime: ReturnType<typeof createAuthRuntime> | undefined;
try {
  const config = readAuthConfig(process.env);
  if (!config) throw new Error('Auth is disabled.');
  runtime = createAuthRuntime(config);
  await runtime.migrate();
  console.log('Authentication schema migration completed.');
} catch {
  console.error('Authentication migration failed; check the development configuration and database.');
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close();
}
