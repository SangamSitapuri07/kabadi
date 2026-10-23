import { z } from "zod";

// ============================================================================
// 1. ROLES, SUPPLY-CHAIN TIERS & HONEST VERIFICATION LEVELS
// ============================================================================

export const USER_ROLES = [
  "CUSTOMER",
  "COLLECTOR",
  "SCRAP_BUSINESS",
  "AUTHORISED_RECYCLER",
  "ADMIN",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Public sign-up MUST NEVER allow self-creating an ADMIN account */
export const PUBLIC_REGISTRATION_ROLES = [
  "CUSTOMER",
  "COLLECTOR",
  "SCRAP_BUSINESS",
  "AUTHORISED_RECYCLER",
] as const;
export type PublicRegistrationRole = (typeof PUBLIC_REGISTRATION_ROLES)[number];

export const SUPPLY_CHAIN_TIERS = [
  "TIER_0_GENERATOR",
  "TIER_1_LOCAL_COLLECTOR",
  "TIER_2_AREA_SHOP",
  "TIER_3_WHOLESALE_AGGREGATOR",
  "TIER_4_AUTHORISED_RECYCLER",
  "PLATFORM_STAFF",
] as const;
export type SupplyChainTier = (typeof SUPPLY_CHAIN_TIERS)[number];

export const VERIFICATION_LEVELS = [
  "LEVEL_0_REGISTERED",
  "LEVEL_1_CONTACT_VERIFIED",
  "LEVEL_2_IDENTITY_REVIEWED",
  "LEVEL_3_BUSINESS_VERIFIED",
  "LEVEL_4_AUTHORISED_RECYCLER",
] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

export const VERIFICATION_STATUSES = [
  "NOT_SUBMITTED",
  "PENDING",
  "UNDER_REVIEW",
  "ACTION_REQUIRED",
  "VERIFIED",
  "REJECTED",
  "EXPIRED",
  "SUSPENDED",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const SUPPORTED_LANGUAGES = ["EN", "HI", "PA", "MR"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// ============================================================================
// 2. HONEST PRICING & TRANSACTION STATE MACHINE CONSTANTS
// ============================================================================

export const PRICE_TYPES = [
  "INDICATIVE_ESTIMATE",
  "STOREFRONT_RATE_OR_OFFER",
  "AGREED_PRICE",
  "FINAL_SETTLEMENT",
] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const TRANSACTION_STATUSES = [
  "DRAFT",
  "LISTED",
  "REQUESTED",
  "ACCEPTED",
  "PICKUP_SCHEDULED",
  "COLLECTED",
  "WEIGHED",
  "HANDED_OVER",
  "SETTLED",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
  "DISPUTED",
  "ON_HOLD",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const VALID_TRANSACTION_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  DRAFT: ["LISTED", "REQUESTED", "CANCELLED"],
  LISTED: ["REQUESTED", "ACCEPTED", "CANCELLED"],
  REQUESTED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PICKUP_SCHEDULED", "COLLECTED", "CANCELLED", "DISPUTED", "ON_HOLD"],
  PICKUP_SCHEDULED: ["COLLECTED", "CANCELLED", "DISPUTED", "ON_HOLD"],
  COLLECTED: ["WEIGHED", "DISPUTED", "ON_HOLD"],
  WEIGHED: ["HANDED_OVER", "DISPUTED", "ON_HOLD"],
  HANDED_OVER: ["SETTLED", "DISPUTED", "ON_HOLD"],
  SETTLED: ["COMPLETED", "DISPUTED"],
  COMPLETED: ["DISPUTED"],
  CANCELLED: [],
  REJECTED: [],
  DISPUTED: ["ON_HOLD", "SETTLED", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ACCEPTED", "COLLECTED", "WEIGHED", "CANCELLED", "DISPUTED"],
};

export function canTransitionTransaction(
  from: TransactionStatus,
  to: TransactionStatus
): boolean {
  return VALID_TRANSACTION_TRANSITIONS[from].includes(to);
}

// ============================================================================
// 3. RBAC PERMISSION CAPABILITIES MATRIX
// ============================================================================

export const CAPABILITIES = [
  "profile:read:own",
  "profile:update:own",
  "storefront:manage:own",
  "listing:create",
  "listing:read",
  "offer:create",
  "transaction:participate",
  "verification:submit",
  "verification:review:admin",
  "ai:scan",
  "audit:read:admin",
  "users:manage:admin",
  "dispute:raise",
  "dispute:resolve:admin",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  CUSTOMER: [
    "profile:read:own",
    "profile:update:own",
    "listing:create",
    "listing:read",
    "transaction:participate",
    "verification:submit",
    "ai:scan",
    "dispute:raise",
  ],
  COLLECTOR: [
    "profile:read:own",
    "profile:update:own",
    "storefront:manage:own",
    "listing:create",
    "listing:read",
    "offer:create",
    "transaction:participate",
    "verification:submit",
    "ai:scan",
    "dispute:raise",
  ],
  SCRAP_BUSINESS: [
    "profile:read:own",
    "profile:update:own",
    "storefront:manage:own",
    "listing:create",
    "listing:read",
    "offer:create",
    "transaction:participate",
    "verification:submit",
    "ai:scan",
    "dispute:raise",
  ],
  AUTHORISED_RECYCLER: [
    "profile:read:own",
    "profile:update:own",
    "storefront:manage:own",
    "listing:create",
    "listing:read",
    "offer:create",
    "transaction:participate",
    "verification:submit",
    "ai:scan",
    "dispute:raise",
  ],
  ADMIN: [
    "profile:read:own",
    "profile:update:own",
    "listing:read",
    "verification:review:admin",
    "ai:scan",
    "audit:read:admin",
    "users:manage:admin",
    "dispute:resolve:admin",
  ],
};

export function roleHasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function resolveDefaultTierForRole(
  role: PublicRegistrationRole,
  requestedTier?: "TIER_2_AREA_SHOP" | "TIER_3_WHOLESALE_AGGREGATOR"
): SupplyChainTier {
  switch (role) {
    case "CUSTOMER":
      return "TIER_0_GENERATOR";
    case "COLLECTOR":
      return "TIER_1_LOCAL_COLLECTOR";
    case "SCRAP_BUSINESS":
      return requestedTier === "TIER_3_WHOLESALE_AGGREGATOR"
        ? "TIER_3_WHOLESALE_AGGREGATOR"
        : "TIER_2_AREA_SHOP";
    case "AUTHORISED_RECYCLER":
      return "TIER_4_AUTHORISED_RECYCLER";
  }
}

export function platformPrefixForTier(tier: SupplyChainTier): string {
  switch (tier) {
    case "TIER_0_GENERATOR":
      return "KC-CUS";
    case "TIER_1_LOCAL_COLLECTOR":
      return "KC-COL";
    case "TIER_2_AREA_SHOP":
      return "KC-SHP";
    case "TIER_3_WHOLESALE_AGGREGATOR":
      return "KC-WHL";
    case "TIER_4_AUTHORISED_RECYCLER":
      return "KC-REC";
    case "PLATFORM_STAFF":
      return "KC-ADM";
  }
}

// ============================================================================
// 4. EXACT INTEGER MINOR-UNIT MONEY HELPERS (PAISE <-> INR DISPLAY)
// ============================================================================

export function inrToPaise(rupees: number): number {
  if (!Number.isFinite(rupees) || rupees < 0) {
    throw new Error("Monetary amount must be a finite non-negative number");
  }
  return Math.round(rupees * 100);
}

export function paiseToInrString(paise: number): string {
  const safe = Math.trunc(paise);
  const whole = Math.floor(Math.abs(safe) / 100);
  const frac = Math.abs(safe) % 100;
  const sign = safe < 0 ? "-" : "";
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

export function calculateAmountPaise(weightKgMilli: number, ratePerUnitPaise: number, unit: "KG" | "PIECE"): number {
  if (weightKgMilli < 0 || ratePerUnitPaise < 0) {
    throw new Error("Weight and rate must be non-negative");
  }
  if (unit === "PIECE") {
    // weightKgMilli stores integer piece count * 1000 or exact pieces
    return Math.round((weightKgMilli * ratePerUnitPaise) / 1000);
  }
  // weightKgMilli = grams (1 kg = 1000 g), avoiding all floating-point error!
  return Math.round((weightKgMilli * ratePerUnitPaise) / 1000);
}

// ============================================================================
// 5. STRICT ZOD DTO SCHEMAS (BLOCKS MASS ASSIGNMENT & ROLE ESCALATION)
// ============================================================================

export const RegisterRequestSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^\+?[6-9]\d{9,12}$/, "Enter a valid mobile number"),
    email: z.string().trim().email().max(160).optional(),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128)
      .regex(/[A-Z]/, "Must include at least one uppercase letter")
      .regex(/[a-z]/, "Must include at least one lowercase letter")
      .regex(/[0-9]/, "Must include at least one number"),
    displayName: z.string().trim().min(2).max(100),
    role: z.enum(PUBLIC_REGISTRATION_ROLES),
    businessTier: z.enum(["TIER_2_AREA_SHOP", "TIER_3_WHOLESALE_AGGREGATOR"]).optional(),
    businessName: z.string().trim().min(2).max(140).optional(),
    city: z.string().trim().min(2).max(80).default("Ludhiana"),
    pincode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "Enter a valid 6-digit Indian PIN code")
      .default("141001"),
    preferredLanguage: z.enum(SUPPORTED_LANGUAGES).default("EN"),
  })
  .strict();

export const LoginRequestSchema = z
  .object({
    identifier: z.string().trim().min(3).max(160), // phone or email
    password: z.string().min(1).max(128),
  })
  .strict();

export const RequestOtpSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^\+?[6-9]\d{9,12}$/),
  })
  .strict();

export const VerifyOtpSchema = z
  .object({
    phone: z
      .string()
      .trim()
      .regex(/^\+?[6-9]\d{9,12}$/),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/),
  })
  .strict();

/** Notice `.strict()` rejects any attempt to send `role`, `verificationLevel`, `platformCode`, or `accountStatus` */
export const UpdateOwnProfileSchema = z
  .object({
    displayName: z.string().trim().min(2).max(100).optional(),
    preferredLanguage: z.enum(SUPPORTED_LANGUAGES).optional(),
    city: z.string().trim().min(2).max(80).optional(),
    pincode: z
      .string()
      .trim()
      .regex(/^\d{6}$/)
      .optional(),
    addressLine: z.string().trim().min(4).max(240).optional(),
  })
  .strict();

export const SubmitVerificationCaseSchema = z
  .object({
    requestedLevel: z.enum([
      "LEVEL_2_IDENTITY_REVIEWED",
      "LEVEL_3_BUSINESS_VERIFIED",
      "LEVEL_4_AUTHORISED_RECYCLER",
    ]),
    registrationType: z
      .enum(["IDENTITY_DOC", "SHOP_ACT_UDYAM", "GSTIN", "CPCB_SPCB_EPR"])
      .optional(),
    registrationNumber: z.string().trim().min(4).max(80).optional(),
    issuingAuthority: z.string().trim().min(2).max(120).optional(),
    permittedStreams: z.array(z.string().trim().min(2).max(60)).max(20).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

export const AdminVerificationDecisionSchema = z
  .object({
    decision: z.enum(["VERIFIED", "REJECTED", "ACTION_REQUIRED", "SUSPENDED"]),
    reason: z.string().trim().min(5).max(500),
    officialSourceChecked: z.boolean().default(false),
    evidenceReferenceUrl: z.string().trim().max(260).optional(),
  })
  .strict();

export const UpsertStorefrontRateSchema = z
  .object({
    materialSlug: z.string().trim().min(2).max(80),
    pickupRatePaise: z.number().int().min(0).max(50_000_000),
    dropoffRatePaise: z.number().int().min(0).max(50_000_000),
    minWeightGrams: z.number().int().min(100).max(100_000_000),
    purityGrade: z.enum(["CLEAN_SORTED", "GRADE_A", "GRADE_B", "MIXED"]).default("CLEAN_SORTED"),
  })
  .strict();

export const CreateMaterialListingSchema = z
  .object({
    title: z.string().trim().min(3).max(140),
    pickupPincode: z.string().trim().regex(/^\d{6}$/),
    pickupAddressPrivate: z.string().trim().min(5).max(240),
    preferredMode: z.enum(["BUYER_PICKUP", "SELLER_DROPOFF"]).default("BUYER_PICKUP"),
    targetStorefrontId: z.string().uuid().optional(),
    items: z
      .array(
        z
          .object({
            materialSlug: z.string().trim().min(2).max(80),
            estimatedGrams: z.number().int().min(50).max(50_000_000),
            conditionNote: z.string().trim().max(200).optional(),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict();

export const RecordWeighingSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            orderItemId: z.string().uuid(),
            actualGrams: z.number().int().min(0).max(50_000_000),
          })
          .strict()
      )
      .min(1),
    adjustmentPaise: z.number().int().min(-5_000_000).max(5_000_000).default(0),
    adjustmentReason: z.string().trim().min(4).max(240).optional(),
    scaleOcrGrams: z.number().int().min(0).max(50_000_000).optional(),
    scaleScanId: z.string().uuid().optional(),
    paymentMethod: z
      .enum(["CASH", "UPI_INTENT", "BANK_TRANSFER", "LEDGER_OFFSET"])
      .default("CASH"),
    autoOffsetKhataAdvance: z.boolean().default(true),
  })
  .strict();

export const CreatePurchaseOfferSchema = z
  .object({
    offeredTotalPaise: z.number().int().min(100).max(500_000_000),
    notes: z.string().trim().max(300).optional(),
  })
  .strict();

export const CreateDismantlingSchema = z
  .object({
    inputDescription: z.string().trim().min(3).max(160),
    inputGrams: z.number().int().min(100).max(50_000_000),
    residueGrams: z.number().int().min(0).max(50_000_000).default(0),
    outputs: z
      .array(
        z
          .object({
            materialSlug: z.string().trim().min(2).max(80),
            outputGrams: z.number().int().min(10).max(50_000_000),
          })
          .strict()
      )
      .min(1)
      .max(15),
  })
  .strict();

export const SellBinUpwardSchema = z
  .object({
    sellGrams: z.number().int().min(100).max(100_000_000),
    targetStorefrontId: z.string().uuid(),
    fulfillmentMode: z.enum(["BUYER_PICKUP", "SELLER_DROPOFF"]).default("SELLER_DROPOFF"),
  })
  .strict();

export const CreateKhataAdvanceSchema = z
  .object({
    borrowerPlatformCode: z.string().trim().min(6).max(30),
    amountPaise: z.number().int().min(100).max(100_000_000),
    entryType: z.enum(["CASH_ADVANCE_GIVEN", "CASH_REPAYMENT"]).default("CASH_ADVANCE_GIVEN"),
    notes: z.string().trim().max(240).optional(),
  })
  .strict();

export const DeviceXrayScanRequestSchema = z
  .object({
    deviceQuery: z.string().trim().min(2).max(120),
    observedCondition: z.enum([
      "POWERS_ON_INTACT",
      "CRACKED_SCREEN_BOOTS",
      "DEAD_BOOT_INTACT_BODY",
      "HEAVILY_DAMAGED_SCRAP",
    ]),
    coilTypeHint: z.enum(["COPPER", "ALUMINUM", "UNKNOWN"]).default("UNKNOWN"),
    city: z.string().trim().min(2).max(80).default("Ludhiana"),
  })
  .strict();

export const VisionMaterialScanFieldsSchema = z
  .object({
    estimatedGrams: z.coerce.number().int().min(10).max(50_000_000).default(5000),
    deviceQuery: z.string().trim().max(120).optional(),
    observedCondition: z
      .enum([
        "POWERS_ON_INTACT",
        "CRACKED_SCREEN_BOOTS",
        "DEAD_BOOT_INTACT_BODY",
        "HEAVILY_DAMAGED_SCRAP",
      ])
      .default("DEAD_BOOT_INTACT_BODY"),
    city: z.string().trim().min(2).max(80).default("Ludhiana"),
    language: z.enum(SUPPORTED_LANGUAGES).default("EN"),
    orderId: z.string().uuid().optional(),
    imageBase64: z.string().max(7_000_000).optional(),
  })
  .strict();

export const ScaleOcrVerifyFieldsSchema = z
  .object({
    declaredGrams: z.coerce.number().int().min(10).max(50_000_000),
    orderId: z.string().uuid().optional(),
    language: z.enum(SUPPORTED_LANGUAGES).default("EN"),
    imageBase64: z.string().max(7_000_000).optional(),
  })
  .strict();

export const VernacularSpeechScriptRequestSchema = z
  .object({
    contextType: z.enum([
      "STOREFRONT_RATES",
      "VISION_SCAN",
      "SCALE_VERDICT",
      "ORDER_SUMMARY",
    ]),
    language: z.enum(SUPPORTED_LANGUAGES).default("HI"),
    storefrontId: z.string().uuid().optional(),
    scanId: z.string().uuid().optional(),
    orderId: z.string().uuid().optional(),
  })
  .strict();

export const AdminUserStatusSchema = z
  .object({
    accountStatus: z.enum(ACCOUNT_STATUSES),
    reason: z.string().trim().min(5).max(400),
  })
  .strict();

export const OfflineSyncOperationItemSchema = z
  .object({
    idempotencyKey: z.string().trim().min(6).max(120),
    clientEntityId: z.string().trim().min(3).max(120),
    operationType: z.enum([
      "DRAFT_LISTING_CREATE",
      "KHATA_ADVANCE_RECORD",
      "DISMANTLING_LOG",
    ]),
    createdAtIso: z.string().trim().optional(),
    payload: z.record(z.unknown()),
  })
  .strict();

export const OfflineSyncBatchSchema = z
  .object({
    deviceLabel: z.string().trim().max(80).default("Field Mobile App"),
    operations: z.array(OfflineSyncOperationItemSchema).min(1).max(50),
  })
  .strict();

export const CreateDisputeSchema = z
  .object({
    reasonCategory: z.enum([
      "WEIGHT_DISCREPANCY",
      "PRICE_CHANGE",
      "PAYMENT_PENDING",
      "GRADE_DISPUTE",
    ]),
    description: z.string().trim().min(8).max(800),
  })
  .strict();

export const AdminResolveDisputeSchema = z
  .object({
    decision: z.enum([
      "UNDER_REVIEW",
      "RESOLVED_ADJUSTED",
      "RESOLVED_CANCELLED",
      "REJECTED",
    ]),
    resolutionNotes: z.string().trim().min(6).max(600),
    adjustedSettlementPaise: z.number().int().min(0).max(500_000_000).optional(),
  })
  .strict();

export type RegisterRequestInput = z.infer<typeof RegisterRequestSchema>;
export type LoginRequestInput = z.infer<typeof LoginRequestSchema>;
