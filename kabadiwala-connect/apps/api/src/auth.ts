import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { createCustomerOnboarder } from './customer-onboarding.js';
import { createCustomerDetailsStore } from './customer-details.js';
import { createCollectorStore, createPickupStore } from './pickups.js';
import { createCatalogStore } from './catalog.js';

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
    // Better Auth errors can contain OAuth state and URLs. Keep diagnostics
    // intentionally generic until a reviewed redacting logger is available.
    logger: { level: 'warn' as const, log(level: string) { console.error(`Authentication library ${level}.`); } },
    database: pool,
    trustedOrigins: [config.origin],
    advanced: { disableOriginCheck: false, disableCSRFCheck: false, useSecureCookies: config.origin.startsWith('https://') },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    emailAndPassword: { enabled: false },
    socialProviders: { google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret } },
  };
  const auth = betterAuth(options);
  const nodeHandler = toNodeHandler(auth);
  // Server-only identity for future authorization. The caller must treat errors
  // as unavailable, not as anonymous, and never trust identity/roles from the
  // request body or headers. No role or account authorization is implied.
  async function resolveIdentity(cookie?: string): Promise<{ userId: string | null; cookies: string[] }> {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    const result = await auth.api.getSession({ headers, asResponse: true });
    if (!result.ok) throw new Error('Session lookup failed');
    const data: unknown = await result.json();
    if (data === null) return { userId: null, cookies: result.headers.getSetCookie() };
    if (typeof data !== 'object' || Array.isArray(data) || !('session' in data) || !('user' in data) ||
        !data.session || typeof data.session !== 'object' || Array.isArray(data.session) ||
        !data.user || typeof data.user !== 'object' || Array.isArray(data.user) ||
        !('id' in data.user) || typeof data.user.id !== 'string' || !data.user.id.trim() ||
        !('userId' in data.session) || data.session.userId !== data.user.id) {
      throw new Error('Invalid session response');
    }
    return { userId: data.user.id, cookies: result.headers.getSetCookie() };
  }
  return {
    resolveIdentity,
    onboardCustomer: createCustomerOnboarder(pool),
    customerDetails: createCustomerDetailsStore(pool),
    pickups: createPickupStore(pool),
    collector: createCollectorStore(pool),
    catalog: createCatalogStore(pool),
    async handler(request: IncomingMessage, response: ServerResponse) {
      // Better Auth's standard session response includes a bearer token. Even
      // direct API clients must receive only the minimal status, not that data.
      if (request.method !== 'GET' || request.url?.split('?')[0] !== '/api/auth/get-session') {
        return nodeHandler(request, response);
      }
      try {
        const identity = await resolveIdentity(request.headers.cookie);
        if (identity.cookies.length) response.setHeader('Set-Cookie', identity.cookies);
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ authenticated: identity.userId !== null }));
      } catch {
        response.statusCode = 503;
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ error: { code: 'AUTH_UNAVAILABLE', message: 'Sign-in is unavailable.' } }));
      }
    },
    async schemaStatus() {
      const migration = await getMigrations(options);
      return { missing: migration.toBeCreated.length + migration.toBeAdded.length + migration.toBeAddedIndexes.length, problems: migration.schemaProblems.length + migration.unsafeChanges.length };
    },
    async migrate() { const plan = await getMigrations(options); if (plan.schemaProblems.length || plan.unsafeChanges.length) throw new Error('Unsafe schema changes detected.'); await plan.runMigrations(); },
    close: () => pool.end(),
  };
}
