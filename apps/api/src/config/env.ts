import dotenv from "dotenv";
import path from "path";
import { z } from "zod";
import { WORKSPACE_ROOT } from "../lib/paths";

// Load workspace root .env cleanly from both TypeScript source & compiled dist/
dotenv.config({ path: path.join(WORKSPACE_ROOT, ".env") });
dotenv.config();

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
    DATABASE_URL: z
      .string()
      .min(10)
      .default("postgresql://postgres:postgres@127.0.0.1:5432/kabadiwala?sslmode=disable"),
    USE_EXTERNAL_POSTGRES: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    REDIS_URL: z.string().optional(),
    SMS_PROVIDER: z.enum(["sandbox", "msg91", "twilio"]).default("sandbox"),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_TEMPLATE_ID: z.string().optional(),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM_NUMBER: z.string().optional(),

    // ---------------------------------------------------------------------
    // PAYMENTS — no fallback secrets. The API refuses to boot without them.
    // ---------------------------------------------------------------------
    PAYMENT_PROVIDER: z.enum(["mock", "razorpay"]).default("mock"),
    PAYMENT_CURRENCY: z.string().length(3).default("INR"),
    /** Server-side HMAC secret for legacy/simulated payout callbacks. Required. */
    PAYMENT_WEBHOOK_SECRET: z.string().min(32),
    RAZORPAY_KEY_ID: z.string().trim().min(8).optional(),
    RAZORPAY_KEY_SECRET: z.string().trim().min(8).optional(),
    /** Razorpay dashboard → Settings → Webhooks → Secret. Separate from PAYMENT_WEBHOOK_SECRET. */
    RAZORPAY_WEBHOOK_SECRET: z.string().trim().min(16).optional(),
    /** Enables the local "simulate payment" endpoint. Forced off in production. */
    ALLOW_PAYMENT_SIMULATION: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    PAYOUT_PROVIDER: z.enum(["simulated", "razorpayx"]).default("simulated"),
    RAZORPAYX_ACCOUNT_NUMBER: z.string().trim().optional(),

    VAULT_STORAGE_DRIVER: z.enum(["local-fs", "s3-compatible"]).default("local-fs"),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    SIGNED_URL_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().min(3).default("kabadiwala-connect-api"),
    JWT_AUDIENCE: z.string().min(3).default("kabadiwala-connect-clients"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default("http://localhost:3000,http://127.0.0.1:3000"),
  })
  .superRefine((value, ctx) => {
    // Cross-field validation: selecting the Razorpay adapter without credentials
    // must fail loudly at boot instead of silently degrading to fake payments.
    if (value.PAYMENT_PROVIDER === "razorpay") {
      if (!value.RAZORPAY_KEY_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RAZORPAY_KEY_ID"],
          message: "RAZORPAY_KEY_ID is required when PAYMENT_PROVIDER=razorpay",
        });
      }
      if (!value.RAZORPAY_KEY_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RAZORPAY_KEY_SECRET"],
          message: "RAZORPAY_KEY_SECRET is required when PAYMENT_PROVIDER=razorpay",
        });
      }
      if (!value.RAZORPAY_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["RAZORPAY_WEBHOOK_SECRET"],
          message:
            "RAZORPAY_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=razorpay (dashboard → Webhooks → Secret)",
        });
      }
    }
    if (value.PAYOUT_PROVIDER === "razorpayx" && !value.RAZORPAYX_ACCOUNT_NUMBER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAYX_ACCOUNT_NUMBER"],
        message:
          "RAZORPAYX_ACCOUNT_NUMBER is required when PAYOUT_PROVIDER=razorpayx",
      });
    }
    if (value.NODE_ENV === "production" && value.PAYMENT_PROVIDER === "mock") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["PAYMENT_PROVIDER"],
        message: "PAYMENT_PROVIDER=mock is not permitted when NODE_ENV=production",
      });
    }
  });

const parsed = EnvSchema.safeParse({
  ...process.env,
  ...(process.env.NODE_ENV === "test"
    ? {
        JWT_ACCESS_SECRET:
          process.env.JWT_ACCESS_SECRET ??
          "test-only-access-secret-key-min-32-characters-long-001",
        JWT_REFRESH_SECRET:
          process.env.JWT_REFRESH_SECRET ??
          "test-only-refresh-secret-key-min-32-characters-long-002",
        SIGNED_URL_SECRET:
          process.env.SIGNED_URL_SECRET ??
          "test-only-signed-url-secret-min-32-characters-long-003",
        PAYMENT_WEBHOOK_SECRET:
          process.env.PAYMENT_WEBHOOK_SECRET ??
          "test-only-payment-webhook-secret-min-32-characters-004",
      }
    : {}),
});

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Effective payment runtime description used by /health and the config endpoint,
 * so operators can always tell whether real money can move.
 */
export function describePaymentRuntime() {
  const isMock = env.PAYMENT_PROVIDER === "mock";
  const simulationAllowed =
    env.ALLOW_PAYMENT_SIMULATION && env.NODE_ENV !== "production";
  return {
    provider: env.PAYMENT_PROVIDER,
    currency: env.PAYMENT_CURRENCY,
    liveMoneyEnabled: !isMock,
    credentialsConfigured: isMock
      ? true
      : Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    webhookSecretConfigured: Boolean(
      env.PAYMENT_PROVIDER === "razorpay"
        ? env.RAZORPAY_WEBHOOK_SECRET
        : env.PAYMENT_WEBHOOK_SECRET
    ),
    simulationAllowed,
    payoutProvider: env.PAYOUT_PROVIDER,
    payoutLive: env.PAYOUT_PROVIDER === "razorpayx",
    publicWebhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/webhooks/payments/razorpay`,
  };
}
