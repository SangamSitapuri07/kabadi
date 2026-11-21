// Session issuance, in one place.
//
// Password login, OTP login and Google sign-in all have to end in the same shape:
// a refresh-token family in the database, an access token signed with the same
// claims, and the same two cookies. Duplicating that in three handlers is how one
// of them quietly ends up with a 30-day token or without the audit event.
//
// This file knows nothing about how the caller proved who they are. That is the
// caller's job; this is only "this user is now signed in".
import crypto from "crypto";
import { Response } from "express";
import { SupplyChainTier, UserRole, VerificationLevel } from "@kabadi/shared";
import { env } from "../../config/env";
import { getPrisma } from "../../lib/prisma";
import { generateOpaqueRefreshToken, signAccessToken } from "../../lib/security";

export interface IssuedSession {
  familyId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export function attachAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const isProd = env.NODE_ENV === "production";
  res.cookie("kc_access_token", accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: env.ACCESS_TOKEN_TTL_SECONDS * 1000,
    path: "/",
  });
  res.cookie("kc_refresh_token", refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/api/v1/auth",
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie("kc_access_token", { path: "/" });
  res.clearCookie("kc_refresh_token", { path: "/api/v1/auth" });
}

/**
 * Creates a refresh-token family and signs a matching access token.
 *
 * The family id is what `POST /auth/logout` and refresh-reuse detection revoke, so
 * every new sign-in gets a fresh one -- a second device must not be able to revoke
 * the first by logging out.
 */
export async function issueSession(
  user: {
    id: string;
    role: string;
    tier: string;
    verificationLevel: string;
    platformCode: string;
  },
  context: { ipAddress?: string | null; userAgent?: string | null }
): Promise<IssuedSession> {
  const prisma = await getPrisma();
  const familyId = crypto.randomUUID();
  const { rawToken: refreshToken, tokenHash } = generateOpaqueRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      familyId,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent?.slice(0, 200) ?? null,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });

  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role as UserRole,
    tier: user.tier as SupplyChainTier,
    verificationLevel: user.verificationLevel as VerificationLevel,
    platformCode: user.platformCode,
    sid: familyId,
  });

  return {
    familyId,
    accessToken,
    refreshToken,
    expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
  };
}
