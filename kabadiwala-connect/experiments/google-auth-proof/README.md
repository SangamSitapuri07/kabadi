# Disposable Google-auth / PostgreSQL feasibility experiment

The original `proof.test.mjs` is a local-only experiment, not application code
or a production configuration. `integration.test.mjs` separately exercises the
actual development-only app integration through a disposable database and web
bridge. Neither test is an authentication bypass or production-ready setup.
Both use random local database/auth secrets and fake Google client values; no
external Google service is contacted and no actual Google login is performed.
The integration test inserts a synthetic user and session to exercise lookup and
revocation. Neither test uses an existing application database or credentials.

## Reproduce

On a supported non-root machine with Node 22, npm and the matching embedded
PostgreSQL platform binary (the tested environment was Linux x64), from this
folder:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
# Build the main API and web before this separate integration test:
npm --prefix ../.. run build:api
npm --prefix ../.. run build:web
npm run test:integration
```

The experimental embedded-postgres package uses a platform binary delivered
through npm and recreates its required package symlinks during initialization.
The test creates a temporary cluster under the repository's ignored `.cache`,
uses a random password and SCRAM, and stops/removes it in cleanup. If the process
is forcibly killed, a server or temporary files may require manual cleanup. It
uses a discovered free local port, which can be claimed by another process before
PostgreSQL starts. Test failures intentionally produce diagnostic errors.
Never add real secrets, real users, or production data to this experiment.

## Observed on 14 November 2026

- Better Auth 1.7.24, pg 8.23.1, Express 5.3.0 and embedded PostgreSQL
  18.6.0-beta.19 ran on Node 22.22.3. The library's built-in PostgreSQL
  migration created its core tables in a disposable database; a second plan
  reported no missing tables or columns. This does not test migrations against
  existing real data, concurrency, upgrades, backups or application schemas.
- A local HTTP request produced a Google authorization URL with synthetic client
  ID, authorization-code response type, state and callback; a cookie was set.
  We did **not** visit the URL, verify tokens, complete the callback, create a
  session, or test Google's consent screen. A synthetic bad state was rejected;
  get-session returned null and email/password login was disabled.
- A cross-origin JSON sign-in request with a Cookie header was rejected, as was
  an untrusted callback URL. The equivalent request **without** a Cookie header
  received 200 in this experiment. That is not proof of an exploit or of safety:
  actual browser/CORS behavior and login-CSRF protections require a deliberate
  end-to-end security review before any adoption. Do not assume all cross-origin
  requests are rejected by default.

The development-only application now uses the pinned Better Auth and pg
packages; embedded-postgres remains an experiment/test dependency only. The
integration test exercises the actual API/web bridge with a synthetic Google
request, validates state and PKCE generation, tests origin rejection and invalid
callback, checks the startup/migration gates, and uses a synthetic DB session to
check sign-out and replay. It does not contact Google or perform real OAuth.
The owner separately reported an initial real Google login on Windows. Neither
package selection nor these tests constitute production approval: browser CSRF,
token validation, account linking, authorization, transport, logging and
operations still need independent security review. OTP remains deferred.
