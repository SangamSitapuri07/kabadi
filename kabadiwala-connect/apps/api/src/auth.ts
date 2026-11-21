import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { createCustomerOnboarder } from './customer-onboarding.js';
import { createCustomerDetailsStore } from './customer-details.js';
import { createAccountViewStore, createCollectorStore, createDisputeStore, createNotificationStore, createPayoutStore, createPickupStore } from './pickups.js';
import { createLotStore } from './lots.js';
import { createCatalogStore } from './catalog.js';

export type AuthConfig = {
  origin: string;
  databaseURL: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  // Development-only email sign-in. False unless explicitly enabled, and never
  // true in production -- it creates accounts with a password instead of
  // proving an identity through Google, which is not something a real user
  // should ever be able to do.
  devSignIn: boolean;
};

// No fallback credentials or dynamic request-derived origin. Never log values.
export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  if (env.AUTH_ENABLED === undefined || env.AUTH_ENABLED === 'false') return null;
  if (env.AUTH_ENABLED !== 'true') throw new Error('AUTH_ENABLED must be true or false.');
  // Checked before anything else reads it: a stray DEV_SIGNIN_ENABLED=yes in a
  // production environment must be a startup failure, not a quietly ignored
  // extra. Refusing loudly is the only safe direction for an auth back door.
  const devSignInRequested = env.DEV_SIGNIN_ENABLED === 'yes';
  if (env.DEV_SIGNIN_ENABLED !== undefined && env.DEV_SIGNIN_ENABLED !== 'yes' && env.DEV_SIGNIN_ENABLED !== 'false') {
    throw new Error('DEV_SIGNIN_ENABLED must be yes or false.');
  }
  if (devSignInRequested && env.NODE_ENV === 'production') {
    throw new Error('Development sign-in cannot be enabled in production.');
  }
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
  // A password account on a remotely reachable origin is a production-grade
  // authentication surface with development-grade guarantees. Refuse it.
  if (devSignInRequested && !local) {
    throw new Error('Development sign-in is only allowed on a local origin.');
  }
  return { origin: origin.origin, databaseURL: DATABASE_URL, secret: BETTER_AUTH_SECRET,
    googleClientId: GOOGLE_CLIENT_ID, googleClientSecret: GOOGLE_CLIENT_SECRET, devSignIn: devSignInRequested };
}

// Development-only sign-in. Creates an account with a password so three test
// identities can exist without three Google accounts, then signs it in and
// returns the session cookies.
//
// Every guard here exists because this function is, by construction, the one
// place in the system that will make up an identity:
//   * only when the validated config allowed it, which refuses production and
//     any non-local origin;
//   * only for an @example.test address, which is a reserved testing domain and
//     cannot be a real person's mailbox;
//   * only to CREATE an account. An existing address is rejected, not signed
//     into, so this cannot be used as a password on somebody else's account;
//   * Better Auth's own sign-up is disabled, so this route is the only path.
const DEV_EMAIL = /^[a-z0-9][a-z0-9._-]{0,63}@example\.test$/;
const DEV_PASSWORD_MIN = 12;
const DEV_PASSWORD_MAX = 200;

export type DevSignInResult =
  | { outcome: 'created'; cookies: string[] }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' }
  | { outcome: 'exists' };

export function createDevSignIn(config: AuthConfig, signUpEmail: (input: { email: string; password: string; name: string }) => Promise<Response>) {
  return async function devSignIn(input: unknown): Promise<DevSignInResult> {
    if (!config.devSignIn) return { outcome: 'unavailable' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { outcome: 'invalid' };
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).length !== 2) return { outcome: 'invalid' };
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    if (!DEV_EMAIL.test(email)) return { outcome: 'invalid' };
    // Length only. Complexity rules push people towards predictable
    // substitutions and are not a meaningful defence on a local test account.
    if (password.length < DEV_PASSWORD_MIN || password.length > DEV_PASSWORD_MAX) return { outcome: 'invalid' };
    if (/[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(password)) return { outcome: 'invalid' };
    try {
      // A fixed display name: this is a test identity, not a person, and a name
      // field would be another value to validate for no benefit.
      const result = await signUpEmail({ email, password, name: email.split('@')[0]! });
      const cookies = result.headers.getSetCookie();
      if (!result.ok) {
        // Better Auth answers 422 for an address that already exists. It is
        // reported as such and never falls back to signing in, so a wrong
        // password cannot become a session.
        const status = result.status;
        return status === 422 || status === 400 ? { outcome: 'exists' } : { outcome: 'unavailable' };
      }
      return { outcome: 'created', cookies };
    } catch { return { outcome: 'unavailable' }; }
  };
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
    // Off unless the config above allowed it, and the config refuses production
    // and any non-local origin. Sign-up must be ENABLED for the development route
    // to work at all -- Better Auth answers EMAIL_PASSWORD_SIGN_UP_DISABLED
    // otherwise -- so the guard is not this flag. It is the handler below, which
    // answers only a fixed set of paths and refuses everything else, including
    // Better Auth's own sign-up endpoint.
    emailAndPassword: { enabled: config.devSignIn, disableSignUp: !config.devSignIn },
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
  // The route calls Better Auth's own sign-up through the server SDK, not
  // through HTTP, so the request never leaves the process.
  const devSignIn = createDevSignIn(config, async ({ email, password, name }) => {
    const result = await auth.api.signUpEmail({ body: { email, password, name }, asResponse: true });
    return result;
  });
  return {
    resolveIdentity,
    devSignIn,
    onboardCustomer: createCustomerOnboarder(pool),
    customerDetails: createCustomerDetailsStore(pool),
    pickups: createPickupStore(pool),
    collector: createCollectorStore(pool),
    disputes: createDisputeStore(pool),
    payouts: createPayoutStore(pool),
    notifications: createNotificationStore(pool),
    accountView: createAccountViewStore(pool),
    lots: createLotStore(pool),
    catalog: createCatalogStore(pool),
    async handler(request: IncomingMessage, response: ServerResponse) {
      // Development sign-in is enabled by making Better Auth accept passwords,
      // which also makes its own sign-up endpoint live. That endpoint must never
      // be reachable: the development route is the only path, because it is the
      // only one that restricts addresses to @example.test. Without this, anyone
      // could register any address on a local dev server.
      if (config.devSignIn) {
        const path = request.url?.split('?')[0] ?? '';
        // Exactly the endpoints the app itself calls. Everything else is refused,
        // which is the point: Better Auth's own sign-up endpoint accepts any
        // address, and the guarded route is the only path allowed to create one.
        const allowed = (request.method === 'GET' &&
            ['/api/auth/get-session', '/api/auth/callback/google'].includes(path)) ||
          (request.method === 'POST' &&
            ['/api/auth/sign-out', '/api/auth/sign-in/social'].includes(path));
        if (!allowed) {
          response.statusCode = 404;
          response.setHeader('content-type', 'application/json');
          response.setHeader('cache-control', 'no-store');
          response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No such authentication endpoint.' } }));
          return;
        }
      }
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
