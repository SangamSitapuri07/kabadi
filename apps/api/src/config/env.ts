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
