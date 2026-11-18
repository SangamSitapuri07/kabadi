# Kabadiwala Connect

Independent greenfield workspace for the web-first recycling marketplace. It
does not use the legacy applications in the parent repository. Notion is the
primary planning and progress record.

## Setup and verification

Node.js 22 or newer and npm are required. No accounts, secrets, paid services or
database are needed for the current web foundation. From this directory:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run typecheck:web
npm run build:web
npm run typecheck:api
npm run test:api
npm run test:connection
```

`test:connection` requires the API and web builds from the preceding commands;
it starts and stops its own temporary web and API processes using local ports.

Start the web preview with `npm run start:web` after building it. To start the
API separately, run `npm run build:api` and `npm run start:api`; `PORT` defaults
to 4000. The placeholder links to the relative `/api/v1/health/live` URL. The
web server forwards only that liveness check to the API and returns a sanitized
503 when it cannot verify a response. Liveness is not database or marketplace
readiness; this is not a general-purpose API proxy or business integration.

The web server's `API_INTERNAL_ORIGIN` environment variable optionally specifies
an HTTP(S) API origin (no credentials, path, query or fragment); it defaults to
`http://127.0.0.1:4000` on the web server, not in the browser. If changing the
API port, set it before starting the web server, for example
`API_INTERNAL_ORIGIN=http://127.0.0.1:4001 npm run start:web`. Configure trusted
server-side origins only. Network access, TLS, and deployment topology need
separate review before production; these local defaults are not a deployment plan.

With the web server running, use another terminal to run `npm run test:web:smoke`.
It defaults to `http://127.0.0.1:3000`; set `WEB_BASE_URL` to test a different
local server. For development use `npm run dev:web` instead of the production
build/start commands. The web scripts bind to `0.0.0.0` for preview access;
restrict web network access appropriately when running locally. The development
API binds only to IPv4 loopback (`127.0.0.1`) and must run on the same machine as
the web server. This limits network exposure, but does not protect it from other
local processes or replace authentication, authorization, or a firewall. The
development origin configuration allows preview subdomains under `e2b.app`; it
is not a production security policy.

The isolated lockfile pins Next.js 16.4.6, React/React DOM 19.3.1, Express
5.3.0, TypeScript 7.0.2, and corresponding type packages. The npm registry
lists Node >=20.9 and React ^19 for this Next version and Node >=18 for Express;
this combination has been tested on Node 22.22.3 and npm 10.9.8, not every
supported environment. Future Prisma/Vitest candidates have narrower Node
requirements than this workspace's current `>=22` baseline; align and retest
that requirement before adding them.

On 14 November 2026, clean `npm ci --ignore-scripts --no-audit --no-fund`,
environment check, 3/3 environment unit tests, TypeScript check and Next
production build passed. Starting the production server and the web smoke test
also passed with HTTP 200 and the expected placeholder text. An initial build
failed because Turbopack's root excluded the workspace dependencies; setting it
to this workspace root fixed the build. These checks do not prove application
or security readiness. On the same date, after the API was added, a fresh npm
install, environment check, 3 environment tests, 5 API HTTP tests, API/web
typechecks, web production build and web smoke test passed. The API also started
on port 4000 and passed a liveness smoke check; invalid `PORT=0` exited with an
error. No application database integration was tested. Later the same day,
the environment check, 3 unit tests, 5 API tests, both typechecks, web build,
and same-origin liveness integration test passed. The latter starts real web
and API processes, checks the relative link and successful response, then tests
an unavailable and invalid upstream, field filtering and redirect rejection.
It is an HTTP integration test, not an automated browser or security audit.

### Isolated database investigation (14 November 2026)

A disposable, synthetic-only PostgreSQL 18.6 instance was started as a non-root
user on 127.0.0.1, using the npm `embedded-postgres@18.6.0-beta.19` package
and `pg@8.23.1`. A temporary table was created, a row inserted and queried,
a duplicate unique value rejected (SQLSTATE 23505), and a transaction rolled
back successfully. The server was stopped after the test. This beta embedded
package was used only for an experiment and is not an adopted dependency or
production database recommendation.

A separate temporary install of matched `prisma`, `@prisma/client` and
`@prisma/adapter-pg` 7.10.1 was attempted on Node 22.22.3. With install scripts
disabled, `prisma --version` failed while trying to retrieve the schema engine
checksum from `binaries.prisma.sh`, which this sandbox cannot reach. Therefore
Prisma generation, migrations, and Prisma client queries have **not** been
verified, and no Prisma dependency or schema was added to the application.
Repeat those checks in an environment that can retrieve the official engine;
do not bypass checksum verification. If Prisma is adopted, align the Node engine
range with all selected dependencies and retest. This experiment is not evidence
of API/database integration, deployment readiness, or production security.

## Development-only Google authentication

A first Google-only integration is implemented, but is **disabled by default**
and explicitly rejects API startup with auth enabled when `NODE_ENV=production`.
Do not deploy it or use production user data. The owner reported a successful
Google callback and session creation on their Windows development machine, and
no browser session after sign-out. This is not a security audit: token validation,
server-side revocation, browser behavior and production security still require
independent review. No OTP has been implemented; it is deferred until production
readiness. Google may separately ask users for its own security checks.

The development sign-in UI checks the session on load, shows signed-in status,
and offers sign-out with a follow-up session check. If the check fails, it shows
an unavailable state rather than assuming success. The status is only a UI hint,
not authorization; it may become stale if a session changes in another tab.
The app exposes only Google initiation/callback, session lookup and sign-out.
The web and API session endpoints return only `{ "authenticated": true/false }`
rather than session tokens or account details. Both changes must be deployed
together: old web and new API session response formats are incompatible. The
API binds to IPv4 loopback, but the web server can still be network-accessible;
restrict it to trusted users and networks. A server-only session identity resolver returns the validated session's user ID
internally, not a role or permission, and reports lookup errors as failures.
An authorization guard in `apps/api/src/authorization.ts` is groundwork for
protected API routes: it resolves the session, fetches current account status and
roles through a trusted server-side lookup, requires an active account and an
explicit allowed role, and forwards refreshed cookies. It denies missing accounts
and roles, and fails closed on lookup errors or malformed records. The current
application does **not** mount this guard on any marketplace route. A development-
only PostgreSQL account/role lookup and separate schema migration are implemented.
The only account write is the limited customer self-onboarding endpoint described
below; privileged roles are not assigned through it. Tests use a disposable database
and a test-only guarded route, not a real marketplace endpoint. Do not interpret
sign-in as authorization.

Before adding protected endpoints, review the account store, implement safe
provisioning/revocation and admin bootstrap, and mount the guard on every protected
route. A role check alone is not sufficient: handlers must also
enforce record ownership or assignment, collector verification, workflow state,
and appropriate CSRF/origin protections for mutations. Authorization and the
mutation must avoid races with revocation or ownership changes (e.g. via suitable
transactional database constraints/locking). Review the web bridge, refresh-cookie
handling, privacy, and security tests for each new route. No production or security
readiness is implied.
A failed Google callback is redirected to a generic sign-in error page with a
link back to start a new attempt; provider error details are discarded rather
than displayed. Next development request logging ignores `/api/auth` and the
error page path, but other loggers,
proxies and infrastructure may still capture callback URLs; review them and never
share OAuth codes, cookies, tokens, or session responses. This is not a complete
logging or security solution. The web bridge forwards paths to the trusted API origin, restricts POSTs
to the configured web origin even without cookies, limits request sizes, and
preserves auth cookies. The API repeats the origin check and rejects unavailable
or unconfigured auth. The configured origin must be identical for web and API;
never derive it from incoming Host or forwarded headers. Set the public HTTPS
preview origin explicitly if using a preview, and configure the corresponding
Google callback. Non-local HTTP origins are rejected. Network isolation, TLS to
the database/API, rate limiting, security review, and browser CSRF tests are
still needed before real deployment.

### Development authorization store (not required for sign-in)

`apps/api/src/account-store.ts` provides a PostgreSQL lookup by the validated
Better Auth user ID, reading status and role grants together on each request.
The separate migration creates `kabadi_authz.accounts` and
`kabadi_authz.role_grants` with constrained values and a foreign key to the
Better Auth `public."user"` table. It grants no roles and creates no accounts.
There is no administrative grant/revoke API, no audit trail, and no
verified-collector or ownership checks. Deleting a Better Auth
user cascades to its authorization account and grants. These choices need review
before introducing real application data. The migration assumes Better Auth tables
are in `public`; it refuses an unrecognized existing `kabadi_authz` schema and
is transactional. Its version marker supports a repeat invocation but does not
verify against all possible schema drift. Existing databases, upgrades, backup,
and rollback procedures have not been tested. Database permissions, TLS and
least-privilege separation need review; the development connection is not a
production privilege boundary.

The app does not migrate on startup. Sign-in does not require this schema, but
customer onboarding returns unavailable until it has been migrated. Before
specifically testing onboarding, first back up and inspect a **disposable development**
database, run the existing Better Auth migration, then explicitly run:

```sh
npm run build:api
AUTHORIZATION_MIGRATION_CONFIRM=yes node --env-file=.env apps/api/dist/migrate-account-store.js
```

On PowerShell set `$env:AUTHORIZATION_MIGRATION_CONFIRM='yes'`, then run
`node --env-file=.env apps/api/dist/migrate-account-store.js`; remove the variable
with `Remove-Item Env:AUTHORIZATION_MIGRATION_CONFIRM` afterward. The command
requires enabled development auth configuration and rejects production mode. It
makes persistent schema changes and should never target production data. Do not
manually grant roles or share user IDs, credentials or session data in chat.

### Customer details (development only)

The development-only `customer-details.ts` draft stores a customer name and one
editable pickup address (address line, city, state and postal code). Bounds are
technical defaults, not final product policy; no phone verification is implied.
The API resolves the owner ID from the current server-side session, validates
inputs and checks active customer membership under database locks for each
operation. The storage adapter itself cannot authenticate its caller: any
future caller **must** supply an ID from a validated server-side session. All
future grant/revocation writers must coordinate on the same account-row lock.
Address snapshots, multiple addresses, retention and production privacy/security
are not implemented.

A separate opt-in migration exists but is **not run at startup**. It requires the
existing authentication and authorization schemas, creates no customer records,
and refuses an unrecognized customer schema. Use only after independently
checking and backing up a disposable development database; marker version checks
do not detect every form of schema drift and restore/upgrade procedures have not
been verified. The same-origin web bridge and development form expose only the
signed-in customer’s own details. Use fictional test information only; privacy,
retention and production security are not ready. The form clears on sign-out or tab hiding.
Writes are last-write-wins, with no concurrent edit protection; a timed-out save
may have succeeded and should be checked by reloading.

To run explicitly on an approved disposable development DB after build:
`CUSTOMER_DETAILS_MIGRATION_CONFIRM=yes node --env-file=.env apps/api/dist/migrate-customer-details.js`
(on PowerShell set and later remove the environment variable as with the
authorization migration). This command is not necessary for sign-in or customer
setup. Back up the current database and obtain explicit approval before using it
for profile tests.

### Customer self-onboarding (development API)

`POST /api/v1/account/customer` accepts only an empty JSON object, requires an
exact configured Origin at both web and API boundaries, and uses the validated
session's user ID, not a supplied ID or role. If no account exists, it atomically
creates an active account and its **customer** grant. Repeated calls for an active
customer succeed without duplicating data; suspended accounts and existing
accounts without a customer grant are denied and never modified. No admin or
collector grants are created. Errors are sanitized and responses are no-store.
A separate narrowly scoped web bridge preserves refreshed cookies and projects
the response. The signed-in development page offers a customer-setup button and
shows a confirmation only after a validated success response. It clears that
confirmation on sign-out or when the tab is hidden; it is an action result, not
an authoritative account-status or authorization check. On interrupted requests,
setup cannot be confirmed and can safely be retried. The separate profile form
needs its own migration; pickup UI is not yet available.

Synthetic PostgreSQL and HTTP integration tests cover concurrent retries,
transaction rollback, invalid origins and payloads, forged role/ID headers,
revocation and suspended accounts. They are not a real-browser CSRF assessment
or security audit. Before protected business writes exist, design transactional
coordination with all future account/role changes (including revocation),
ownership/assignment and collector verification. Privileged role bootstrap,
audit, rate limiting, session transport and production deployment remain open.

To eventually test locally, prepare a **disposable development** PostgreSQL DB
and a Google OAuth client in a controlled test project. The Google web-client
redirect URI must exactly match `<AUTH_PUBLIC_ORIGIN>/api/auth/callback/google`.
Check Google's current testing and consent requirements. Copy `.env.example`
to the ignored `.env`, fill in `DATABASE_URL`, a cryptographically random
`BETTER_AUTH_SECRET` (at least 32 characters), `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and the exact `AUTH_PUBLIC_ORIGIN`; set
`AUTH_ENABLED=true`. Never paste secrets into chat or Git. The API and web must
receive the same values for `AUTH_PUBLIC_ORIGIN` and a trusted
`API_INTERNAL_ORIGIN`. Node's `--env-file` can load the file; it is not loaded
automatically by the API:

```sh
npm run build:api
# This modifies the specified development database. Back it up and inspect the
# target first; never point it at production. Migrations are not run at startup.
AUTH_MIGRATION_CONFIRM=yes node --env-file=.env apps/api/dist/migrate-auth.js
node --env-file=.env apps/api/dist/server.js
# In a second terminal, the web needs only the public origin and API address.
# Don't pass --env-file to Next dev: it can propagate the flag via NODE_OPTIONS.
AUTH_PUBLIC_ORIGIN=http://localhost:3000 API_INTERNAL_ORIGIN=http://127.0.0.1:4000 node node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1
```

On Windows PowerShell, set `$env:AUTH_MIGRATION_CONFIRM="yes"` before the
migration and remove it afterwards with `Remove-Item Env:AUTH_MIGRATION_CONFIRM`.
In the web terminal, use `$env:AUTH_PUBLIC_ORIGIN="http://localhost:3000"` and
`$env:API_INTERNAL_ORIGIN="http://127.0.0.1:4000"`, then run the same `node`
command above without its shell-style variable assignments. Browser origin,
web/API config, and Google callback must match exactly. Do not set
`NODE_TLS_REJECT_UNAUTHORIZED=0`: it disables TLS verification.

The API fails closed when configuration or auth tables are missing. Migration
uses Better Auth's built-in PostgreSQL migration on explicit confirmation; it
has only been tested on an empty disposable database, not existing data,
concurrent migrations, upgrades, rollback or production. `DATABASE_URL` can
contain credentials and should never be logged or committed. Do not disable
TLS certificate verification for deployed databases. Access to Google OAuth
endpoints has not been verified from this sandbox; real login must be validated
in an appropriate network.

For a no-account synthetic integration test after both builds, install the
isolated experiment dependencies and run:

```sh
npm ci --prefix experiments/google-auth-proof --ignore-scripts --no-audit --no-fund
npm run test:integration --prefix experiments/google-auth-proof
```

The test starts a disposable local database and actual web/API components,
checks migration, Google URL/state/PKCE and cookie generation, rejects untrusted
origins and invalid state, and checks fail-closed behavior. It also creates a
synthetic local session to test minimal direct API and web responses, server-only
identity resolution, session refresh cookie forwarding, sign-out, database
removal, expiration, cookie replay, and database failure. It does not visit
Google or use a real account. See the experiment README for
prerequisites. To test Next's development request logging, run
`node --test test/integration/auth-logging.test.mjs` separately. `npm test`
includes sign-in UI interaction tests using a simulated DOM with mocked auth
responses; these are not browser automation or Google OAuth tests.

### Isolated Google-auth / PostgreSQL feasibility (14 November 2026)

A separate, disposable proof under `experiments/google-auth-proof/` exercised
Better Auth's PostgreSQL schema migration and generated a synthetic Google
OAuth authorization URL without Prisma. This is **not** wired into the app or
proof of a successful Google login. The proof's README records the exact tests,
including an origin-check behavior requiring further security review, and how
to reproduce them. Application OTP remains deferred until production readiness.

Never use production data for development or commit `.env` files or secrets.

## Current status

The web app is an under-development placeholder, not a functioning marketplace.
The API has liveness and an opt-in, development-only Google authentication
integration. Authentication is disabled by default and prohibited when the API's
`NODE_ENV` is `production`. An initial owner-run local Google login succeeded;
security and production readiness have not been established. There is no
marketplace database schema, collection, notification, OTP or payment functionality. Policy decisions, full security review and
zero-cost provider suitability remain pending. Phase 1 is not complete.
