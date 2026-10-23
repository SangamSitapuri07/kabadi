-- ============================================================================
-- Kabadiwala Connect — Payment Gateway Migration (0002_payments_gateway)
-- Real-money state machine (Razorpay) with server-authoritative amounts,
-- refund ledger, and a replay-safe webhook idempotency table.
-- Idempotent by design: safe to re-run on every API boot.
-- ============================================================================

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE "PaymentProviderKind" AS ENUM ('MOCK', 'RAZORPAY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentIntentStatus" AS ENUM ('CREATED', 'ATTEMPTED', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "GatewayPaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentRefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WebhookProcessingStatus" AS ENUM ('PROCESSED', 'DUPLICATE', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Payment intents (one per checkout attempt, amount pinned server-side)
CREATE TABLE IF NOT EXISTS "PaymentIntent" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "intentNumber"    TEXT NOT NULL,
  "orderId"         TEXT NOT NULL,
  "payerId"         TEXT NOT NULL,
  "payeeId"         TEXT,
  "purpose"         TEXT NOT NULL DEFAULT 'ORDER_SETTLEMENT',
  "provider"        "PaymentProviderKind" NOT NULL,
  "providerOrderId" TEXT NOT NULL,
  "amountPaise"     INTEGER NOT NULL,
  "currency"        TEXT NOT NULL DEFAULT 'INR',
  "status"          "PaymentIntentStatus" NOT NULL DEFAULT 'CREATED',
  "description"     TEXT,
  "receipt"         TEXT,
  "failureReason"   TEXT,
  "expiresAt"       TIMESTAMP(3),
  "paidAt"          TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Gateway payments (what the PSP actually charged)
CREATE TABLE IF NOT EXISTS "GatewayPayment" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "intentId"          TEXT NOT NULL,
  "providerPaymentId" TEXT NOT NULL,
  "status"            "GatewayPaymentStatus" NOT NULL DEFAULT 'CREATED',
  "method"            TEXT,
  "amountPaise"       INTEGER NOT NULL,
  "feePaise"          INTEGER NOT NULL DEFAULT 0,
  "taxPaise"          INTEGER NOT NULL DEFAULT 0,
  "capturedAt"        TIMESTAMP(3),
  "failureReason"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Refund ledger
CREATE TABLE IF NOT EXISTS "PaymentRefund" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "intentId"         TEXT NOT NULL,
  "paymentId"        TEXT,
  "providerRefundId" TEXT NOT NULL,
  "amountPaise"      INTEGER NOT NULL,
  "status"           "PaymentRefundStatus" NOT NULL DEFAULT 'PENDING',
  "reason"           TEXT NOT NULL,
  "initiatedById"    TEXT NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"      TIMESTAMP(3)
);

-- 5. Webhook idempotency ledger
CREATE TABLE IF NOT EXISTS "PaymentWebhookEvent" (
  "id"                TEXT NOT NULL PRIMARY KEY,
  "provider"          "PaymentProviderKind" NOT NULL,
  "providerEventId"   TEXT NOT NULL,
  "eventType"         TEXT NOT NULL,
  "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
  "status"            "WebhookProcessingStatus" NOT NULL DEFAULT 'PROCESSED',
  "rawPayload"        TEXT NOT NULL,
  "failureReason"     TEXT,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"       TIMESTAMP(3)
);

-- 6. Indexes & uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_intentNumber_key" ON "PaymentIntent"("intentNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_providerOrderId_key" ON "PaymentIntent"("providerOrderId");
CREATE INDEX IF NOT EXISTS "PaymentIntent_orderId_status_idx" ON "PaymentIntent"("orderId", "status");
CREATE INDEX IF NOT EXISTS "PaymentIntent_payerId_createdAt_idx" ON "PaymentIntent"("payerId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "GatewayPayment_providerPaymentId_key" ON "GatewayPayment"("providerPaymentId");
CREATE INDEX IF NOT EXISTS "GatewayPayment_intentId_status_idx" ON "GatewayPayment"("intentId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRefund_providerRefundId_key" ON "PaymentRefund"("providerRefundId");
CREATE INDEX IF NOT EXISTS "PaymentRefund_intentId_status_idx" ON "PaymentRefund"("intentId", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentWebhookEvent_providerEventId_key" ON "PaymentWebhookEvent"("providerEventId");
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_provider_eventType_idx" ON "PaymentWebhookEvent"("provider", "eventType");
CREATE INDEX IF NOT EXISTS "PaymentWebhookEvent_receivedAt_idx" ON "PaymentWebhookEvent"("receivedAt");

-- 7. Foreign keys
DO $$ BEGIN
  ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "TransactionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "GatewayPayment" ADD CONSTRAINT "GatewayPayment_intentId_fkey"
    FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_intentId_fkey"
    FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "GatewayPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 8. Money integrity constraints (never allow negative or zero charges)
DO $$ BEGIN
  ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_amount_positive_check" CHECK ("amountPaise" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "GatewayPayment" ADD CONSTRAINT "GatewayPayment_amount_positive_check" CHECK ("amountPaise" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_amount_positive_check" CHECK ("amountPaise" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
