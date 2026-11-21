import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { toNodeHandler } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { createCustomerOnboarder } from './customer-onboarding.js';
import { createCustomerDetailsStore } from './customer-details.js';
import { createAccountViewStore, createCollectorStore, createDisputeStore, createNotificationStore, createPayoutStore, createPickupStore } from './pickups.js';
import { createLotStore } from './lots.js';
import { createDevProvisioner } from './dev-provision.js';
import type { Role } from './account-store.js';
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

// Development-only test identities: create one, or sign back in to one that
// already exists. Google is the only real provider; this exists so the supply
// chain can be walked without several Google accounts.
//
// Every guard here exists because this function is, by construction, the one
// place in the system that will make up an identity:
//   * only when the validated config allowed it, which refuses production and
//     any non-local origin;
//   * only for an @example.test address, which is a reserved testing domain and
//     cannot be a real person's mailbox;
//   * creating never signs an existing address in -- it reports that the address
//     is taken, so a mistyped role cannot quietly become a login;
//   * signing in requires the password Better Auth stored at creation, so it is
//     an ordinary login for an account on this machine, not a bypass;
//   * Better Auth's own sign-up and sign-in endpoints are both refused, so this
//     route is the only path.
const DEV_EMAIL = /^[a-z0-9][a-z0-9._-]{0,63}@example\.test$/;
const DEV_PASSWORD_MIN = 12;
const DEV_PASSWORD_MAX = 200;

export type DevSignInResult =
  | { outcome: 'created'; cookies: string[]; role: Role }
  | { outcome: 'signed-in'; cookies: string[] }
  // The auth user exists but holds no role, so every authorized route would
  // refuse it. Reported rather than signed in: a session that can see nothing
  // is a puzzle, not a result.
  | { outcome: 'unprovisioned' }
  // Wrong email or password. Deliberately one outcome for both: which half was
  // wrong is not information this route gives away.
  | { outcome: 'credentials' }
  | { outcome: 'unavailable' }
  | { outcome: 'invalid' }
  | { outcome: 'exists' };

// The roles a test identity can be created as. `admin` is deliberately absent:
// this form exists to walk the supply chain, and an operator role is granted by
// the local role tool with a recorded reason, never by a public form.
const DEV_ROLES: readonly Role[] = ['customer', 'collector', 'shop', 'mandi', 'recycler'];

type DevDeps = {
  signUpEmail: (input: { email: string; password: string; name: string }) => Promise<Response>;
  signInEmail: (input: { email: string; password: string }) => Promise<Response>;
  provision: (userId: string, role: Role) => Promise<'ready' | 'forbidden' | 'taken'>;
  // The roles the account holds, read after sign-in. An empty list means the
  // auth user exists but was never given an application account.
  rolesOf: (userId: string) => Promise<string[]>;
};

// The user id of a sign-up/sign-in response, which Better Auth returns as
// `{ token, user: { id } }`. Read here and never accepted from the caller, so the
// account being acted on is always the one Better Auth just authenticated.
async function responseUserId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    const user = body && typeof body === 'object' ? (body as { user?: { id?: unknown } }).user : undefined;
    return user && typeof user.id === 'string' && user.id.trim() ? user.id : null;
  } catch { return null; }
}

export function createDevSignIn(config: AuthConfig, deps: DevDeps) {
  const { signUpEmail, signInEmail, provision, rolesOf } = deps;
  return async function devSignIn(input: unknown): Promise<DevSignInResult> {
    if (!config.devSignIn) return { outcome: 'unavailable' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { outcome: 'invalid' };
    const raw = input as Record<string, unknown>;
    // An explicit action, not an inferred one. If the form simply forgot to
    // choose, that must be a rejected request rather than a silent attempt to
    // sign in to an account nobody asked to sign in to.
    const action = raw.action;
    if (action !== 'create' && action !== 'sign-in') return { outcome: 'invalid' };
    // Exact keys: nothing a caller adds is silently ignored, so a smuggled
    // `admin` cannot ride along unnoticed.
    const expected = action === 'create' ? ['action', 'email', 'password', 'role'] : ['action', 'email', 'password'];
    const keys = Object.keys(raw);
    if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) return { outcome: 'invalid' };
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    if (!DEV_EMAIL.test(email)) return { outcome: 'invalid' };
    // Length only. Complexity rules push people towards predictable
    // substitutions and are not a meaningful defence on a local test account.
    if (password.length < DEV_PASSWORD_MIN || password.length > DEV_PASSWORD_MAX) return { outcome: 'invalid' };
    if (/[\uD800-\uDFFF\u0000-\u001f\u007f-\u009f]/u.test(password)) return { outcome: 'invalid' };

    if (action === 'sign-in') {
      try {
        // Better Auth verifies the stored hash. A wrong password is a 401 here,
        // and it never falls back to creating anything.
        const result = await signInEmail({ email, password });
        const cookies = result.headers.getSetCookie();
        if (!result.ok) return result.status === 401 ? { outcome: 'credentials' } : { outcome: 'unavailable' };
        const userId = await responseUserId(result);
        if (!userId) return { outcome: 'unavailable' };
        // Signing in to an identity with no role would land on a page that can
        // do nothing, which reads as a bug. Say what is actually wrong instead.
        const roles = await rolesOf(userId);
        if (!Array.isArray(roles) || roles.length === 0) return { outcome: 'unprovisioned' };
        return { outcome: 'signed-in', cookies };
      } catch { return { outcome: 'unavailable' }; }
    }

    const role = raw.role;
    if (typeof role !== 'string' || !(DEV_ROLES as readonly string[]).includes(role)) return { outcome: 'invalid' };
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
      // The new user's id is read from the response, never taken from the body.
      const userId = await responseUserId(result);
      if (!userId) return { outcome: 'unavailable' };
      // The user now exists but has no account row, so every autorized route
      // would refuse it and the role tool would reject it. Provisioning is part
      // of creation, not a step the operator has to remember: the account and its
      // chosen role are created together, and the role is the one selected here,
      // never inferred from the email.
      const provisioned = await provision(userId, role as Role);
      // A taken address must not leave a half-made identity behind: the sign-up
      // above already created the auth user, and reporting success would be a lie.
      if (provisioned !== 'ready') return { outcome: provisioned === 'taken' ? 'exists' : 'unavailable' };
      return { outcome: 'created', cookies, role: role as Role };
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
  // The route calls Better Auth through the server SDK, not through HTTP, so the
  // request never leaves the process. Password sign-in is the same code path a
  // real email/password login would use: the stored hash decides, not the route.
  const accountView = createAccountViewStore(pool);
  const devSignIn = createDevSignIn(config, {
    signUpEmail: async ({ email, password, name }) =>
      await auth.api.signUpEmail({ body: { email, password, name }, asResponse: true }),
    signInEmail: async ({ email, password }) =>
      await auth.api.signInEmail({ body: { email, password }, asResponse: true }),
    provision: createDevProvisioner(pool),
    rolesOf: async userId => (await accountView.for(userId)).roles,
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
    accountView,
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
