-- ============================================================================
-- Kabadiwala Connect — PostgreSQL Foundation Migration (0001_initial_foundation)
-- Enforces enums, foreign keys, unique constraints, non-negative money/weight
-- CHECK constraints, and append-only database triggers on AuditEvent & Decisions
-- ============================================================================

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'COLLECTOR', 'SCRAP_BUSINESS', 'AUTHORISED_RECYCLER', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SupplyChainTier" AS ENUM (
    'TIER_0_GENERATOR',
    'TIER_1_LOCAL_COLLECTOR',
    'TIER_2_AREA_SHOP',
    'TIER_3_WHOLESALE_AGGREGATOR',
    'TIER_4_AUTHORISED_RECYCLER',
    'PLATFORM_STAFF'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "VerificationLevel" AS ENUM (
    'LEVEL_0_REGISTERED',
    'LEVEL_1_CONTACT_VERIFIED',
    'LEVEL_2_IDENTITY_REVIEWED',
    'LEVEL_3_BUSINESS_VERIFIED',
    'LEVEL_4_AUTHORISED_RECYCLER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "VerificationStatus" AS ENUM (
    'NOT_SUBMITTED',
    'PENDING',
    'UNDER_REVIEW',
    'ACTION_REQUIRED',
    'VERIFIED',
    'REJECTED',
    'EXPIRED',
    'SUSPENDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MaterialUnit" AS ENUM ('KG', 'PIECE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PurityGrade" AS ENUM ('CLEAN_SORTED', 'GRADE_A', 'GRADE_B', 'MIXED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PriceType" AS ENUM (
    'INDICATIVE_ESTIMATE',
    'STOREFRONT_RATE_OR_OFFER',
    'AGREED_PRICE',
    'FINAL_SETTLEMENT'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TransactionStatus" AS ENUM (
    'DRAFT',
    'LISTED',
    'REQUESTED',
    'ACCEPTED',
    'PICKUP_SCHEDULED',
    'COLLECTED',
    'WEIGHED',
    'HANDED_OVER',
    'SETTLED',
    'COMPLETED',
    'CANCELLED',
    'REJECTED',
    'DISPUTED',
    'ON_HOLD'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'UPI_INTENT', 'BANK_TRANSFER', 'LEDGER_OFFSET');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PARTIALLY_PAID', 'PAID', 'DISPUTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Tables
CREATE TABLE IF NOT EXISTS "User" (
  "id" TEXT PRIMARY KEY,
  "phone" TEXT NOT NULL UNIQUE,
  "email" TEXT UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "tier" "SupplyChainTier" NOT NULL,
  "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "verificationLevel" "VerificationLevel" NOT NULL DEFAULT 'LEVEL_0_REGISTERED',
  "platformCode" TEXT NOT NULL UNIQUE,
  "phoneVerifiedAt" TIMESTAMP(3),
  "mfaEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "User_role_tier_idx" ON "User"("role", "tier");
CREATE INDEX IF NOT EXISTS "User_accountStatus_idx" ON "User"("accountStatus");

CREATE TABLE IF NOT EXISTS "UserProfile" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "displayName" TEXT NOT NULL,
  "preferredLanguage" TEXT NOT NULL DEFAULT 'EN',
  "city" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "addressLine" TEXT,
  "publicBio" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "UserProfile_city_pincode_idx" ON "UserProfile"("city", "pincode");

CREATE TABLE IF NOT EXISTS "Organization" (
  "id" TEXT PRIMARY KEY,
  "ownerUserId" TEXT NOT NULL UNIQUE REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tier" "SupplyChainTier" NOT NULL,
  "platformCode" TEXT NOT NULL UNIQUE,
  "businessName" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "serviceRadiusKm" INTEGER NOT NULL DEFAULT 5 CHECK ("serviceRadiusKm" >= 0),
  "verificationLevel" "VerificationLevel" NOT NULL DEFAULT 'LEVEL_0_REGISTERED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Organization_tier_city_pincode_idx" ON "Organization"("tier", "city", "pincode");

CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "familyId" TEXT NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "RefreshToken_userId_familyId_idx" ON "RefreshToken"("userId", "familyId");

CREATE TABLE IF NOT EXISTS "OtpChallenge" (
  "id" TEXT PRIMARY KEY,
  "phone" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "maxAttempts" INTEGER NOT NULL DEFAULT 5 CHECK ("maxAttempts" >= 1),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "OtpChallenge_phone_createdAt_idx" ON "OtpChallenge"("phone", "createdAt");

CREATE TABLE IF NOT EXISTS "LoginAttempt" (
  "id" TEXT PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "userId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "ipAddress" TEXT,
  "succeeded" BOOLEAN NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "LoginAttempt_identifier_createdAt_idx" ON "LoginAttempt"("identifier", "createdAt");

CREATE TABLE IF NOT EXISTS "VerificationCase" (
  "id" TEXT PRIMARY KEY,
  "applicantId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestedLevel" "VerificationLevel" NOT NULL,
  "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
  "notes" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "VerificationCase_applicantId_status_idx" ON "VerificationCase"("applicantId", "status");

CREATE TABLE IF NOT EXISTS "VerificationDocument" (
  "id" TEXT PRIMARY KEY,
  "caseId" TEXT NOT NULL REFERENCES "VerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "documentKind" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL UNIQUE,
  "detectedMime" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" >= 0),
  "sha256Digest" TEXT NOT NULL,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "BusinessRegistration" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL UNIQUE REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "registrationType" TEXT NOT NULL,
  "registrationNumber" TEXT NOT NULL,
  "issuingAuthority" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "RecyclerRegistration" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL UNIQUE REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "authorityName" TEXT NOT NULL,
  "registrationNumber" TEXT NOT NULL UNIQUE,
  "permittedStreams" TEXT[] NOT NULL DEFAULT '{}',
  "authorisedCapacityT" INTEGER CHECK ("authorisedCapacityT" IS NULL OR "authorisedCapacityT" >= 0),
  "cpcbPortalChecked" BOOLEAN NOT NULL DEFAULT FALSE,
  "evidenceSourceUrl" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "validUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "VerificationDecision" (
  "id" TEXT PRIMARY KEY,
  "caseId" TEXT NOT NULL REFERENCES "VerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "reviewerId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "previousStatus" "VerificationStatus" NOT NULL,
  "newStatus" "VerificationStatus" NOT NULL,
  "grantedLevel" "VerificationLevel",
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "MaterialCategory" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "nameEn" TEXT NOT NULL,
  "nameHi" TEXT NOT NULL,
  "namePa" TEXT NOT NULL,
  "streamGroup" TEXT NOT NULL,
  "defaultUnit" "MaterialUnit" NOT NULL DEFAULT 'KG',
  "isRegulatedHazardous" BOOLEAN NOT NULL DEFAULT FALSE,
  "minBuyerVerificationLevel" "VerificationLevel" NOT NULL DEFAULT 'LEVEL_1_CONTACT_VERIFIED',
  "handlingGuidance" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "DeviceReferenceBOM" (
  "id" TEXT PRIMARY KEY,
  "slug" TEXT NOT NULL UNIQUE,
  "deviceCategory" TEXT NOT NULL,
  "brandPattern" TEXT NOT NULL,
  "modelName" TEXT NOT NULL,
  "typicalTotalGrams" INTEGER NOT NULL CHECK ("typicalTotalGrams" >= 0),
  "coilType" TEXT,
  "componentsJson" JSONB NOT NULL,
  "refurbishRangeMinPaise" INTEGER NOT NULL CHECK ("refurbishRangeMinPaise" >= 0),
  "refurbishRangeMaxPaise" INTEGER NOT NULL CHECK ("refurbishRangeMaxPaise" >= 0),
  "partsHarvestMinPaise" INTEGER NOT NULL CHECK ("partsHarvestMinPaise" >= 0),
  "partsHarvestMaxPaise" INTEGER NOT NULL CHECK ("partsHarvestMaxPaise" >= 0),
  "safetyNotes" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Storefront" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL UNIQUE REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "slug" TEXT NOT NULL UNIQUE,
  "shopTitle" TEXT NOT NULL,
  "tagline" TEXT,
  "isOpen" BOOLEAN NOT NULL DEFAULT TRUE,
  "pickupAvailable" BOOLEAN NOT NULL DEFAULT TRUE,
  "dropoffAvailable" BOOLEAN NOT NULL DEFAULT TRUE,
  "minPickupGrams" INTEGER NOT NULL DEFAULT 5000 CHECK ("minPickupGrams" >= 0),
  "servicePincodes" TEXT[] NOT NULL DEFAULT '{}',
  "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 4.8,
  "completedOrdersCnt" INTEGER NOT NULL DEFAULT 0 CHECK ("completedOrdersCnt" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "StorefrontRateItem" (
  "id" TEXT PRIMARY KEY,
  "storefrontId" TEXT NOT NULL REFERENCES "Storefront"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "materialId" TEXT NOT NULL REFERENCES "MaterialCategory"("id") ON UPDATE CASCADE,
  "pickupRatePaise" INTEGER NOT NULL CHECK ("pickupRatePaise" >= 0),
  "dropoffRatePaise" INTEGER NOT NULL CHECK ("dropoffRatePaise" >= 0),
  "minWeightGrams" INTEGER NOT NULL DEFAULT 1000 CHECK ("minWeightGrams" >= 0),
  "purityGrade" "PurityGrade" NOT NULL DEFAULT 'CLEAN_SORTED',
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersededAt" TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "StorefrontRateItem_storefrontId_materialId_isActive_idx"
  ON "StorefrontRateItem"("storefrontId", "materialId", "isActive");

CREATE TABLE IF NOT EXISTS "PriceHistory" (
  "id" TEXT PRIMARY KEY,
  "city" TEXT NOT NULL,
  "tier" "SupplyChainTier" NOT NULL,
  "materialId" TEXT NOT NULL REFERENCES "MaterialCategory"("id") ON UPDATE CASCADE,
  "medianRatePaise" INTEGER NOT NULL CHECK ("medianRatePaise" >= 0),
  "minRatePaise" INTEGER NOT NULL CHECK ("minRatePaise" >= 0),
  "maxRatePaise" INTEGER NOT NULL CHECK ("maxRatePaise" >= 0),
  "sampleCount" INTEGER NOT NULL CHECK ("sampleCount" >= 0),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PriceHistory_city_materialId_recordedAt_idx"
  ON "PriceHistory"("city", "materialId", "recordedAt");

CREATE TABLE IF NOT EXISTS "MaterialListing" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "sellerTier" "SupplyChainTier" NOT NULL,
  "pickupCity" TEXT NOT NULL,
  "pickupPincode" TEXT NOT NULL,
  "pickupAddressPrivate" TEXT NOT NULL,
  "preferredMode" TEXT NOT NULL DEFAULT 'BUYER_PICKUP',
  "indicativeEstimatePaise" INTEGER NOT NULL CHECK ("indicativeEstimatePaise" >= 0),
  "status" "TransactionStatus" NOT NULL DEFAULT 'LISTED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "MaterialListing_ownerId_status_idx" ON "MaterialListing"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "MaterialListing_pickupPincode_status_idx" ON "MaterialListing"("pickupPincode", "status");

CREATE TABLE IF NOT EXISTS "ListingItem" (
  "id" TEXT PRIMARY KEY,
  "listingId" TEXT NOT NULL REFERENCES "MaterialListing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "materialId" TEXT NOT NULL REFERENCES "MaterialCategory"("id") ON UPDATE CASCADE,
  "estimatedGrams" INTEGER NOT NULL CHECK ("estimatedGrams" >= 0),
  "indicativeRatePaise" INTEGER NOT NULL CHECK ("indicativeRatePaise" >= 0),
  "indicativeSubtotalPaise" INTEGER NOT NULL CHECK ("indicativeSubtotalPaise" >= 0),
  "conditionNote" TEXT
);

CREATE TABLE IF NOT EXISTS "ListingPhoto" (
  "id" TEXT PRIMARY KEY,
  "listingId" TEXT NOT NULL REFERENCES "MaterialListing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "storageKey" TEXT NOT NULL,
  "phash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "PurchaseOffer" (
  "id" TEXT PRIMARY KEY,
  "listingId" TEXT NOT NULL REFERENCES "MaterialListing"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "buyerId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "priceType" "PriceType" NOT NULL DEFAULT 'STOREFRONT_RATE_OR_OFFER',
  "offeredTotalPaise" INTEGER NOT NULL CHECK ("offeredTotalPaise" >= 0),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "TransactionOrder" (
  "id" TEXT PRIMARY KEY,
  "orderNumber" TEXT NOT NULL UNIQUE,
  "listingId" TEXT UNIQUE REFERENCES "MaterialListing"("id") ON UPDATE CASCADE,
  "sellerId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "buyerId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "storefrontId" TEXT REFERENCES "Storefront"("id") ON UPDATE CASCADE,
  "sellerTier" "SupplyChainTier" NOT NULL,
  "buyerTier" "SupplyChainTier" NOT NULL,
  "fulfillmentMode" TEXT NOT NULL DEFAULT 'BUYER_PICKUP',
  "status" "TransactionStatus" NOT NULL DEFAULT 'REQUESTED',
  "indicativeTotalPaise" INTEGER NOT NULL CHECK ("indicativeTotalPaise" >= 0),
  "agreedTotalPaise" INTEGER NOT NULL CHECK ("agreedTotalPaise" >= 0),
  "finalSettlementPaise" INTEGER CHECK ("finalSettlementPaise" IS NULL OR "finalSettlementPaise" >= 0),
  "priceAdjustmentReason" TEXT,
  "qrTraceToken" TEXT NOT NULL UNIQUE,
  "scheduledAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "TransactionOrder_sellerId_status_idx" ON "TransactionOrder"("sellerId", "status");
CREATE INDEX IF NOT EXISTS "TransactionOrder_buyerId_status_idx" ON "TransactionOrder"("buyerId", "status");

CREATE TABLE IF NOT EXISTS "OrderItem" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "materialId" TEXT NOT NULL REFERENCES "MaterialCategory"("id") ON UPDATE CASCADE,
  "lockedRatePaise" INTEGER NOT NULL CHECK ("lockedRatePaise" >= 0),
  "purityGrade" "PurityGrade" NOT NULL DEFAULT 'CLEAN_SORTED',
  "estimatedGrams" INTEGER NOT NULL CHECK ("estimatedGrams" >= 0),
  "actualGrams" INTEGER CHECK ("actualGrams" IS NULL OR "actualGrams" >= 0),
  "agreedSubtotalPaise" INTEGER NOT NULL CHECK ("agreedSubtotalPaise" >= 0),
  "finalSubtotalPaise" INTEGER CHECK ("finalSubtotalPaise" IS NULL OR "finalSubtotalPaise" >= 0)
);

CREATE TABLE IF NOT EXISTS "WeighingRecord" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "recordedById" TEXT NOT NULL,
  "totalEstimatedGrams" INTEGER NOT NULL CHECK ("totalEstimatedGrams" >= 0),
  "totalActualGrams" INTEGER NOT NULL CHECK ("totalActualGrams" >= 0),
  "scaleOcrGrams" INTEGER CHECK ("scaleOcrGrams" IS NULL OR "scaleOcrGrams" >= 0),
  "ocrDiscrepancyFlag" BOOLEAN NOT NULL DEFAULT FALSE,
  "scalePhotoKey" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "HandoverRecord" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "sellerConfirmedAt" TIMESTAMP(3),
  "buyerConfirmedAt" TIMESTAMP(3),
  "handoverPincode" TEXT NOT NULL,
  "evidenceHashSha256" TEXT NOT NULL,
  "disclaimerNote" TEXT NOT NULL DEFAULT 'Platform handover receipt — not a statutory government recycling certificate.',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "PaymentRecord" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "amountPaise" INTEGER NOT NULL CHECK ("amountPaise" >= 0),
  "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "externalRef" TEXT,
  "recordedById" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Dispute" (
  "id" TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON UPDATE CASCADE,
  "raisedById" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "resolvedById" TEXT REFERENCES "User"("id") ON UPDATE CASCADE,
  "reasonCategory" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
  "resolutionNotes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "InventoryBin" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "materialId" TEXT NOT NULL REFERENCES "MaterialCategory"("id") ON UPDATE CASCADE,
  "availableGrams" INTEGER NOT NULL DEFAULT 0 CHECK ("availableGrams" >= 0),
  "weightedAvgCostPaise" INTEGER NOT NULL DEFAULT 0 CHECK ("weightedAvgCostPaise" >= 0),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "materialId")
);

CREATE TABLE IF NOT EXISTS "DismantlingRecord" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "inputDescription" TEXT NOT NULL,
  "inputGrams" INTEGER NOT NULL CHECK ("inputGrams" >= 0),
  "outputsJson" JSONB NOT NULL,
  "residueGrams" INTEGER NOT NULL DEFAULT 0 CHECK ("residueGrams" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "BatchLineage" (
  "id" TEXT PRIMARY KEY,
  "parentBulkOrderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON UPDATE CASCADE,
  "childSourceOrderId" TEXT NOT NULL REFERENCES "TransactionOrder"("id") ON UPDATE CASCADE,
  "attributedGrams" INTEGER NOT NULL CHECK ("attributedGrams" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("parentBulkOrderId", "childSourceOrderId")
);

CREATE TABLE IF NOT EXISTS "KhataLedgerEntry" (
  "id" TEXT PRIMARY KEY,
  "lenderId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "borrowerId" TEXT NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE,
  "entryType" TEXT NOT NULL,
  "amountPaise" INTEGER NOT NULL CHECK ("amountPaise" >= 0),
  "balanceAfterPaise" INTEGER NOT NULL,
  "relatedOrderId" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "KhataLedgerEntry_lenderId_borrowerId_createdAt_idx"
  ON "KhataLedgerEntry"("lenderId", "borrowerId", "createdAt");

CREATE TABLE IF NOT EXISTS "AIScanRecord" (
  "id" TEXT PRIMARY KEY,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "scanType" TEXT NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL CHECK ("confidence" >= 0 AND "confidence" <= 1),
  "requiresHumanConfirm" BOOLEAN NOT NULL DEFAULT TRUE,
  "humanConfirmedAt" TIMESTAMP(3),
  "structuredResultJson" JSONB NOT NULL,
  "indicativeMinPaise" INTEGER CHECK ("indicativeMinPaise" IS NULL OR "indicativeMinPaise" >= 0),
  "indicativeMaxPaise" INTEGER CHECK ("indicativeMaxPaise" IS NULL OR "indicativeMaxPaise" >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SyncOperation" (
  "id" TEXT PRIMARY KEY,
  "actorId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "idempotencyKey" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "clientEntityId" TEXT NOT NULL,
  "payloadJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'APPLIED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("actorId", "idempotencyKey")
);

CREATE TABLE IF NOT EXISTS "Notification" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

CREATE TABLE IF NOT EXISTS "AuditEvent" (
  "id" TEXT PRIMARY KEY,
  "actorId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "actorRole" TEXT,
  "action" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "outcome" TEXT NOT NULL,
  "reason" TEXT,
  "metadataJson" JSONB,
  "correlationId" TEXT NOT NULL,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");
CREATE INDEX IF NOT EXISTS "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent"("resourceType", "resourceId");
CREATE INDEX IF NOT EXISTS "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- 3. Append-Only Database Triggers (Immutability Guarantee on Audit Logs)
CREATE OR REPLACE FUNCTION prevent_append_only_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Allow ON DELETE SET NULL when parent User is purged if ever triggered by FK, block everything else
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Security Violation: % records are strictly append-only and cannot be deleted', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD."action" IS DISTINCT FROM NEW."action" OR
    OLD."resourceType" IS DISTINCT FROM NEW."resourceType" OR
    OLD."resourceId" IS DISTINCT FROM NEW."resourceId" OR
    OLD."outcome" IS DISTINCT FROM NEW."outcome" OR
    OLD."reason" IS DISTINCT FROM NEW."reason" OR
    OLD."metadataJson" IS DISTINCT FROM NEW."metadataJson" OR
    OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
  ) THEN
    RAISE EXCEPTION 'Security Violation: % records are strictly append-only and cannot be modified', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_immutable_trg ON "AuditEvent";
CREATE TRIGGER audit_event_immutable_trg
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

-- 4. Milestone 2 Additive Schema Columns (Safe Idempotent Upgrade on Existing & Fresh DBs)
ALTER TABLE "MaterialCategory" ADD COLUMN IF NOT EXISTS "nameMr" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AIScanRecord" ADD COLUMN IF NOT EXISTS "imageSha256" TEXT;
ALTER TABLE "AIScanRecord" ADD COLUMN IF NOT EXISTS "perceptualHash" TEXT;
ALTER TABLE "AIScanRecord" ADD COLUMN IF NOT EXISTS "mediaStorageKey" TEXT;
CREATE INDEX IF NOT EXISTS "AIScanRecord_imageSha256_idx" ON "AIScanRecord"("imageSha256");

