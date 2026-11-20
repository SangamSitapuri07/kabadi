# Security review — Kabadiwala Connect, Phase 1 (development build)

**Scope.** Everything under `kabadiwala-connect/` at commit `baabc32`. This is a
development build that has never been exposed to the public internet, has never
handled a real payment, and runs on a database that is explicitly disposable. The
review says clearly what is **already defensible** and what would have to change
**before** this build is exposed to anyone outside the owner's machine.

**Method.** Reading the actual route handlers and stores, then testing the
specific claims. Anything asserted here was checked against the code at that
commit; where a claim could not be checked, it says so. Three things I expected
to be holes turned out not to be, and are recorded that way rather than quietly
dropped — a review that only lists hits is not a review.

**Verdict in one line.** The authorization model is sound and consistently
applied; the gaps that remain are about *operational exposure* — rate limiting,
audit logging, session transport under real TLS — not about whether one person
can read another person's data. Nobody found so far can.

---

## What is already right

Each of these is enforced in code and covered by a test.

**1. Authorization is checked at the data, not the UI.** Every store method opens
a transaction, reads or locks the caller's account row, and checks the required
grant inside that transaction (`FOR SHARE` on the grant, `FOR UPDATE` on the
account for writes). The role-based panel gating added in `b39a2af` is a
*display* hint; a tampered role list buys a screen of 403s, not access. This is
the most important property in this review and it holds.

**2. Identity is never taken from the request.** No route reads a user id, role
or price from the body or a header. Identity comes from the session cookie via
`resolveIdentity`; prices come from the server's catalog read; weights and
amounts are recomputed server-side at collection time. Tests assert that a client
sending `{ userId: 'other' }`, `{ paisePerKg: 1 }` or a forged `x-user-id` header
is rejected outright rather than silently ignored.

**3. State-changing requests are origin-gated.** All POST bridges and every POST
route in the API check `Origin` against the exact configured origin. Verified
route by route, including the catalog writes, which delegate to a shared
`writeCatalog` helper — a per-file grep misses those, the audit found the gate.

**3a. Role changes are audited.** `kabadi_admin.role_changes` records every
grant and revoke with a required reason and a timestamp. The schema correctly
labels itself "append-only intent" rather than tamper-proof — the database does
not forbid a privileged UPDATE. Keeping that distinction honest matters more than
the table itself.

**4. Cross-site reads leak nothing.** Several GET bridges (`/account/roles`,
`/notifications`, the admin and collector queues) do **not** check `Origin`. I
checked whether that matters and it does not: they forward only the session
cookie, they set `Cache-Control: no-store`, and a cross-origin `fetch` cannot
read the response without CORS — and no route sets
`Access-Control-Allow-Origin`. Verdict: **not a finding**. Recorded because it
looks like one.

**5. Money can only be recorded once, from the server's own numbers.** `payouts`
is keyed on `request_id`, so a second payout is a constraint violation rather
than a second payment. The amount is read from the settled request, never the
browser. An open dispute blocks payment. Recording a payout moves no money, and
the UI says so.

**6. Retention cannot erase the ledger.** Payouts and the requests that settle
them are permanent by construction; the sweep redacts five personal columns after
730 days and deletes nothing with financial meaning. The apply step re-asserts
its own predicates, so a row that changed since the plan is skipped, not erased.

**7. Response bodies fail closed.** Every parser returns `null` on anything it
does not recognise, and one unrecognised row invalidates the whole response
rather than rendering a partial screen. The clients never trust the shape they
were sent.

**8. Errors do not leak infrastructure.** Database errors are mapped to a small
set of known messages before being logged or returned; connection strings and
hostnames are never echoed. The migration and version CLIs print only the
messages they are documented to print.

---

## Findings, ordered by what would actually bite

### S-1 — No rate limiting anywhere (Medium; blocking for exposure)

There is no limiter on the API or on the web bridges. Every write runs a Postgres
transaction, so a trivial loop can exhaust the connection pool and deny service
to everyone else — including the owner. Sign-in is unlimited too.

*Why not fixed now:* a limiter needs a decision about where its state lives (in
memory dies with the process; a shared store adds a dependency). Doing it badly
is worse than not doing it. **Needs an owner decision on deployment topology.**

### S-2 — The audit trail covers role changes only (Medium; blocking for production)

Correction to my first draft, which claimed there was no audit log at all. There
is one, and it is well built: `kabadi_admin.role_changes` is append-only by
intent and records user, email, role, action, a required reason of at least ten
characters, and a timestamp — for every grant and revoke.

What it does **not** cover is the money. Dispute resolutions and payouts leave no
comparable trail: the payout row records `recorded_by` and `paid_at`, but a
corrected dispute weight overwrites the previous value in place, so the prior
weight survives only in a backup. For money-adjacent actions that is the gap
worth closing, and it is narrower than "add auditing" — the pattern, the table
style and the reason-required discipline already exist in this codebase and can
be followed.

Note also the honest limitation the schema states about itself: "append-only
intent" is not enforced by the database, so it is evidence, not tamper-proof
logging. That is the correct framing and should stay.

### S-3 — Nothing has been exercised with a real browser identity (Medium)

Every guarantee above is proven against synthetic sessions and a fake pool. No
real Google sign-in, no real cookie jar, no real hostile-origin request has been
performed. The tests are good, but they test the code's opinion of itself.
**This is the cheapest high-value thing left**, and it is the owner's step.

### S-4 — Session transport is unproven under real TLS (Low–Medium)

Cookies are marked `secure` only when the public origin is HTTPS, and production
is refused unless the origin is HTTPS. That is correct, but the build has only
ever run on `http://localhost`, so the secure-cookie path has never executed.

### S-5 — `NODE_TLS_REJECT_UNAUTHORIZED` (Resolved; kept for the record)

This was set machine-wide on the owner's Windows machine (not by this repo) and
would disable certificate verification process-wide. It turned out **not to be
loaded** in the shell that ran the database commands: `Remove-Item` reported the
variable absent, and `pickups:version` then read the schema over TLS with full
verification. The original failure was a Windows certificate-store problem that
broke *git* (schannel), fixed with `http.sslBackend=openssl`. Node uses its own
CA bundle and was never affected. **Outcome: not a live risk. Must not be
reintroduced** — if TLS fails again, the fix is a CA bundle, not a bypass.

### S-6 — Privileged bootstrap is manual (Low, by design)

Admin and collector grants are created only with a CLI tool that requires an
explicit confirmation variable. There is no self-service path to privilege. That
is the right default; it makes the owner the only source of privilege, which is a
process risk rather than a code one.

---

## Before any public exposure

In order; only the third is genuinely cheap:

1. **Rate-limit the API and sign-in** (needs the S-1 decision).
2. **Extend the existing audit pattern** (`kabadi_admin.role_changes`)
   to dispute resolutions and payouts.
3. **Exercise one real end-to-end session in a real browser** (S-3), including a
   deliberate cross-origin POST to confirm the 403.
4. **Run once behind real HTTPS** to exercise the secure-cookie path (S-4).
5. **Decide retention authority** — who may run `--apply`, and whether the result
   is reviewed before it runs.

None of these change the data model. The schema is stable at v8 and the
authorization model does not need to move.

---

## Explicitly out of scope

Payment rail selection (deferred by the owner; placeholder only), external
notification channels (in-app only, by design), multi-region and
high-availability concerns, penetration testing, and any claim of compliance with
a named standard. **This is not a penetration test and must not be presented as
one.**
