# Kabadiwala Connect

A security-first, multi-tier scrap and e-waste marketplace, storefront rate-card system, Camera AI Device X-Ray valuation engine, and chain-of-custody platform built for India's real recycling hierarchy:

`Tier 0 (Customer / Generator)` → `Tier 1 (Local Collector)` → `Tier 2 (Area Scrap Shop)` → `Tier 3 (Wholesale Baling Mandi)` → `Tier 4 (Authorised Recycler)`

Full architectural and security blueprint: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**

---

## Monorepo Architecture

```text
kabadi/
├── packages/
│   └── shared/      # Shared TypeScript types, RBAC matrix, integer-paise money math & strict Zod DTOs
├── apps/
│   ├── api/         # Node.js + Express + TypeScript + Prisma 7 + PostgreSQL REST API (/api/v1)
│   ├── web/         # Next.js App Router Web Dashboards & Multi-Tier Storefront Marketplace
│   └── mobile/      # React Native (Expo) Android Field App (expo-secure-store + idempotent sync queue)
└── docs/
    └── ARCHITECTURE.md
```

---

## Implemented Foundation & Security Highlights

- **Authentication & Session Lifecycle:** Argon2id password hashing, hashed short-lived OTP challenges, short-lived signed JWT access tokens (`15m`), rotating opaque refresh tokens with **token-replay family revocation**, `HttpOnly; SameSite=Lax` web cookies, and `expo-secure-store` mobile storage.
- **Strict Server-Side Authorization (OWASP API Top 10):**
  - Role-Based Access Control (`CUSTOMER`, `COLLECTOR`, `SCRAP_BUSINESS`, `AUTHORISED_RECYCLER`, `ADMIN`) with `ADMIN` blocked from public sign-up.
  - Object-Level Authorization (**BOLA defense**) on user profiles, verification cases, private documents, and transactions.
  - Strict `.strict()` Zod schema validation blocking mass-assignment (`role`, `verificationLevel`, `platformCode`, `accountStatus`).
- **Digital Identity & Honest Verification (`Levels 0–4`):**
  - Platform-issued IDs (`KC-CUS-...`, `KC-COL-...`, `KC-SHP-...`, `KC-WHL-...`, `KC-REC-...`) with PII-free public QR verification endpoint (`/api/v1/public/verify/:platformCode`) and explicit non-government disclaimers.
  - Level 4 Authorised Recycler verification enforces confirmation against official CPCB/SPCB portals before approval.
- **Secure Private File Storage:** Binary magic-byte inspection (`JPEG`, `PNG`, `WebP`, `PDF`), random server filenames outside public directories, and 60-second HMAC-signed download URLs with Admin access logging.
- **Database Integrity & Immutability:** PostgreSQL `CHECK` constraints for non-negative weights and integer-paise amounts, plus a **PostgreSQL PL/pgSQL trigger** blocking `UPDATE` or `DELETE` mutations on `AuditEvent`.
- **Multi-Tier Supply Chain & Public QR Lineage (`Milestone 1`):**
  - Upward stock-bin selling (`POST /api/v1/inventory/bins/:binId/sell-upward`) automatically linking child source pickups into `BatchLineage`.
  - Physics-validated Appliance Dismantling (`POST /api/v1/inventory/dismantle`), Open Multi-Buyer Bidding (`POST /api/v1/listings/:id/offers`), Morning *Peshgi* Cash Advances (`KhataLedgerEntry` auto-offset during scale settlement), and public PII-scrubbed QR pages (`/verify/[platformCode]` & `/trace/[token]`).
- **Camera AI Pixel Vision, 7-Segment Scale OCR & 4-Language Vernacular Audio (`Milestone 2`):**
  - Native `sharp` RGB/HSV spectral pixel analysis separating Copper vs. Aluminium coils, Grade-A PCBs, burnt ash-contaminated wire, and wet cardboard moisture inflation (`POST /api/v1/ai/vision-verify`).
  - 7-Segment LED Digital Scale pixel digit reader + **64-bit Perceptual `dHash` replay attack blocker** (`POST /api/v1/ai/scale-ocr`) catching even lossy JPEG-recompressed duplicate scale photos (`409 SCALE_PHOTO_REPLAY_BLOCKED`).
  - Native 4-language vernacular support & WebAudio readouts (`English`, `हिन्दी`, `ਪੰਜਾਬੀ`, `मराठी`).
- **Idempotent Offline Field Sync, Disputes & Market Trends (`Milestone 3`):**
  - Atomic offline batch sync (`POST /api/v1/sync/batch`) enforcing `(actorId, idempotencyKey)` deduplication across mobile & web field queues.
  - Transaction Dispute Escrow Freeze (`DISPUTED` / `ON_HOLD` blocking unilateral buyer settlement) with Admin arbitration (`POST /api/v1/admin/disputes/:id/resolve`), live PII-safe `Notification` alerts, and 6-week multi-tier `PriceHistory` trend charts.
- **Scannable ISO 18004 QR Stickers, Interactive KYC Vault, Dynamic UPI QR & IndexedDB Offline Queue (`Milestone 4`):**
  - Smartphone-scannable SVG QR matrices on `/verify/[platformCode]`, `/trace/[token]`, Dashboard Digital ID cards, and printable shop gate/rickshaw stickers.
  - Full browser KYC Application & Private Vault Viewer (`KycVerificationPortal.tsx`) with magic-byte upload inspection, spoofed-binary probe, and 60-second HMAC-signed preview modal.
  - Dynamic integer-paise NPCI `upi://pay` QR & 80mm bilingual thermal settlement slip (`GET /api/v1/orders/:id/settlement-slip`) with automatic Khata *peshgi* deduction and SHA-256 receipt integrity hash.
  - Persistent browser `IndexedDB` queue (`kabadiwala_offline_db`) preserving offline field drafts across page reloads with auto-flush on reconnect.
- **Native Expo Android Field App Parity (`Milestone 5` — `M5.1` + `M5.2`):**
  - Multi-screen React Native (`Expo SDK 52`) field application (`apps/mobile/`) with passwordless Mobile Phone OTP sign-in (`/api/v1/auth/otp/login-request` + `/login-verify`), hardware-backed `expo-secure-store` Keystore token encryption (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), and transparent HTTP `401` refresh rotation.
  - Full multi-tier storefront rate cards, market price spread telemetry, open broadcast bidding, segregated stock bins + upward hierarchy sales, *peshgi* Khata ledger, and live `upi://pay` handover slip deep-linking (`Linking.openURL`).
  - Native `expo-camera` (`CameraView`) + `expo-image-picker` Scrap Material Vision & 7-Segment Digital Scale OCR (`imageBase64` + magic-byte inspection), live hardware QR badge/lineage scanner, ACID `expo-sqlite` (`kabadiwala_field_v1.db` WAL) offline queue persistence across cold restarts, and 100% offline `expo-speech` vernacular readouts (`EN`, `HI`, `PA`, `MR`).

- **Production ONNX Neural Inference, Pluggable Gateways & Containerised DevOps (`Milestone 6` — `M6.1` + `M6.2`):**
  - Real exported & `onnxruntime-web` WASM-executed `.onnx` neural network models (`apps/api/models/scrap_material_classifier_v1.onnx` & `apps/api/models/lcd_scale_ocr_v1.onnx` trained via `npm --workspace @kabadi/api exec tsx scripts/train-and-export-onnx.ts`):
    - **Multi-Material Messy Heap Inference (`3×3` spatial patch tensor `[9, 10]`):** Simultaneously classifies mixed scrap heaps (e.g., Copper wire + Aluminium utensils side-by-side) and triggers `MIXED_MULTI_MATERIAL_HEAP_SEGREGATION_ADVISORY`.
    - **Non-Illuminated Reflective LCD & Printed Weighbridge Paper Slip OCR (`[N, 42]` glyph tensor):** Automatically detects dark-on-light monochrome gray-green LCD screens and white thermal weighbridge tickets alongside illuminated red/green LED scales.
  - Pluggable production SMS/WhatsApp OTP adapters (`MSG91`, `Twilio`, and local `Sandbox` via `SMS_PROVIDER`) + constant-time **HMAC-SHA256 signed payment payout webhook** (`POST /api/v1/webhooks/payments/upi-payout`) with `±5 min` anti-replay timestamp enforcement and `AuditEvent` idempotency.
  - Production `docker-compose.yml` (`PostgreSQL 16` + `Redis 7` distributed rate-limiter store + multi-stage non-root `Dockerfile.api` & `Dockerfile.web`), SHA-256 verified backup/restore scripts (`scripts/backup-postgres.sh`, `scripts/restore-postgres.sh`), and automated GitHub Actions CI pipeline (`.github/workflows/ci.yml`).

- **Self-Hosted AI Suite — Trained Deep Neural Networks, Camera Photo X-Ray, Vernacular NLU & Mandi Forecasting (`Milestone 7` — `M7.1` + `M7.2`):** 100% self-hosted, **zero paid-API cost**; every model is a real Opset-13 `.onnx` graph trained in `ml/`, executed in Node.js via `onnxruntime-web` WASM (CPU, no GPU required at inference).
  - **`ml/train_all.py`** — from-scratch NumPy-autodiff **2D-CNN trainer** (im2col convolution, max-pool, Adam, softmax cross-entropy), which trains, `onnx.checker`-validates, benchmarks on a held-out split, and exports **5 models** into `apps/api/models/`:
    - `scrap_vision_cnn_v2.onnx` — `[B,3,64,64]` RGB → Conv3×3(16) → Conv3×3(32) → GAP → Softmax[6], including **burnt/soot-contaminated copper** as its own class; runs on the full frame + 4 quadrants per scan.
    - `device_xray_cnn_v2.onnx` — **multi-task** shared CNN trunk → `AveragePool(8×8)` spatial 4×4 grid → 3 heads: device `[6]` (Split AC-Cu/Al, Smartphone, Laptop, Ceiling Fan, Washing Machine), **`coil_probs[2]` = COPPER vs ALUMINUM**, and exterior condition `[4]`.
    - `scale_crnn_ocr_v2.onnx` — `[N,1,32,20]` grayscale glyph CNN for LED/LCD/paper-slip digits, robust to glare, shift and thickness changes.
    - `vernacular_intent_nlu_v2.onnx` — `[B,512]` hashed n-gram multilingual NLU (English, Hinglish, **हिन्दी, ਪੰਜਾਬੀ, मराठी**, incl. Indic digits `०–९` / `੦–੯`) → 6 operational intents.
    - `mandi_price_forecaster_v2.onnx` — temporal regression net producing **7-day & 14-day mandi rate projections**, `HOLD_STOCK_FOR_UPSIDE` / `SELL_NOW_STRONG_BID` signals, and under-pricing outlier alerts.
  - **New API surfaces:** `POST /api/v1/ai/xray-estimate` (real camera photo → multi-head CNN → internal component BOM priced against **live `StorefrontRateItem` mandi rates**), `POST /api/v1/ai/assistant` (vernacular voice/chat → ONNX NLU → valuation / forecast / buyer match / **one-click live pickup listing**), `GET /api/v1/ai/market-intelligence`, `POST /api/v1/ai/smart-match` (CPCB-authorisation-aware multi-tier buyer ranking with extra-margin vs street collector).
  - **UI:** Web `CameraAiStudio.tsx` now has 5 tabs (Material Vision · Scale OCR · **Camera Photo X-Ray CNN** · **Vernacular AI Assistant** · **AI Mandi Forecast & Smart Match**); Expo app gained `X-Ray` and `AI Chat` tabs.
  - **REAL-DATA model (not synthetic):** `ml/train_real.py` trains on **2,527 genuine photographs** from the TrashNet dataset (`npm run ml:download-real` → MIT-licensed, fetched from `github.com/garythung/trashnet`), exporting `apps/api/models/real_trashnet_cnn_v1.onnx` with **65.15% accuracy on 505 held-out real photos** (random-weight control 16.04%, **+49.1 pts**). Every camera scan now also returns a `realPhotoGate` — an independent real-photo opinion that flags `realPhotoGateDisagrees` when it contradicts the synthetic-trained spectral verdict.
- **Real Money Payments — Razorpay Gateway with No Dummy Secrets (`M7.4`):** replaces the placeholder signed-webhook stub with a production payment pipeline.
  - **No hardcoded fallback secrets anywhere.** The old `kc-dev-razorpay-…` default is gone; `PAYMENT_WEBHOOK_SECRET` (and every JWT secret) is **required** and the API exits at boot without it. `npm run env:generate` writes 256-bit values, and `.env.example` ships empty placeholders instead of fake secrets.
  - **Server-authoritative amounts:** `POST /api/v1/payments/intents` derives the charge from `finalSettlementPaise ?? agreedTotalPaise ?? indicativeTotalPaise`. The client schema is `.strict()` and rejects any `amountPaise` field, so a tampered browser cannot alter the price.
  - **Two-step confirmation:** the checkout callback is verified with `HMAC_SHA256(order_id|payment_id, key_secret)` **and** the payment is re-fetched from the gateway; only `captured`/`authorized` payments matching the intent amount are credited.
  - **Replay-safe webhooks:** `POST /api/v1/webhooks/payments/razorpay` reads the raw bytes before JSON parsing, verifies `x-razorpay-signature`, and stores every `x-razorpay-event-id` in a unique column — retries return `{ idempotentReplay: true }` and never double-credit.
  - **Admin-only refunds + reconciliation:** `POST /api/v1/payments/intents/:id/refund` (partial or full, audited) and `POST /api/v1/payments/reconcile` for lost-webhook recovery.
  - **Local-first:** `PAYMENT_PROVIDER=mock` runs the identical state machine, signatures and idempotency without moving rupees, so the whole flow is testable offline; `PAYMENT_PROVIDER=razorpay` flips to live UPI/cards with real test keys. Web UI ships a `PaymentCheckoutPanel` inside the settlement slip; `/api/v1/payments/config` exposes only the public key id.
  - **Honest limit:** payouts *out* to a household (`PAYOUT_PROVIDER=razorpayx`) need RazorpayX + current account + KYC; it stays `simulated` until that clears. See `docs/PAYMENTS.md`.

  - **GPU scaling path:** `ml/pytorch_yolo_gpu_trainer.py` (MobileNetV3-small transfer learning + YOLOv8n) exports graphs with **identical tensor contracts**, so retrained weights drop into `apps/api/models/` with zero code changes. `apps/api/scripts/export-active-learning-dataset.ts` (`npm run ml:export-dataset`) closes the loop by exporting human-confirmed field scans into `ml/datasets/`.

---

## Quick Start

```bash
cp .env.example .env
npm install
npm run build:shared
npm run db:generate

# (Optional) Re-train & re-export the original binary .onnx weights + manifest.json
npx tsx apps/api/scripts/train-and-export-onnx.ts

# Train / validate / export the full self-hosted ML suite (5 ONNX models: CNN vision, Camera X-Ray, OCR, NLU, forecaster)
python3 -m venv .venv
.venv/bin/pip install -r ml/requirements.txt
npm run ml:train

# Prove the exported weights are genuinely trained (trained vs random-weight control)
npm run ml:verify

# Generate .env with real 256-bit secrets (API refuses to boot without them)
cp .env.example .env && npm run env:generate

# Retrain on real field photos confirmed by users (active learning)
npm run ml:export-dataset && npm run ml:train

# Run full automated OWASP security, RBAC/BOLA, ONNX ML, Payments & Mobile E2E suite (25 tests)
npm test

# Start API server (port 4000), Next.js Web App (port 3000), or Expo Android Field App
npm run dev:api
npm run dev:web
npm --workspace @kabadi/mobile run start

# Or launch the full containerised stack (PostgreSQL 16 + Redis 7 + API + Web) & run encrypted/checksummed DB backups
docker compose up --build -d
./scripts/backup-postgres.sh ./backups
```

### Local Development Seed Accounts (Illustrative Only)

| Hierarchy Role | Email | Password |
|---|---|---|
| Tier 0 · Customer | `customer@kabadiwala.local` | `KabadiPass123` |
| Tier 1 · Local Collector | `collector@kabadiwala.local` | `KabadiPass123` |
| Tier 2 · Area Scrap Shop | `shop@kabadiwala.local` | `KabadiPass123` |
| Tier 3 · Wholesale Mandi | `wholesale@kabadiwala.local` | `KabadiPass123` |
| Tier 4 · Authorised Recycler | `recycler@kabadiwala.local` | `KabadiPass123` |
| Platform Security Admin | `admin@kabadiwala.local` | `AdminPass123` |
