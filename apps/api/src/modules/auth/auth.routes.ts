import crypto from "crypto";
import { Router, Response } from "express";
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  RequestOtpSchema,
  SupplyChainTier,
  UserRole,
  VerificationLevel,
  VerifyOtpSchema,
  resolveDefaultTierForRole,
} from "@kabadi/shared";
import { env } from "../../config/env";
import { getPrisma } from "../../lib/prisma";
import {
  generateOpaqueRefreshToken,
  generatePlatformCode,
  hashSecretArgon2id,
  signAccessToken,
  verifySecretArgon2id,
  sha256Hex,
} from "../../lib/security";
import {
  authenticate,
  authRateLimiter,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";
import { resolveSmsGatewayAdapter } from "../integrations/gateways.service";

export const authRouter = Router();

function attachAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string
): void {
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

function clearAuthCookies(res: Response): void {
  res.clearCookie("kc_access_token", { path: "/" });
  res.clearCookie("kc_refresh_token", { path: "/api/v1/auth" });
}

export function serializeOwnUserAccount(user: {
  id: string;
  phone: string;
  email: string | null;
  role: string;
  tier: string;
  accountStatus: string;
  verificationLevel: string;
  platformCode: string;
  phoneVerifiedAt: Date | null;
  createdAt: Date;
  profile?: {
    displayName: string;
    preferredLanguage: string;
    city: string;
    pincode: string;
    addressLine: string | null;
  } | null;
  organization?: {
    id: string;
    businessName: string;
    platformCode: string;
    tier: string;
    verificationLevel: string;
    serviceRadiusKm: number;
    storefront?: {
      id: string;
      slug: string;
      shopTitle: string;
      isOpen: boolean;
    } | null;
  } | null;
}) {
  // Explicitly omit passwordHash, session hashes, internal flags
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    role: user.role,
    tier: user.tier,
    accountStatus: user.accountStatus,
    verificationLevel: user.verificationLevel,
    platformCode: user.platformCode,
    platformIdDisclaimer:
      "Kabadiwala Connect platform-issued ID — not a government-issued identity or statutory licence.",
    phoneVerifiedAt: user.phoneVerifiedAt,
    createdAt: user.createdAt,
    profile: user.profile ?? null,
    organization: user.organization ?? null,
  };
}

// POST /api/v1/auth/register
authRouter.post(
  "/register",
  authRateLimiter,
  validateBody(RegisterRequestSchema),
  async (req, res) => {
    const prisma = await getPrisma();
    const body = req.body;

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: body.phone },
          ...(body.email ? [{ email: body.email.toLowerCase() }] : []),
        ],
      },
      select: { id: true },
    });

    if (existing) {
      await recordAuditEvent({
        action: "AUTH_REGISTER_CONFLICT",
        resourceType: "User",
        outcome: "DENIED",
        reason: "Account already exists for submitted contact identifier",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      // Generic message to minimize account enumeration (Section 8.1)
      sendError(
        res,
        409,
        "REGISTRATION_UNAVAILABLE",
        "Unable to complete registration with the provided contact details"
      );
      return;
    }

    const tier = resolveDefaultTierForRole(body.role, body.businessTier);
    const passwordHash = await hashSecretArgon2id(body.password);
    const platformCode = generatePlatformCode(tier);

    const created = await prisma.user.create({
      data: {
        phone: body.phone,
        email: body.email ? body.email.toLowerCase() : null,
        passwordHash,
        role: body.role,
        tier,
        accountStatus: "ACTIVE",
        verificationLevel: "LEVEL_0_REGISTERED",
        platformCode,
        profile: {
          create: {
            displayName: body.displayName,
            preferredLanguage: body.preferredLanguage,
            city: body.city,
            pincode: body.pincode,
          },
        },
        ...(tier !== "TIER_0_GENERATOR"
          ? {
              organization: {
                create: {
                  tier,
                  platformCode,
                  businessName: body.businessName ?? `${body.displayName} Scrap Center`,
                  city: body.city,
                  pincode: body.pincode,
                  serviceRadiusKm:
                    tier === "TIER_1_LOCAL_COLLECTOR"
                      ? 3
                      : tier === "TIER_2_AREA_SHOP"
                      ? 8
                      : tier === "TIER_3_WHOLESALE_AGGREGATOR"
                      ? 35
                      : 150,
                  verificationLevel: "LEVEL_0_REGISTERED",
                  storefront: {
                    create: {
                      slug: `${platformCode.toLowerCase()}-${crypto
                        .randomBytes(2)
                        .toString("hex")}`,
                      shopTitle:
                        body.businessName ?? `${body.displayName} Kabadi Storefront`,
                      tagline: "Transparent weighed scrap collection & rate card",
                      isOpen: true,
                      pickupAvailable: true,
                      dropoffAvailable: true,
                      minPickupGrams:
                        tier === "TIER_1_LOCAL_COLLECTOR"
                          ? 3000
                          : tier === "TIER_2_AREA_SHOP"
                          ? 25000
                          : tier === "TIER_3_WHOLESALE_AGGREGATOR"
                          ? 200000
                          : 1000000,
                      servicePincodes: [body.pincode],
                    },
                  },
                },
              },
            }
          : {}),
      },
      include: {
        profile: true,
        organization: { include: { storefront: true } },
      },
    });

    const familyId = crypto.randomUUID();
    const { rawToken: refreshToken, tokenHash } = generateOpaqueRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: created.id,
        tokenHash,
        familyId,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        expiresAt: new Date(
          Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
        ),
      },
    });

    const accessToken = signAccessToken({
      sub: created.id,
      role: created.role as UserRole,
      tier: created.tier as SupplyChainTier,
      verificationLevel: created.verificationLevel as VerificationLevel,
      platformCode: created.platformCode,
      sid: familyId,
    });

    attachAuthCookies(res, accessToken, refreshToken);

    await recordAuditEvent({
      actorId: created.id,
      actorRole: created.role,
      action: "AUTH_REGISTER_SUCCESS",
      resourceType: "User",
      resourceId: created.id,
      outcome: "SUCCESS",
      metadata: { role: created.role, tier: created.tier, platformCode },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(
      res,
      {
        user: serializeOwnUserAccount(created),
        tokens: {
          accessToken,
          refreshToken,
          expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
        },
      },
      201
    );
  }
);

// POST /api/v1/auth/login
authRouter.post(
  "/login",
  authRateLimiter,
  validateBody(LoginRequestSchema),
  async (req, res) => {
    const prisma = await getPrisma();
    const { identifier, password } = req.body;

    // Check recent failed login brute-force threshold per identifier (last 10 min)
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const failedCount = await prisma.loginAttempt.count({
      where: {
        identifier: identifier.toLowerCase(),
        succeeded: false,
        createdAt: { gt: tenMinAgo },
      },
    });

    if (failedCount >= 6) {
      await recordAuditEvent({
        action: "AUTH_LOGIN_LOCKOUT",
        resourceType: "Auth",
        outcome: "DENIED",
        reason: "Temporary account lockout due to repeated failed login attempts",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        429,
        "TOO_MANY_FAILED_ATTEMPTS",
        "Too many failed sign-in attempts. Please wait a few minutes and try again."
      );
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ phone: identifier }, { email: identifier.toLowerCase() }],
      },
      include: {
        profile: true,
        organization: { include: { storefront: true } },
      },
    });

    const passwordValid = user
      ? await verifySecretArgon2id(user.passwordHash, password)
      : false;

    if (!user || !passwordValid) {
      await prisma.loginAttempt.create({
        data: {
          identifier: identifier.toLowerCase(),
          userId: user?.id ?? null,
          ipAddress: req.ip ?? null,
          succeeded: false,
          reason: "INVALID_CREDENTIALS",
        },
      });
      await recordAuditEvent({
        actorId: user?.id ?? null,
        actorRole: user?.role ?? null,
        action: "AUTH_LOGIN_FAILED",
        resourceType: "Auth",
        outcome: "FAILURE",
        reason: "Invalid credentials supplied",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      // Uniform error prevents account existence enumeration
      sendError(res, 401, "INVALID_CREDENTIALS", "Invalid credentials");
      return;
    }

    if (user.accountStatus !== "ACTIVE") {
      await recordAuditEvent({
        actorId: user.id,
        actorRole: user.role,
        action: "AUTH_LOGIN_DENIED_RESTRICTED",
        resourceType: "User",
        resourceId: user.id,
        outcome: "DENIED",
        reason: `Account status ${user.accountStatus}`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        403,
        "ACCOUNT_RESTRICTED",
        "This account is currently suspended or deactivated"
      );
      return;
    }

    await prisma.loginAttempt.create({
      data: {
        identifier: identifier.toLowerCase(),
        userId: user.id,
        ipAddress: req.ip ?? null,
        succeeded: true,
      },
    });

    const familyId = crypto.randomUUID();
    const { rawToken: refreshToken, tokenHash } = generateOpaqueRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        familyId,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        expiresAt: new Date(
          Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
        ),
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

    attachAuthCookies(res, accessToken, refreshToken);

    await recordAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: "AUTH_LOGIN_SUCCESS",
      resourceType: "User",
      resourceId: user.id,
      outcome: "SUCCESS",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, {
      user: serializeOwnUserAccount(user),
      tokens: {
        accessToken,
        refreshToken,
        expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      },
    });
  }
);

// POST /api/v1/auth/refresh — Rotating Refresh Token with Reuse Theft Detection
authRouter.post("/refresh", authRateLimiter, async (req, res) => {
  const prisma = await getPrisma();
  const presentedToken =
    (typeof req.body?.refreshToken === "string" ? req.body.refreshToken : undefined) ??
    (typeof req.cookies?.kc_refresh_token === "string"
      ? req.cookies.kc_refresh_token
      : undefined);

  if (!presentedToken) {
    sendError(res, 401, "MISSING_REFRESH_TOKEN", "Refresh token is required");
    return;
  }

  const tokenHash = sha256Hex(presentedToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing) {
    clearAuthCookies(res);
    sendError(res, 401, "INVALID_REFRESH_TOKEN", "Invalid session token");
    return;
  }

  // REUSE DETECTION: If a previously rotated/revoked token is replayed, revoke ENTIRE session family!
  if (existing.revokedAt !== null) {
    await prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: "REFRESH_TOKEN_REPLAY_DETECTED",
      },
    });
    await recordAuditEvent({
      actorId: existing.userId,
      actorRole: existing.user.role,
      action: "SESSION_FAMILY_REVOKED_ON_REPLAY",
      resourceType: "RefreshToken",
      resourceId: existing.familyId,
      outcome: "DENIED",
      reason: "Rotated refresh token was replayed; all tokens in session family revoked",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    clearAuthCookies(res);
    sendError(res, 401, "SESSION_COMPROMISED_REVOKED", "Session has been revoked");
    return;
  }

  if (existing.expiresAt <= new Date() || existing.user.accountStatus !== "ACTIVE") {
    clearAuthCookies(res);
    sendError(res, 401, "REFRESH_TOKEN_EXPIRED", "Session expired; please log in again");
    return;
  }

  // Rotate atomically: mark old token rotated & mint replacement in same family
  const { rawToken: nextRefreshToken, tokenHash: nextHash } =
    generateOpaqueRefreshToken();

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedReason: "ROTATED" },
    }),
    prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: nextHash,
        familyId: existing.familyId,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        expiresAt: new Date(
          Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
        ),
      },
    }),
  ]);

  const accessToken = signAccessToken({
    sub: existing.user.id,
    role: existing.user.role as UserRole,
    tier: existing.user.tier as SupplyChainTier,
    verificationLevel: existing.user.verificationLevel as VerificationLevel,
    platformCode: existing.user.platformCode,
    sid: existing.familyId,
  });

  attachAuthCookies(res, accessToken, nextRefreshToken);

  sendSuccess(res, {
    tokens: {
      accessToken,
      refreshToken: nextRefreshToken,
      expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    },
  });
});

// POST /api/v1/auth/logout — Immediately revokes active session family
authRouter.post("/logout", authenticate, async (req, res) => {
  const prisma = await getPrisma();
  const actor = req.actor!;

  await prisma.refreshToken.updateMany({
    where: {
      userId: actor.id,
      familyId: actor.sessionFamilyId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
      revokedReason: "USER_LOGOUT",
    },
  });

  clearAuthCookies(res);

  await recordAuditEvent({
    actorId: actor.id,
    actorRole: actor.role,
    action: "AUTH_LOGOUT",
    resourceType: "Session",
    resourceId: actor.sessionFamilyId,
    outcome: "SUCCESS",
    correlationId: req.correlationId,
    ipAddress: req.ip,
  });

  sendSuccess(res, { loggedOut: true });
});

// POST /api/v1/auth/otp/request & /api/v1/auth/otp/verify (Contact Verification Level 1)
authRouter.post(
  "/otp/request",
  authenticate,
  authRateLimiter,
  validateBody(RequestOtpSchema),
  async (req, res) => {
    const prisma = await getPrisma();
    const actor = req.actor!;
    const user = await prisma.user.findUnique({ where: { id: actor.id } });
    if (!user || user.phone !== req.body.phone) {
      sendError(res, 403, "PHONE_MISMATCH", "Can only verify your own registered phone");
      return;
    }

    const sixDigitOtp = String(crypto.randomInt(100000, 999999));
    const codeHash = await hashSecretArgon2id(sixDigitOtp);

    await prisma.otpChallenge.create({
      data: {
        phone: user.phone,
        codeHash,
        maxAttempts: 5,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5-minute strict expiry
      },
    });

    const smsDispatch = await resolveSmsGatewayAdapter().sendOtpCode(
      user.phone,
      sixDigitOtp
    );

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "OTP_CHALLENGE_CREATED",
      resourceType: "OtpChallenge",
      outcome: "SUCCESS",
      metadata: {
        smsProvider: smsDispatch.provider,
        providerMessageId: smsDispatch.providerMessageId,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, {
      sent: smsDispatch.delivered,
      smsProvider: smsDispatch.provider,
      providerMessageId: smsDispatch.providerMessageId,
      expiresInSeconds: 300,
      // Returned ONLY in non-production environments to simulate SMS gateway delivery in local/test runs
      ...(env.NODE_ENV !== "production" ? { devPreviewOtp: sixDigitOtp } : {}),
    });
  }
);

authRouter.post(
  "/otp/verify",
  authenticate,
  authRateLimiter,
  validateBody(VerifyOtpSchema),
  async (req, res) => {
    const prisma = await getPrisma();
    const actor = req.actor!;

    const challenge = await prisma.otpChallenge.findFirst({
      where: {
        phone: req.body.phone,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!challenge || challenge.attempts >= challenge.maxAttempts) {
      sendError(res, 400, "OTP_INVALID_OR_EXPIRED", "OTP is invalid, expired, or locked");
      return;
    }

    const matches = await verifySecretArgon2id(challenge.codeHash, req.body.code);
    if (!matches) {
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      sendError(res, 400, "OTP_INVALID_OR_EXPIRED", "OTP is invalid, expired, or locked");
      return;
    }

    await prisma.$transaction([
      prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: actor.id },
        data: {
          phoneVerifiedAt: new Date(),
          ...(actor.verificationLevel === "LEVEL_0_REGISTERED"
            ? { verificationLevel: "LEVEL_1_CONTACT_VERIFIED" }
            : {}),
        },
      }),
    ]);

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "CONTACT_OTP_VERIFIED",
      resourceType: "User",
      resourceId: actor.id,
      outcome: "SUCCESS",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { verified: true, verificationLevel: "LEVEL_1_CONTACT_VERIFIED" });
  }
);

// POST /api/v1/auth/otp/login-request & /otp/login-verify — Mobile Field App Passwordless Phone OTP Login
authRouter.post(
  "/otp/login-request",
  authRateLimiter,
  validateBody(RequestOtpSchema),
  async (req, res, next) => {
    try {
      const prisma = await getPrisma();
      const user = await prisma.user.findUnique({ where: { phone: req.body.phone } });
      if (!user || user.accountStatus !== "ACTIVE") {
        // Avoid leaking phone registration enumeration while still returning a uniform response shape
        sendSuccess(res, { sent: true, expiresInSeconds: 300 });
        return;
      }

      const sixDigitOtp = String(crypto.randomInt(100000, 999999));
      const codeHash = await hashSecretArgon2id(sixDigitOtp);

      await prisma.otpChallenge.create({
        data: {
          phone: user.phone,
          codeHash,
          maxAttempts: 5,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });

      const smsDispatch = await resolveSmsGatewayAdapter().sendOtpCode(
        user.phone,
        sixDigitOtp
      );

      await recordAuditEvent({
        actorId: user.id,
        actorRole: user.role,
        action: "MOBILE_OTP_LOGIN_CHALLENGE_CREATED",
        resourceType: "OtpChallenge",
        outcome: "SUCCESS",
        metadata: {
          smsProvider: smsDispatch.provider,
          providerMessageId: smsDispatch.providerMessageId,
        },
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });

      sendSuccess(res, {
        sent: smsDispatch.delivered,
        smsProvider: smsDispatch.provider,
        providerMessageId: smsDispatch.providerMessageId,
        expiresInSeconds: 300,
        ...(env.NODE_ENV !== "production" ? { devPreviewOtp: sixDigitOtp } : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

authRouter.post(
  "/otp/login-verify",
  authRateLimiter,
  validateBody(VerifyOtpSchema),
  async (req, res, next) => {
    try {
      const prisma = await getPrisma();
      const user = await prisma.user.findUnique({
        where: { phone: req.body.phone },
        include: {
          profile: true,
          organization: { include: { storefront: true } },
        },
      });

      if (!user || user.accountStatus !== "ACTIVE") {
        sendError(res, 401, "OTP_INVALID_OR_EXPIRED", "OTP is invalid, expired, or locked");
        return;
      }

      const challenge = await prisma.otpChallenge.findFirst({
        where: {
          phone: req.body.phone,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!challenge || challenge.attempts >= challenge.maxAttempts) {
        sendError(res, 401, "OTP_INVALID_OR_EXPIRED", "OTP is invalid, expired, or locked");
        return;
      }

      const matches = await verifySecretArgon2id(challenge.codeHash, req.body.code);
      if (!matches) {
        await prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { attempts: { increment: 1 } },
        });
        sendError(res, 401, "OTP_INVALID_OR_EXPIRED", "OTP is invalid, expired, or locked");
        return;
      }

      const familyId = crypto.randomUUID();
      const { rawToken: refreshToken, tokenHash } = generateOpaqueRefreshToken();

      const [, updatedUser] = await prisma.$transaction([
        prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: {
            phoneVerifiedAt: new Date(),
            ...(user.verificationLevel === "LEVEL_0_REGISTERED"
              ? { verificationLevel: "LEVEL_1_CONTACT_VERIFIED" }
              : {}),
          },
          include: {
            profile: true,
            organization: { include: { storefront: true } },
          },
        }),
        prisma.refreshToken.create({
          data: {
            userId: user.id,
            tokenHash,
            familyId,
            userAgent: req.headers["user-agent"]?.slice(0, 200) ?? "expo-mobile",
            ipAddress: req.ip ?? null,
            expiresAt: new Date(
              Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
            ),
          },
        }),
      ]);

      const accessToken = signAccessToken({
        sub: updatedUser.id,
        role: updatedUser.role,
        tier: updatedUser.tier,
        verificationLevel: updatedUser.verificationLevel,
        platformCode: updatedUser.platformCode,
        sid: familyId,
      });
      attachAuthCookies(res, accessToken, refreshToken);

      await recordAuditEvent({
        actorId: updatedUser.id,
        actorRole: updatedUser.role,
        action: "MOBILE_OTP_LOGIN_SUCCESS",
        resourceType: "Session",
        resourceId: familyId,
        outcome: "SUCCESS",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });

      sendSuccess(res, {
        user: serializeOwnUserAccount(updatedUser),
        tokens: {
          accessToken,
          refreshToken,
          expiresInSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/auth/me
authRouter.get("/me", authenticate, async (req, res) => {
  const prisma = await getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: req.actor!.id },
    include: {
      profile: true,
      organization: { include: { storefront: true } },
    },
  });
  if (!user) {
    sendError(res, 404, "NOT_FOUND", "Account not found");
    return;
  }
  sendSuccess(res, { user: serializeOwnUserAccount(user) });
});
