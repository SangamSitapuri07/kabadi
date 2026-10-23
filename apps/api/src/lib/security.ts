import argon2 from "argon2";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import {
  SupplyChainTier,
  UserRole,
  VerificationLevel,
  platformPrefixForTier,
} from "@kabadi/shared";

// ============================================================================
// 1. ARGON2ID PASSWORD & OTP HASHING (OWASP PASSWORD STORAGE CHEAT SHEET)
// ============================================================================

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB minimum recommended by OWASP
  timeCost: 2,
  parallelism: 1,
};

export async function hashSecretArgon2id(plainSecret: string): Promise<string> {
  return argon2.hash(plainSecret, ARGON2_OPTIONS);
}

export async function verifySecretArgon2id(
  hash: string,
  candidateSecret: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, candidateSecret);
  } catch {
    return false;
  }
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ============================================================================
// 2. JWT ACCESS TOKENS & ROTATING REFRESH TOKENS
// ============================================================================

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  tier: SupplyChainTier;
  verificationLevel: VerificationLevel;
  platformCode: string;
  sid: string; // session family id
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: "HS256",
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ["HS256"],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
  if (typeof decoded !== "object" || !decoded || typeof decoded.sub !== "string") {
    throw new Error("Invalid token claims");
  }
  return decoded as AccessTokenClaims;
}

export function generateOpaqueRefreshToken(): {
  rawToken: string;
  tokenHash: string;
} {
  const rawToken = crypto.randomBytes(40).toString("base64url");
  return {
    rawToken,
    tokenHash: sha256Hex(rawToken),
  };
}

// ============================================================================
// 3. PLATFORM-ISSUED ID GENERATOR (NEVER REPRESENTS GOV AUTHORITY)
// ============================================================================

export function generatePlatformCode(tier: SupplyChainTier, sequenceSeed?: number): string {
  const prefix = platformPrefixForTier(tier);
  const sixDigits =
    typeof sequenceSeed === "number"
      ? String(sequenceSeed).padStart(6, "0")
      : String(crypto.randomInt(100000, 999999));
  return `${prefix}-${sixDigits}`;
}

// ============================================================================
// 4. MAGIC-BYTE FILE CONTENT VERIFICATION & SHORT-LIVED SIGNED URL TOKENS
// ============================================================================

export type PermittedUploadMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "application/pdf";

/**
 * Inspects actual file header magic bytes rather than trusting client-supplied
 * filename extension or Content-Type header (OWASP File Upload Defense).
 */
export function detectVerifiedMimeFromMagicBytes(
  buffer: Buffer
): PermittedUploadMime | null {
  if (buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WEBP: "RIFF" .... "WEBP"
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // PDF: "%PDF-"
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }

  return null;
}

export function createShortLivedSignedDownloadToken(params: {
  documentId: string;
  recipientUserId: string;
  ttlSeconds?: number;
}): { token: string; expiresAtEpochSec: number } {
  const expiresAtEpochSec = Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 60);
  const payload = `${params.documentId}:${params.recipientUserId}:${expiresAtEpochSec}`;
  const sig = crypto
    .createHmac("sha256", env.SIGNED_URL_SECRET)
    .update(payload)
    .digest("base64url");
  return {
    token: `${expiresAtEpochSec}.${sig}`,
    expiresAtEpochSec,
  };
}

export function verifyShortLivedSignedDownloadToken(params: {
  token: string;
  documentId: string;
  recipientUserId: string;
}): boolean {
  const parts = params.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expectedSig = crypto
    .createHmac("sha256", env.SIGNED_URL_SECRET)
    .update(`${params.documentId}:${params.recipientUserId}:${expiresAt}`)
    .digest("base64url");

  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
