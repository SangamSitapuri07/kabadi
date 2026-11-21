# Phase 0 — Role-by-Role Gap Report

**Date:** 2026-11-14
**Scope:** the monorepo at the repository root (`apps/api`, `apps/web`, `apps/mobile`, `packages/shared`).
**Not in scope:** `kabadiwala-connect/`, a nested project that is not part of the root workspace and is not on the path to this brief.

Every claim below carries its evidence — a file, a line, or a command output. Nothing here is
marked "works" on the strength of it having been written.

---

## 0. What was actually verified, and how

| Check | Command | Result |
| --- | --- | --- |
| Root workspaces | `node -p "require('./package.json').workspaces"` | `[ 'packages/*', 'apps/*' ]` |
| Nested project is **not** a workspace | same | `kabadiwala-connect` is absent |
| Shared package builds | `npm run build:shared` | clean |
| API test suite | `cd apps/api && npx vitest run` | **24/24 passed**, 9.4 s |
| Prisma client | committed at `apps/api/src/generated/prisma/` (42 files) | `prisma generate` cannot reach `binaries.prisma.sh` from this sandbox; the committed client is what gets used |
| Schema size | `grep -c "^model " apps/api/prisma/schema.prisma` | **34 models**, 724 lines |
| Web pages | `find apps/web/src -name "*.tsx"` | 1 page (2405 lines) + 2 public pages + 5 components |
| Playwright | `grep -rn playwright apps/*/package.json` | **absent** |
| Geo columns | `grep -nE "latitude\|longitude\|geography" apps/api/prisma/schema.prisma` | **none** |
| i18n in web | `grep -rln "i18n" apps/web/src packages/shared/src` | **none** (the mobile app has `apps/mobile/src/i18n`) |

**Two facts worth stating plainly, because they shape everything below.**

1. The API is far more complete than the UI. Listings, offers, orders, weighing, settlement,
   disputes, khata, dismantling, inventory and lineage all have routes and Prisma models.
2. The UI is one 2405-line client component with six tabs that are shown to **every** signed-in
   user. That is the "same options everywhere" complaint, and it is accurate.

---

## 1. Capability matrix — what exists, per role

Legend: **✅ exists and verified** · **🟡 exists, incomplete** · **❌ missing**

### Customer / Seller

| Feature | State | Evidence |
| --- | --- | --- |
| Register / login / OTP | ✅ | `modules/auth/auth.routes.ts` (`/register`, `/login`, `/otp/*`) |
| Browse materials catalog | ✅ | `GET /api/v1/materials` — `marketplace.routes.ts:28` |
| Browse storefronts (discovery) | 🟡 | `GET /api/v1/storefronts` `marketplace.routes.ts:38` — **no distance ranking**; no lat/lng column exists |
| Create a listing with photo | 🟡 | `POST /listings` `marketplace.routes.ts:216`; `ListingPhoto` model exists; upload path not exercised by any test |
| Scrap value estimator | ❌ | no route, no component |
| Receive offers on a listing | ✅ | `POST /listings/:listingId/offers`, `GET /listings/open` — `supplychain.routes.ts` |
| Accept an offer (atomic) | ✅ | `POST /offers/:offerId/accept`; covered by test 11 ("Open Multi-Offer Bidding") |
| Saved locations / favourites | ❌ | no model in `schema.prisma` |
| Rate alerts | ❌ | no model, no route |
| Impact dashboard (kg / CO₂) | ❌ | nothing |
| Referral code | ❌ | nothing |

### Shop Owner (SCRAP_BUSINESS)

| Feature | State | Evidence |
| --- | --- | --- |
| Publish / edit rate card | ✅ | `POST /storefronts/my/rates`; `UpsertStorefrontRateSchema` in `shared/index.ts:369` |
| Rate history | ✅ | `GET /materials/price-history` — `operations.routes.ts`; `PriceHistory` model |
| Accept an order | ✅ | `POST /orders/:orderId/accept` `marketplace.routes.ts:440` |
| Weigh and settle | ✅ | `POST /orders/:orderId/weigh-and-settle` `marketplace.routes.ts:483`; `WeighingRecord` + `PaymentRecord` |
| Settlement slip | ✅ | `GET /orders/:orderId/settlement-slip`; `SettlementSlipModal.tsx` |
| Bulk rate editor (copy yesterday, ±X%) | ❌ | only single-rate upsert |
| Auto-offers / offer templates | ❌ | nothing |
| Walk-in quick entry | ❌ | nothing |
| Daily closing report | ❌ | nothing |

### Collector / Kabadiwala

| Feature | State | Evidence |
| --- | --- | --- |
| Open listings to bid on | ✅ | `GET /listings/open` |
| Submit an offer | ✅ | `POST /listings/:listingId/offers` |
| Job board with distance | ❌ | no geo data at all |
| Batch pickups / route order | ❌ | nothing |
| Handover PIN | 🟡 | `HandoverRecord` model exists; no PIN route found |
| Offline job screen | 🟡 | `apps/mobile/src/offline` + `SyncOperation` model; not verified end to end |
| Lot builder / inventory bins | ✅ | `GET /inventory/bins`, `POST /inventory/bins/:binId/sell-upward` — `supplychain.routes.ts`; `InventoryBin`, `BatchLineage` |

### Recycler / Bulk Buyer

| Feature | State | Evidence |
| --- | --- | --- |
| Dismantling records | ✅ | `POST /inventory/dismantle`; `DismantlingRecord`; mass-conservation test 11 |
| Lineage / traceability | ✅ | `GET /public/trace/:qrTraceToken`; `trace/[token]/page.tsx` |
| Requirement posts (buy-side demand) | ❌ | no model, no route |
| Lot discovery feed filtered by material/grade/distance | ❌ | no geo, no buy-side feed |
| Supplier scorecards | ❌ | nothing |
| Contract-lite recurring supply | ❌ | nothing |

### Admin

| Feature | State | Evidence |
| --- | --- | --- |
| Verification queue + documents | ✅ | `modules/verification/*`, `GET /admin/verification/cases` |
| Approve / reject with decision | ✅ | `POST /verification/cases/:caseId/decide`; `VerificationDecision` |
| Signed document links | ✅ | `POST /verification/documents/:docId/signed-link` — 60 s HMAC |
| Audit trail | ✅ | `AuditEvent` + PL/pgSQL trigger blocking UPDATE/DELETE |
| Dispute resolution | ✅ | `POST /admin/disputes/:disputeId/resolve` |
| Fraud flags | ❌ | nothing systematic (AI checks exist, no flag queue) |
| Platform rate guardrails | ❌ | nothing |
| Feature flags table | ❌ | no model |
| CSV export | ❌ | nothing |

### Cross-role

| Feature | State | Evidence |
| --- | --- | --- |
| In-app notifications | ✅ | `GET/POST /notifications*`; `Notification` model |
| Web Push | ❌ | nothing |
| In-app messaging | ❌ | no `Message` / `MessageThread` model |
| Multilingual UI (EN/HI/PA) | 🟡 | `SUPPORTED_LANGUAGES` in shared (`index.ts:59`); mobile has `src/i18n`; **web has none** |
| Indian number/currency formatting | ✅ | `inrToPaise` / `paiseToInrString` — `index.ts:240,247` |
| PWA / manifest / service worker | ❌ | nothing in `apps/web` |
| Role switcher | ❌ | nothing |

---

## 2. The five structural gaps

These are not features; they are the reasons features are hard to add. Ordered by how much they block.

### G1 — One page, every role (the complaint, confirmed)

`apps/web/src/app/page.tsx` is 2405 lines, `"use client"`, with six tabs
(`marketplace`, `bidding`, `dashboard`, `xray`, `operations`, `security` — `page.tsx:264`,
rendered at `:1132`, `:1292`, `:1484`, `:1924`, `:1946`, `:1961`). Every signed-in user sees the
same six. There is no `/customer`, `/collector`, `/shop` or `/recycler` route — the only other
pages are public (`trace/`, `verify/`).

**This single fact is why three logins look identical.**

### G2 — No location data, so there is no discovery

`grep` for `latitude`, `longitude` or `geography` across the 724-line schema returns **nothing**.
The brief makes location-aware discovery a core principle, and Slice 1 requires "a **nearby**
eligible shop discovers it". Today `/storefronts` can filter by tier and text only.

This needs: PostGIS-enabled columns + GiST indexes + a migration + the discovery query.

### G3 — One test file for a 34-model API

`apps/api/tests/` holds a single file with 24 tests. They are good tests — authorization, BOLA,
mass conservation, AI — but whole modules have none: `marketplace`, `operations`, `supplychain`
have no route-level coverage of their own.

The brief's Definition of Done requires an authorization matrix (every role × every endpoint) and
state-machine coverage. Neither exists.

### G4 — No policy layer

`packages/shared` has `ROLE_CAPABILITIES` and `roleHasCapability()` (`index.ts:138,197`), and routes
use `requireCapability`. That is a real start. But the brief's `can(user, action, resource)` layer —
one function every handler goes through, with a test that fails if a route lacks a check — is not
there. Routes are protected ad hoc: `adminRouter` guards its whole surface at the router level
(`admin.routes.ts:19`, `adminRouter.use(authenticate, requireRoles("ADMIN"))`), while the
marketplace read routes (`GET /materials`, `GET /storefronts`) are deliberately open. Both are
correct — but nothing enforces that the *next* route added will be either, and no test would notice
if one were added unprotected.

**Correction, recorded because it was nearly written down wrong:** an earlier draft of this report
claimed `GET /admin/verification/cases` was unauthenticated and leaked phone numbers, emails and KYC
document digests. Reading only the handler made that look true. It is not: the router-level
`requireRoles("ADMIN")` on line 19 covers it. The lesson is the one this whole report is about —
read the mount, not just the handler.

### G5 — No i18n on web, no PWA

`SUPPORTED_LANGUAGES` exists as an enum; the web app hardcodes English strings. No manifest, no
service worker. The brief makes both first-class for the target user.

---

## 3. What Slice 1 needs, and what is already true

Slice 1 from the brief: *customer creates a listing with a photo → a nearby eligible shop discovers
it → the shop sends an offer → the customer accepts → the transaction appears in both dashboards.*

| Step | Today |
| --- | --- |
| Create listing + photo | Route and models exist; photo upload untested |
| Nearby discovery | **Blocked by G2** — no coordinates |
| Shop sends offer | The offer route exists, but it is listing-side (`POST /listings/:id/offers`), i.e. seller-posted; a **buyer-initiated** offer is a different direction and needs confirming |
| Customer accepts | Exists and is atomic — `POST /offers/:offerId/accept` |
| Appears in both dashboards | **Blocked by G1** — there are no per-role dashboards |

So Slice 1 is roughly: G2 (geo) → buyer-side offer direction → per-role dashboards (G1).

---

## 4. Recommended order

The brief says thin complete slices over wide incomplete ones. Given the above:

1. **Phase 1 — foundations, minimal and non-negotiable**
   - **G1 role routes** (`/customer`, `/collector`, `/shop`, `/mandi`→ shop tier 3, `/recycler`,
     `/admin`) with a real shell, server-checked. This is both the fastest visible win and the
     thing the owner has been asking for since before this report.
   - **G4 policy layer** + the "no route without a policy check" test.
   - **G3 authorization-matrix test**, started with the routes that exist.

2. **Phase 2 — Slice 1 end to end**
   - **G2 geo**: PostGIS migration, coordinates on storefronts and listings, distance-ranked
     discovery with `EXPLAIN` evidence.
   - Listing → offer → accept → both dashboards, on the new routes.

3. **Phase 3 — the rest of the marketplace slices** (pickup PIN, walk-in, receipts, collector
   batching, recycler requirements), **i18n + PWA (G5)**, mobile integration.

**Deferred by explicit instruction:** notifications beyond the in-app centre, and every payment
path. Do not build these until the owner says so.

---

## 5. Open questions that block work

These are decisions, not implementation details. Nothing below will be guessed at.

1. **Buyer-initiated offers.** The brief says "the shop sends an offer"; the code has the *seller*
   posting offers on their own listing (`POST /listings/:listingId/offers`). Confirm which direction
   Slice 1 needs — or both.
2. **Area granularity.** City, pincode, or a radius on a dropped pin? This decides the schema.
3. **One role per account or many?** `UserRole` is single-valued on `User`; `SUPPLY_CHAIN_TIERS`
   implies a chain position. The brief mentions a role switcher; confirm whether one person may
   hold several roles in production.
4. **"Mandi" as a role.** *Answered from the code, not guessed:* the mandi is **not** a role.
   `USER_ROLES` has five values (`shared/index.ts:7`); `SUPPLY_CHAIN_TIERS` has the six positions
   (`index.ts:25`), and the mandi is `TIER_3_WHOLESALE_AGGREGATOR`. So a mandi is a
   `SCRAP_BUSINESS` account sitting at tier 3, which means **a route per tier, not per role** —
   `/shop` and `/mandi` are the same role at different tiers. This is worth stating because the
   brief's role list and the code's role list disagree, and building routes off the brief alone
   would have created a role that cannot be granted.

*(An earlier draft asked whether `GET /admin/verification/cases` lacked an admin check. It does
not — see G4. That question is withdrawn.)*

---

## 6. Free-tier limits hit while verifying

- **`binaries.prisma.sh` is unreachable from this sandbox**, so `prisma generate` cannot run here.
  The repo commits its generated client, which is why the tests pass. This is a sandbox
  restriction, not a project problem — but it means any Prisma schema change must be regenerated
  on a machine with network access before it can be tested.
