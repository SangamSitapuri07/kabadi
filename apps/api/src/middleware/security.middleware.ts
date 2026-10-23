import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodSchema } from "zod";
import {
  Capability,
  SupplyChainTier,
  UserRole,
  VerificationLevel,
  roleHasCapability,
} from "@kabadi/shared";
import { getPrisma } from "../lib/prisma";
import { RedisOrMemoryRateLimitStore } from "../lib/redisStore";
import { verifyAccessToken } from "../lib/security";
import { recordAuditEvent } from "../modules/audit/audit.service";
import { env } from "../config/env";

export interface AuthenticatedActor {
  id: string;
  role: UserRole;
  tier: SupplyChainTier;
  verificationLevel: VerificationLevel;
  platformCode: string;
  sessionFamilyId: string;
}

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      actor?: AuthenticatedActor;
    }
  }
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>
): void {
  res.status(statusCode).json({
    success: true,
    correlationId: res.req.correlationId,
    data,
    ...(meta ? { meta } : {}),
  });
}

export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): void {
  res.status(statusCode).json({
    success: false,
    correlationId: res.req.correlationId,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const id = crypto.randomUUID();
  req.correlationId = id;
  res.setHeader("X-Correlation-Id", id);
  next();
}

/**
 * Authenticates caller via Authorization Bearer header OR HttpOnly cookie,
 * verifies live DB account status (`ACTIVE`) AND verifies session family
 * has not been revoked on logout or security incident.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Explicitly reject session/access tokens leaked into query URLs (Section 8.9)
  if (typeof req.query.access_token === "string") {
    sendError(
      res,
      400,
      "TOKEN_IN_URL_FORBIDDEN",
      "Authentication tokens must never be passed in URL parameters"
    );
    return;
  }

  let rawToken: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    rawToken = authHeader.slice(7).trim();
  } else if (req.cookies && typeof req.cookies.kc_access_token === "string") {
    rawToken = req.cookies.kc_access_token;
  }

  if (!rawToken) {
    sendError(res, 401, "UNAUTHENTICATED", "Authentication is required");
    return;
  }

  try {
    const claims = verifyAccessToken(rawToken);
    const prisma = await getPrisma();

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        role: true,
        tier: true,
        accountStatus: true,
        verificationLevel: true,
        platformCode: true,
      },
    });

    if (!user) {
      sendError(res, 401, "INVALID_SESSION", "Session is no longer valid");
      return;
    }

    if (user.accountStatus !== "ACTIVE") {
      await recordAuditEvent({
        actorId: user.id,
        actorRole: user.role,
        action: "SUSPENDED_ACCOUNT_BLOCKED",
        resourceType: "User",
        resourceId: user.id,
        outcome: "DENIED",
        reason: `Account status is ${user.accountStatus}`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        403,
        "ACCOUNT_RESTRICTED",
        "Account is currently restricted from performing operations"
      );
      return;
    }

    // Check active non-revoked refresh session exists for this session family
    const activeFamilyToken = await prisma.refreshToken.findFirst({
      where: {
        userId: user.id,
        familyId: claims.sid,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (!activeFamilyToken) {
      sendError(res, 401, "SESSION_REVOKED", "Session has been revoked or expired");
      return;
    }

    req.actor = {
      id: user.id,
      role: user.role as UserRole,
      tier: user.tier as SupplyChainTier,
      verificationLevel: user.verificationLevel as VerificationLevel,
      platformCode: user.platformCode,
      sessionFamilyId: claims.sid,
    };
    next();
  } catch {
    sendError(res, 401, "INVALID_OR_EXPIRED_TOKEN", "Invalid or expired session token");
  }
}

export function requireCapability(capability: Capability) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.actor) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required");
      return;
    }
    if (!roleHasCapability(req.actor.role, capability)) {
      await recordAuditEvent({
        actorId: req.actor.id,
        actorRole: req.actor.role,
        action: "AUTHORIZATION_DENIED",
        resourceType: "Capability",
        resourceId: capability,
        outcome: "DENIED",
        reason: `Role ${req.actor.role} lacks capability ${capability}`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        403,
        "FORBIDDEN",
        "You do not have permission to perform this action"
      );
      return;
    }
    next();
  };
}

export function requireRoles(...allowedRoles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.actor) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required");
      return;
    }
    if (!allowedRoles.includes(req.actor.role)) {
      await recordAuditEvent({
        actorId: req.actor.id,
        actorRole: req.actor.role,
        action: "ROLE_ACCESS_DENIED",
        resourceType: "Route",
        resourceId: req.originalUrl,
        outcome: "DENIED",
        reason: `Required one of [${allowedRoles.join(", ")}], actor has ${req.actor.role}`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(res, 403, "FORBIDDEN", "Insufficient role permissions");
      return;
    }
    next();
  };
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const rawBody = req.body && typeof req.body === "object" ? req.body : {};
      const suspiciousFields = [
        "role",
        "verificationLevel",
        "verificationStatus",
        "accountStatus",
        "platformCode",
        "finalSettlementPaise",
      ].filter((field) => field in rawBody);

      if (suspiciousFields.length > 0) {
        await recordAuditEvent({
          actorId: req.actor?.id ?? null,
          actorRole: req.actor?.role ?? null,
          action: "RESTRICTED_FIELD_TAMPER_BLOCKED",
          resourceType: "RequestValidation",
          resourceId: req.path,
          outcome: "DENIED",
          reason: `Rejected restricted client fields: ${suspiciousFields.join(", ")}`,
          metadata: { path: req.path, suspiciousFields },
          correlationId: req.correlationId,
          ipAddress: req.ip,
        });
      }

      sendError(
        res,
        400,
        "VALIDATION_ERROR",
        "Invalid or unpermitted request fields",
        result.error.flatten().fieldErrors
      );
      return;
    }
    req.body = result.data;
    next();
  };
}

// ============================================================================
// TIERED ENDPOINT RATE LIMITERS (Section 8.6)
// ============================================================================

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "test" ? 35 : 25,
  store: new RedisOrMemoryRateLimitStore("kc:rl:auth"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req, res) => {
    await recordAuditEvent({
      actorId: req.actor?.id ?? null,
      action: "RATE_LIMIT_TRIGGERED",
      resourceType: "AuthEndpoint",
      resourceId: req.path,
      outcome: "DENIED",
      reason: "Too many authentication or OTP attempts",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(
      res,
      429,
      "RATE_LIMIT_EXCEEDED",
      "Too many requests. Please wait before trying again."
    );
  },
});

export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.NODE_ENV === "test" ? 10 : 30,
  store: new RedisOrMemoryRateLimitStore("kc:rl:ai"),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(
      res,
      429,
      "AI_RATE_LIMIT_EXCEEDED",
      "Too many AI scan requests. Please wait briefly before scanning again."
    );
  },
});

export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240,
  store: new RedisOrMemoryRateLimitStore("kc:rl:general"),
  standardHeaders: true,
  legacyHeaders: false,
});

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[${req.correlationId}] Unhandled error:`, err instanceof Error ? err.message : "unknown");
  sendError(res, 500, "INTERNAL_ERROR", "An unexpected error occurred");
}
