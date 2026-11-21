import dotenv from "dotenv";
import path from "path";
import { z } from "zod";
import { WORKSPACE_ROOT } from "../lib/paths";

// Load workspace root .env cleanly from both TypeScript source & compiled dist/
dotenv.config({ path: path.join(WORKSPACE_ROOT, ".env") });
dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
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
  PAYMENT_WEBHOOK_SECRET: z
    .string()
    .min(24)
    .default("kc-dev-razorpay-upi-webhook-hmac-secret-2026"),
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
  // --- Google Sign-In (optional) -------------------------------------------
  //
  // Deliberately optional and not `min(1)`: the whole product has to run, and be
  // testable, without any Google project. When either id or secret is missing the
  // API answers "not configured" on the OAuth routes and the sign-in page simply
  // does not render the Google button. A half-configured pair is a startup error
  // rather than a silent downgrade, because a button that always fails is worse
  // than a button that is not there.
  GOOGLE_CLIENT_ID: z.string().trim().max(200).optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().max(200).optional(),
  // Where Google sends the browser back. Must be registered byte-for-byte in the
  // Google Cloud console, so it is configuration, not a value computed from the
  // request: computing it from the Host header would let an attacker choose it.
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  // The page the browser returns to after the callback finishes. The callback runs
  // on the API origin, so without this the user would end up on :4000.
  WEB_APP_ORIGIN: z.string().url().default("http://localhost:3000"),
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
      }
    : {}),
});

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
