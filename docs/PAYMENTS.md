# Payments — Real Money Integration (Razorpay)

Status: **implemented and working end-to-end locally**. No dummy secrets remain in the
codebase; the API refuses to boot without real ones.

---

## 1. What changed vs. the old placeholder

| Before | Now |
|---|---|
| Hardcoded fallback webhook secret `kc-dev-razorpay-…-2026` in `env.ts` | Deleted. `PAYMENT_WEBHOOK_SECRET` is **required** (≥32 chars) or the API exits |
| `x-kabadi-signature` header nobody sent | Real Razorpay `x-razorpay-signature` = `HMAC_SHA256(rawBody, webhook_secret)` |
| No order creation | `POST /payments/intents` → server-side amount → gateway order |
| Payment "confirmed" by the client's word | Signature **and** a gateway re-fetch of the payment before crediting |
| No refunds / no reconciliation | Admin-only refunds + `POST /payments/reconcile` sweep |
| `upi://pay` link you can't verify | Full state machine: `CREATED → ATTEMPTED → PAID / FAILED → REFUNDED` |

---

## 2. Getting Razorpay **test** keys (5 minutes, no KYC)

1. Go to <https://dashboard.razorpay.com/signup> and sign up (email + phone only).
2. Make sure the dashboard toggle (top-right) is on **Test Mode**.
3. **Account & Settings → API Keys → Generate Key**.
4. Copy the two values:
   - `rzp_test_XXXXXXXXXXXX` → `RAZORPAY_KEY_ID`
   - the secret shown once → `RAZORPAY_KEY_SECRET`
5. **Account & Settings → Webhooks → Add New Webhook**
   - URL: `https://<your-public-host>/api/v1/webhooks/payments/razorpay`
   - Secret: anything you like, e.g. `openssl rand -hex 32` → `RAZORPAY_WEBHOOK_SECRET`
   - Active events: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`
6. Put them in `.env` (never in chat, never in git):

```bash
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID="rzp_test_XXXXXXXXXXXX"
RAZORPAY_KEY_SECRET="..."
RAZORPAY_WEBHOOK_SECRET="..."
PUBLIC_API_URL="https://<your-public-host>"
```

> **Local webhooks need a public URL.** The gateway cannot reach `localhost`.
> For local end-to-end testing without a tunnel, use `PAYMENT_PROVIDER=mock`
> (full state machine, real HMAC verification) or run
> `cloudflared tunnel --url http://localhost:4000` and use the printed URL.

### Test instruments (Razorpay test mode)

| Scenario | UPI ID / card |
|---|---|
| Success | `success@razorpay` |
| Failure | `failure@razorpay` |
| Card | `4111 1111 1111 1111`, any future expiry, any CVV |

Test-mode money never settles to a bank account.

---

## 3. API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/payments/config` | public | provider, public key id, key environment, checkout script URL, honest disclaimer |
| `POST` | `/api/v1/payments/intents` | participant of the order | creates (or reuses) a payment intent — **amount always derived from the order** |
| `GET` | `/api/v1/payments/intents/:id` | payer/payee/admin | poll status |
| `GET` | `/api/v1/payments/orders/:orderId` | buyer/seller/admin | all intents + `paidPaise` / `payablePaise` |
| `POST` | `/api/v1/payments/intents/:id/verify` | payer | Razorpay checkout callback (`razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`) |
| `POST` | `/api/v1/payments/intents/:id/simulate` | participant | **mock provider only**; blocked in production |
| `POST` | `/api/v1/payments/intents/:id/refund` | ADMIN | full or partial refund, audited |
| `POST` | `/api/v1/payments/reconcile` | ADMIN | sweep stale intents against the gateway |
| `POST` | `/api/v1/webhooks/payments/razorpay` | signature | raw-body HMAC, replay-safe |

### Security invariants

1. **Server-authoritative amount.** `resolvePayableAmountPaise(finalSettlement ?? agreed ?? indicative)`.
   The client schema is `.strict()` and rejects any `amountPaise` field (test 25 asserts a `400`).
2. **Two-step confirmation.** A checkout callback is verified with `HMAC_SHA256(order_id|payment_id, key_secret)`
   *and* the payment is re-fetched from the gateway; only `captured`/`authorized` with a matching amount is credited.
3. **Underpayment cannot settle.** A signed webhook reporting a smaller amount returns `AMOUNT_MISMATCH`
   and leaves the intent open (test 25).
4. **Replay-safe.** Every webhook is stored in `PaymentWebhookEvent` with a unique `providerEventId`;
   a retry returns `{ idempotentReplay: true }` and never double-credits.
5. **Concurrency-safe.** The `CREATED/ATTEMPTED → PAID` transition is a conditional `updateMany`,
   so a webhook racing the checkout callback can only settle once.
6. **No secret leakage.** `/payments/config` only exposes the public key id; test 25 asserts no key secret appears.

---

## 4. Data model

```
PaymentIntent ──1:N── GatewayPayment ──1:N── PaymentRefund
      │
      └── PaymentWebhookEvent (unique providerEventId = idempotency ledger)
```

`PaymentIntent.status` mirrors the money lifecycle; `PaymentRecord` (the pre-existing
ledger used by the settlement slip and Khata) is written exactly once on capture,
with `externalRef = providerPaymentId`.

---

## 5. Payouts (money **out** to a household)

| Mode | Behaviour |
|---|---|
| `PAYOUT_PROVIDER=simulated` (default) | payout is recorded, notified, but no bank transfer occurs |
| `PAYOUT_PROVIDER=razorpayx` | requires RazorpayX activated + current account + KYC — **days of onboarding, not code** |

The API requires `RAZORPAYX_ACCOUNT_NUMBER` when set to `razorpayx`, so it can never
silently pretend to pay.

---

## 6. Verifying it yourself

```bash
npm run env:generate -- --force   # rotate secrets (keeps your gateway keys)
npm run db:push && npm run db:seed
npm run dev:api                   # http://localhost:4000

curl http://localhost:4000/api/v1/payments/config
npm test                          # 25/25, includes payment security suite
```

In the web UI: open any order → **Settlement Slip** → the *Secure Payment* panel appears
under the receipt. With `PAYMENT_PROVIDER=mock` it shows a **Simulate payment** button
(real state machine, no rupees). With `razorpay` it shows **Pay ₹… with UPI / Card**.
