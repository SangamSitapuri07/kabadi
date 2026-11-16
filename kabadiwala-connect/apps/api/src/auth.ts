import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import pg from 'pg';

export type AuthConfig = {
  origin: string;
  databaseURL: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
};

// No fallback credentials or dynamic request-derived origin. Never log values.
export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  if (env.AUTH_ENABLED === undefined || env.AUTH_ENABLED === 'false') return null;
  if (env.AUTH_ENABLED !== 'true') throw new Error('AUTH_ENABLED must be true or false.');
  if (env.NODE_ENV === 'production') throw new Error('Google auth is not yet enabled for production.');
  const { AUTH_PUBLIC_ORIGIN, DATABASE_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!AUTH_PUBLIC_ORIGIN || !DATABASE_URL || !BETTER_AUTH_SECRET || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google auth configuration is incomplete.');
  }
  let origin: URL;
  let database: URL;
  try { origin = new URL(AUTH_PUBLIC_ORIGIN); database = new URL(DATABASE_URL); }
  catch { throw new Error('Google auth configuration has invalid URLs.'); }
  const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]';
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== AUTH_PUBLIC_ORIGIN) {
    throw new Error('AUTH_PUBLIC_ORIGIN must be an exact HTTPS origin (or local HTTP origin).');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.pathname || database.pathname === '/') {
    throw new Error('DATABASE_URL must identify a PostgreSQL database.');
  }
  if (BETTER_AUTH_SECRET.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  return { origin: origin.origin, databaseURL: DATABASE_URL, secret: BETTER_AUTH_SECRET, googleClientId: GOOGLE_CLIENT_ID, googleClientSecret: GOOGLE_CLIENT_SECRET };
}

export function createAuthRuntime(config: AuthConfig) {
  const pool = new pg.Pool({ connectionString: config.databaseURL, max: 5, connectionTimeoutMillis: 5000 });
  // Idle client errors should not leak connection details or crash the process.
  pool.on('error', () => console.error('An idle authentication database connection failed.'));
  const options = {
    baseURL: config.origin,
    secret: config.secret,
    database: pool,
    trustedOrigins: [config.origin],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false, useSecureCookies: config.origin.startsWith('https://') },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    emailAndPassword: { enabled: false },
    socialProviders: { google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret } },
  };
  const auth = betterAuth(options);
  return {
    handler: toNodeHandler(auth),
    async schemaStatus() {
      const migration = await getMigrations(options);
      return { missing: migration.toBeCreated.length + migration.toBeAdded.length + migration.toBeAddedIndexes.length, problems: migration.schemaProblems.length + migration.unsafeChanges.length };
    },
    async migrate() { const plan = await getMigrations(options); if (plan.schemaProblems.length || plan.unsafeChanges.length) throw new Error('Unsafe schema changes detected.'); await plan.runMigrations(); },
    close: () => pool.end(),
  };
}
