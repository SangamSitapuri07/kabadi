# Kabadiwala Connect

Independent greenfield workspace for the web-first recycling marketplace. It
does not use the legacy applications in the parent repository. Notion is the
primary planning and progress record.

> **Run every command in this file from this `kabadiwala-connect` directory.**
> The parent `kabadi` folder is a different, similarly named monorepo that also
> has a `package.json`; commands, `.env`, and `--env-file=.env` all resolve
> against the current directory, so running them one level up fails.

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
The test-pickup prototype snapshots the address; multiple addresses, retention
and production privacy/security are not implemented.

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

### Catalog and estimate groundwork (development only)

`catalog.ts` is a development storage/math prototype. An admin-only web view,
its same-origin read and write bridges, and direct API routes exist, but entries
are **not connected to pickup requests or estimates**. The migration creates no
categories or rates and is never run at startup. The internal write methods
require a currently active admin grant, checked transactionally; callers must
supply an actor ID derived from a validated server session. Privileged roles can
only be granted by a local operator command (below), and no identity/role can be
self-granted from a browser. Test admin records in the disposable integration
test are synthetic setup only.

Two development-only admin read routes support inspection:
`GET /api/v1/admin/catalog/categories` and
`GET /api/v1/admin/catalog/categories/:categoryId/rates`. They require a
validated session and an active admin grant checked within a transaction, and
return at most 50 items plus `nextAfter`. Pass that value as `?after=` for the
next page. Rows are ordered by UUID, **not** name, creation time, or effective
time. Pagination does not provide a consistent snapshot: concurrent changes can
be missed or appear during a scan, so restart inspection if changes are possible.
Rate times returned are UTC milliseconds, matching the application write format;
direct SQL writes are outside these assumptions. Read responses use `no-store`.
The read-only same-origin web bridge and “Test catalog inspection” view expose
these listings; the button is visible to signed-in users but the API checks the
active admin grant for every read. A non-admin receives an access-required
message, not catalog data. The view clears on sign-out and when the tab is
hidden, but already displayed data can become stale. These listings can assist
manual investigation but do not prove who caused a matching write.

The development-only API exposes `POST /api/v1/admin/catalog/categories`
(`{"name":"..."}`) and `POST /api/v1/admin/catalog/categories/:categoryId/rates`
(`{"effectiveFrom":"YYYY-MM-DDTHH:mm:ss.sssZ","paisePerKg":123}`). Both require
a validated session, exact configured Origin, and an active admin grant checked
within the write transaction. They return only the new ID on success; malformed
requests, unauthorized accounts, duplicates and unavailable storage fail closed.
Both writes require an `Idempotency-Key` header containing a client-generated
UUID v4. For an uncertain response, retry the **same operation and normalized
payload with the same key and same signed-in admin**, not a new key. A committed
success returns the original ID again; reusing a successful key for a different
payload or endpoint returns `409 KEY_CONFLICT`. Matching ignores surrounding
category-name whitespace and UUID letter case; category names otherwise remain
case-sensitive for key comparison. Keys are scoped per actor. The active admin
grant is rechecked even on a replay. Duplicate, invalid-time, forbidden and
other failed outcomes are not recorded and can change on a later retry. The
success record and mutation commit or roll back together. These guarantees assume
all writers use the adapter, stored retry records remain intact, and clients
retain their key/payload; there is no UI to retain them across refreshes.

A same-origin write bridge now exists at the same two paths
(`POST /api/v1/admin/catalog/categories` and
`POST /api/v1/admin/catalog/categories/:categoryId/rates`), together with a
development form under “Test catalog inspection”. The bridge adds no
authorization of its own: it rejects a mismatched `Origin` even without cookies,
requires a UUID v4 `Idempotency-Key`, bounds the body to 4 KB, forwards only the
body, that key and cookies, and projects the new ID (or a fixed error message).
The API still decides access from the validated session and an active admin
grant inside the write transaction. The form shows a retry button only after an
unconfirmed result and re-sends the identical payload with the identical
in-memory key; it discards uncertain state when the tab is hidden. The rate
start time defaults to roughly ten minutes ahead and is re-derived at submit
while it is untouched, so leaving the page open cannot make the default stale.
If you edit it, your exact value is used and a past time is rejected by the API
with a message rather than being silently rewritten. Keys are not
persisted, so reloading the page loses any pending retry — check the catalog
before making a new write. There is still no edit or delete operation, no rate
correction path, and no audit of who changed what beyond the retry records.

These routes do not provision administrators,
run migrations or populate data. They now require the separately migrated retry
schema; when it is missing, writes return unavailable rather than falling back
to unsafe behavior. Read-only listings do not require the retry schema. The
retry records reference actors and catalog rows with restricted deletion; a
retention, cleanup, backup/restore and audit policy is not designed. Direct SQL
can bypass these guarantees. This is not a production security audit.

### Development admin grants (local operator tool, no HTTP surface)

No browser or API route can grant a privileged role; self-granting is
deliberately impossible. Instead there is a local command-line tool that resolves
one application user by exact email and records every change in an append-only
audit table. This is small reviewable operations tooling, not identity
governance: there is no approval workflow, second approver, separation of duties,
key rotation, or protection against someone who already controls the database,
and the audit table is not tamper-proof.

Both steps are explicit and never run at startup. First migrate the audit schema
(`kabadi_admin`, requires the authorization schema):

```sh
npm run build:api
ROLE_ADMIN_MIGRATION_CONFIRM=yes node --env-file=.env apps/api/dist/migrate-role-admin.js
```

Then, only for an approved disposable development database:

```sh
DEV_ROLE_TOOL_CONFIRM=yes node --env-file=.env apps/api/dist/role-admin-cli.js list
DEV_ROLE_TOOL_CONFIRM=yes node --env-file=.env apps/api/dist/role-admin-cli.js grant person@example.test admin "bootstrap first local admin"
DEV_ROLE_TOOL_CONFIRM=yes node --env-file=.env apps/api/dist/role-admin-cli.js revoke person@example.test admin "remove accidental grant"
```

On PowerShell set and later remove the variables with `Remove-Item Env:...`. The
tool refuses `NODE_ENV=production`, refuses unknown or suspended accounts, does
not create accounts (the person must have signed in and completed customer
setup first), requires a 10–200 character reason, and is idempotent for repeat
grants/revokes. Arguments are validated before any database connection, so a
mistyped email is reported as a formatting problem rather than a schema failure.

Use `list` to see active administrators and recorded changes, and `users` to see
who has signed in (at most 50, addresses masked by the store itself, no user
IDs). A user shown as “no account” has signed in but not completed customer
setup, so a grant will report that instead of changing anything. Neither command
writes to the database. It prints the active-administrator count after each change and
warns if a revoke leaves none, because admin routes then become unusable until a
grant is restored. Do not use real personal emails or record production data
with this tool; it writes to whatever `DATABASE_URL` points at.

Categories have bounded names; rate events store integer paise per kg, creator
and UTC effective start. Each event applies until the next one. For this draft,
new starts must be in the future and strictly later than existing starts; this
is a temporary restriction, **not an approved backdating or scheduling policy**.
Insertion serializes through an account lock and category lock; all future
writers must take the same locks, and direct SQL can bypass these rules. There is
no update/delete operation in the adapter, but the database does not enforce
immutability against direct SQL. DB least privilege, auditing, corrections,
category deactivation, rate locality, historical retention and production
security all remain unresolved. The schema restricts deletion of creator accounts.

The separate arithmetic helper uses integer grams and exact big-integer
arithmetic, returning decimal paise strings. Per owner approval, it rounds each
item to the nearest paise, with exact half-paise ties rounded up. The same
per-item rule is intended for estimates and final amounts; neither pricing flow
is implemented yet. A future production request must select the applicable rate at request time on
the server inside its transaction and persist a rate/amount snapshot; the
current free-text test request has no categories, rates, or price estimate.
The lookup helper's supplied timestamp is for internal testing, not a trusted
client price or a request-time implementation.

An explicit development migration command exists but has not been run on the
owner's database. It checks the authz schema version and refuses an unrecognized
catalog schema; version markers do not detect all schema drift. Only after target
inspection, a fresh backup, and explicit owner approval may a disposable
**development** database be migrated. After `npm run build:api`, the command is
`CATALOG_MIGRATION_CONFIRM=yes node --env-file=.env apps/api/dist/migrate-catalog.js`.
In PowerShell set and later remove that environment variable. It creates schema
and tables but no categories or rates. Restore and upgrades are untested.

A separate explicit retry-schema migration also exists and has not been run on
the owner's database. It requires the authorization and catalog schemas and
creates no retry entries or catalog data. Its confirmation variable is
`CATALOG_RETRY_MIGRATION_CONFIRM=yes` and its compiled script is
`apps/api/dist/migrate-catalog-retries.js`; do not run it against an owner
database without inspecting the target, a fresh backup and explicit approval.
It refuses unrecognized schemas but version markers do not detect all drift.


### Test pickup request prototype (development only)

This is not a functioning pickup service. A signed-in active customer can request
one catalog category with a positive whole-number estimated weight in grams
(1–10,000,000), and a snapshot of their previously saved customer details is
copied onto the request, then load their 50 most recent test requests. The server
picks the newest rate whose `effective_from` has already passed at request time,
calculates the estimate itself and stores `category_name`, `rate_id`,
`paise_per_kg` and `amount_paise` on the row. Those snapshot columns are never
updated afterwards, so a later rate change cannot rewrite an existing estimate.
The client sends only `{requestKey, categoryId, estimatedGrams}`; a supplied
rate, amount or material is rejected rather than ignored. No collector is
dispatched: an active collector may see the request in their queue and gets an
in-app notification, but nothing pushes it to them. Scheduling, multiple items
per request, cancellation,
collector-recorded actual weights, the collection-time final rate, settlement,
assignment and audit are not implemented. These are essential before the approved
marketplace flow can be used. The technical bounds and this prototype format are
not final product policy; use fictional data only.

An **estimate is not a price**. Actual weight is confirmed by a collector later
and the final amount will use the rate in force at collection time, which is not
built yet. An unknown or deactivated category fails with `UNKNOWN_CATEGORY`, and a
category with no already-effective rate fails with `NO_RATE`, rather than
guessing a figure. Because the catalog write API only accepts strictly
future-dated rates, a freshly created rate does not apply to requests until its
start time passes.

Requests created before this schema change stay readable: they keep their
free-text `material`, carry no category or estimate, and are shown in the list
marked as older requests. The database enforces exactly one shape per row.

The API derives the owner from the validated session and checks active customer
membership inside the transaction, locking the account row in the same order as
profile writes. All future grant/status writers must coordinate on that lock.
Mutation requires exact origin and bounded JSON. A client-generated UUID makes
retries of the same data idempotent per customer, including concurrent requests;
reuse with different contents is rejected. The UI retains that retry key only
while the form is mounted. If a save is interrupted and the page is reloaded,
hidden, or signed out, check the list before making a new request: the first
write may have succeeded. The list is limited to 50 without pagination. Test
requests restrict deletion of their owner account; a real retention/deletion
policy and audited cleanup process are not designed. No automatic migration or
production readiness/security review is implied.

A new separate `kabadi_pickup` schema requires the existing auth, authorization,
customer **and catalog** schemas, because request rows reference catalog
categories and rates. The schema is version 7; an older schema is upgraded in
place one version at a time to version 7 in a single run, keeping every legacy
row. Version 3 added collection, version 4 cancellation and release, version 5
customer disputes, version 6 the payout ledger, and version 7 in-app
notifications. It is explicitly migrated, never on startup, and creates
no pickup requests. Version checks do not detect all schema drift; upgrades and
restore have not been tested. Before running on any local development database,
independently inspect the target, back it up, and obtain explicit approval. Do
not run on production data. After `npm run build:api` the approved command is
`PICKUP_MIGRATION_CONFIRM=yes node --env-file=.env apps/api/dist/migrate-pickups.js`;
PowerShell users set and later remove the environment variable as for the other
migrations. The `npm run migrate:*` scripts load `.env` themselves via
`--env-file-if-exists`, so `npm run migrate:pickups` works too; a real
environment variable always takes precedence over the file.

To check the recorded version without changing anything, run
`npm run pickups:version`. It also checks that the columns version 3 promises
really exist, and fails if the recorded version and the table disagree — a
version row alone is not proof that an upgrade completed. The migration performs
the same check and refuses rather than reporting a no-op on a table that does not
match its recorded version. It prints the recorded version and whether a
migration is still needed, so nobody has to infer from log wording whether a
migration actually ran. A migration run always prints what it did — `created`,
`upgraded from version N to version 7`, or `already version 7; nothing changed`
— so a no-op can never be mistaken for an upgrade. If the printed text does not
match this description, the built `dist` output is older than the source: run
`npm run build:api` after pulling. No secrets or customer data should be shared in chat.

Run migrations **from this `kabadiwala-connect` directory**, because `.env` is
resolved relative to the current directory and lives here. Running from
the parent repository root fails with `.env: not found`. The command reports what
it actually did: `created`, `upgraded from version N to version 7`, or
`already version 7; nothing changed`, plus how many pre-pricing requests still
exist without an estimate.

### Collector acceptance and the final amount (development API)

The request-time figure is an **estimate**; the payable amount is decided when a
collector records the collection. Three endpoints back that:

- `GET /api/v1/collector/pickups?view=open|mine` — open requests are priced
  `requested` rows only (legacy free-text rows are never offered, because there
  is no category to price at collection). `mine` shows the caller's accepted and
  collected rows. The view is required and anything else is a 400.
- `POST /api/v1/collector/pickups/:requestId/accept` with `{}` — claims the
  request. Acceptance is a single conditional `UPDATE ... WHERE status='requested'`
  inside a transaction, so exactly one collector can win a race; losers get
  `ALREADY_ACCEPTED` (409).
- `POST /api/v1/collector/pickups/:requestId/collect` with `{"actualGrams":2300}`
  — locks the row, requires `status='accepted'` **and** that the caller is the
  accepting collector, then selects the newest rate with
  `effective_from <= clock_timestamp()` and stores the weight, that rate and the
  final amount on the request.

The final amount therefore always uses the **collection-time** rate, never the
request-time one; the request-time rate stays on the row as the historical
estimate. Both writes require an exact Origin, a bounded JSON body (4 KB), a
content type of `application/json`, a session, and an active account holding a
`collector` grant — re-checked inside the transaction, not trusted from the
guard. The actor is always the session user; no endpoint accepts a collector id,
a rate, a per-kg price or an amount from the client. A second collection returns
`ALREADY_COLLECTED` (409) and changes nothing; a collector who did not accept the
request gets `NOT_ACCEPTED` (409). Every code the UI can show is enumerated in
the same-origin bridges; anything unlisted fails closed as a 503.

If the database is still at an older pickup schema, these routes answer
`503 PICKUP_SCHEMA_OUTDATED` rather than a generic outage: the request list now
selects collector columns that do not exist until version 3, so a half-upgraded
database is reported as a migration that has not run. Run
`npm run migrate:pickups` (with `PICKUP_MIGRATION_CONFIRM=yes`) and retry.

The customer's own list now carries the lifecycle (`requested`, `accepted`,
`collected`) plus, once collected, the measured weight, the collection-time rate
and the final amount. The UI labels the request-time figure as an estimate and
the collected figure as the final amount. No cancellation, reassignment,
dispute handling, notification, payout or retention policy exists yet, and
collection requires the `collector` role to be granted with the development role
tool — no self-service collector signup exists.

### Cancellation and releasing a claim (development API)

Two ways a request stops being work, with deliberately different consequences:

- `POST /api/v1/customer/pickups/:requestId/cancel` with `{}` or
  `{"reason":"..."}` — the customer's own decision on their own row. The reason
  is optional, because nobody should have to justify cancelling their request;
  when given it is trimmed text of 1–200 characters. Cancelling is terminal:
  `collected` and already-`cancelled` requests answer 409 and change nothing.
  The conditional `UPDATE ... WHERE id=$1 AND user_id=$2 AND status IN
  ('requested','accepted')` is what makes it race-safe — if a collection commits
  first, the cancellation loses and says so rather than erasing a settled amount.
  A cancelled request keeps its stored estimate and its history; the row drops
  `collector_id` so a cancelled request cannot linger in a collector's queue.
  Someone else's request answers 404, never 403: the existence of another
  customer's pickup is not this caller's business.
- `POST /api/v1/collector/pickups/:requestId/release` with `{}` — a collector
  giving a claim back. This is **not** a cancellation: the customer still wants
  the pickup, so the row returns to `requested` with no collector, and
  `released_at` records that it was once claimed. Only the collector holding the
  claim can release it; the update requires `status='accepted' AND
  collector_id=$2`.

A collector may never accept their own request. `accept` carries
`AND user_id <> $2` in its `UPDATE`, so the rule is enforced by the statement
rather than by a check that could be bypassed between read and write; the loser
gets `OWN_REQUEST` (409) and the UI explains it. This matters because a collector
records the weight — self-acceptance would let one person set the quantity and
receive the money.

Neither action notifies anybody: no messaging exists (see *Notifications: not
implemented*), and there is no dispute process or retention policy yet. Cancelling after a collector has accepted leaves that
collector with no signal beyond the row disappearing from their queue.

### Disputes (development API)

A settled amount can be challenged once, and only by the customer who owns the
request:

- `POST /api/v1/customer/pickups/:requestId/dispute` with `{"reason":"…"}` — the
  reason is **required** here (1–200 characters), unlike cancellation: an admin
  must know what to check. Only a `collected` request can be disputed, and only
  one dispute can be open at a time. The settlement is **not** hidden or altered
  while the dispute is open, so both sides discuss the same figure.
- `GET /api/v1/admin/disputes` — open disputes, oldest first, with the recorded
  weight, the frozen per-kg rate and the customer's stated reason.
- `POST /api/v1/admin/disputes/:requestId/resolve` with
  `{"correctedGrams":2000}` — accepts a corrected weight and recalculates the
  amount using the **per-kg rate frozen on the row at collection time**. It never
  queries the catalog: a fresh lookup would silently apply today's price to an
  older pickup. The `UPDATE` does not touch `final_rate_id` or
  `final_paise_per_kg`, so those cannot drift; only `actual_grams` and the
  derived `final_amount_paise` change. A weight identical to the recorded one is
  refused (`SAME_WEIGHT`) rather than counted as a correction.
- `POST /api/v1/admin/disputes/:requestId/reject` with `{}` — keeps the original
  settlement exactly as recorded and marks the dispute reviewed. The customer may
  dispute again after a rejection; they may not while one is open.

Admin access is re-checked inside the store's transaction against an active
account holding an `admin` grant, not trusted from the route. The browser never
sends a price, a rate or a total: only the corrected weight.

What a dispute does **not** do: it does not move money, notify anyone, or
preserve the previous weight as a separate history row. The correction overwrites
`actual_grams` and the amount, so the earlier figure survives only in backups.
That is a deliberate simplification for this slice and the first thing to change
if a real dispute trail is required.

### Payout ledger (development API)

Collecting a pickup and paying the collector are two separate acts, recorded
separately. This slice records the second one; it never moves money.

- `GET /api/v1/admin/payouts` — collected requests that have no payout row and
  no **open** dispute, oldest collection first, with the amount owed. A rejected
  dispute does not block payment: the amount was reviewed and stood.
- `POST /api/v1/admin/payouts/:requestId/pay` with
  `{"method":"cash","reference":"…","note":"…"}` — `method` is required and must
  be `cash`, `transfer` or `adjustment`; `reference` (≤100) and `note` (≤200)
  are optional free text. The response is
  `{"paid":true,"amountPaise":"6490","method":"cash"}`.

The amount is **never** accepted from the client. It is read from the row's
`final_amount_paise` — the amount frozen at collection, or the corrected amount if
a dispute was resolved — so a payout can never disagree with the settlement it
settles. Any request body that carries an amount, a collector id or a timestamp
is refused outright rather than having the extra field ignored.

Each request can be paid **once**: `kabadi_pickup.payouts` has `request_id` as
its primary key, so a second attempt is `ALREADY_PAID` and a race between two
admins ends as one payout plus one clean refusal, not two payments or a crash.
Open disputes (`DISPUTE_OPEN`) and uncollected requests (`NOT_COLLECTED`) are
refused: paying an amount that is still under challenge would make the
correction meaningless.

Admin access is re-checked inside the store's transaction against an active
account holding an `admin` grant. The recorded `recorded_by` is that admin and
the `collector_id` is copied from the request row.

What this does **not** do: it does not transfer money, contact a payment
provider, mark a bank reference as verified, or keep a ledger of balances. It is
a record that a payment happened — who, how much, by what method, on whose
authority. The customer sees only that a payment was recorded, and the amount;
the method and reference stay internal.

#### Payment method: not implemented (placeholder)

The payment mechanism is **decided to be decided later**. There is no provider
client, no credentials, no webhook and no transfer code anywhere in this
repository, and that is on purpose rather than an oversight. The placeholders
that exist, and what each one is for:

- `PAYOUT_METHODS` in `apps/api/src/pickups.ts` — the single JavaScript list of
  accepted methods (`cash`, `transfer`, `adjustment`). Both the store and the
  route validate against it. The two SQL `CHECK` constraints cannot read a
  TypeScript constant, so a test asserts that `PAYOUT_METHODS` and both
  `CHECK (method IN (…))` clauses list exactly the same values. Adding a method
  therefore requires a migration and fails a test if you only change the code.
- `PAYMENT_PROVIDER = { configured: false, name: null }` — a constant the payout
  queue returns as `data.payment`, so the browser learns the truth from the
  server instead of guessing. The admin screen renders it as a visible notice:
  "Payment method not implemented yet … nothing is sent to a bank, a wallet or a
  provider." A missing or malformed `payment` block is treated as *no provider*,
  never as a reassuring one.
- `.env.example` — `PAYMENT_PROVIDER` and `PAYMENT_PROVIDER_KEY` are present and
  deliberately blank. Nothing reads them yet; they are a fixed place for the
  eventual setting so the shape of the configuration does not have to be
  invented under time pressure later.

When the mechanism is chosen, a provider layer plugs in **behind**
`recordPayout`. Everything else is meant to survive that change untouched: the
amount is still read from the settled row and never from the browser, a request
is still payable once, an open dispute still blocks payment, and `recorded_by`
still names the admin. What will have to change is honest and small: flip
`configured`, add the real method list, and replace the banner with the actual
provider state — not hide it.

### In-app notifications (development API)

Notifications are implemented **in-app only**. A notification is a row in
`kabadi_pickup.notifications`, written **in the same transaction as the change it
announces** — if the change rolls back, so does the message. There is no queue,
no retry, no cron and no provider: delivery is the recipient reading it in the
app, and `read_at` is the only delivery fact that exists.

| Event | Recipient |
| --- | --- |
| `pickup-requested` | every active collector, except the requester |
| `pickup-accepted` | the customer |
| `pickup-collected` | the customer (weight, rate and amount in the message) |
| `pickup-cancelled` | the collector who held the claim, if any |
| `claim-released` | the customer |
| `dispute-raised` | every active admin |
| `dispute-resolved` / `dispute-rejected` | the customer |
| `payout-recorded` | the collector (amount and method) |

The actor is never a recipient: nobody is notified of their own action, and that
rule lives in one function. Broadcast events target accounts by *active grant*, not
by a stored list, so a newly granted collector starts receiving work immediately
and a suspended account stops.

- `GET /api/v1/notifications` — the caller's own 50 most recent, with `unread`,
  plus the `delivery` descriptor. A notification pointing at a request the reader
  can no longer see is dropped rather than shown without context.
- `POST /api/v1/notifications/:id/read` with `{}` — marks one read.
- `POST /api/v1/notifications/read-all` with `{}` — marks all read, returns
  `{cleared}`.

Every read and update is scoped by `recipient_id` **in the SQL**, not filtered
afterwards, so one account cannot read or clear another's. An id belonging to
somebody else is a plain 404, not a distinguishable error. Marking an
already-read row is a no-op, not a failure. Any signed-in account may read its
own inbox; no role is required, because every role receives something.

#### What is still absent: external delivery

No email, SMS, WhatsApp or push message is sent, to anyone, ever. There is no
transport, no credentials and no queue. A recipient who never opens the app is
never told anything. This is stated in three places rather than assumed:

- `NOTIFICATION_PROVIDER` reports `delivery: 'in-app'`, `channels: ['in-app']`
  and `external: []` — the two facts are separate so a screen can say "check
  your notifications here" *and* "do not wait for an email".
- Both web bridges accept a notification descriptor only when it matches that
  exactly; a block claiming an external channel is a 503, not a passed-through
  promise.
- The customer screen and the payout screen both say it, and the inbox repeats
  it under its own heading.

`.env.example` carries `NOTIFICATION_CHANNEL=in-app` plus blank
`NOTIFICATION_SMTP_URL` / `NOTIFICATION_SMS_KEY` for a future external channel.
Nothing reads the latter two. When an external channel is chosen, a sender plugs
in beside the in-app write; the notice changes from "in-app only" to the real
state rather than being deleted.

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
needs its own migration; the separate pickup prototype requires another migration.

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
security and production readiness have not been established. Customer setup,
profile, test pickup capture, a read/write development catalog, a local
admin-grant tool, collector acceptance and collection-time settlement,
cancellation and release, customer disputes with admin correction, and an
**admin-recorded payout ledger** and an **in-app notification inbox** exist.
There is still no dispatch, routing, OTP, or actual money movement, and notes are
delivered **in-app only** — no email, SMS, WhatsApp or push message is sent, so
nothing reaches anyone who is signed out. Recording a payout is bookkeeping, and
the payment rail remains an explicit placeholder: no provider is connected and
the screen says so. Policy
decisions, full security review and zero-cost provider suitability remain
pending. Phase 1 is not complete.
