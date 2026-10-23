import { Router } from "express";
import { UpdateOwnProfileSchema } from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import {
  authenticate,
  requireCapability,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { serializeOwnUserAccount } from "../auth/auth.routes";
import { recordAuditEvent } from "../audit/audit.service";

export const usersRouter = Router();
export const publicVerifyRouter = Router();

// GET /api/v1/users/:userId — Enforces Object-Level Authorization (BOLA defense)
usersRouter.get("/:userId", authenticate, async (req, res) => {
  const actor = req.actor!;
  const targetUserId = String(req.params.userId);

  if (actor.id !== targetUserId && actor.role !== "ADMIN") {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "BOLA_UNAUTHORIZED_USER_READ_BLOCKED",
      resourceType: "User",
      resourceId: targetUserId,
      outcome: "DENIED",
      reason: "Attempted horizontal access to another user's private profile record",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(
      res,
      403,
      "FORBIDDEN_RESOURCE_OWNERSHIP",
      "You are not authorised to view another account's private profile"
    );
    return;
  }

  const prisma = await getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: {
      profile: true,
      organization: { include: { storefront: true } },
    },
  });

  if (!user) {
    sendError(res, 404, "USER_NOT_FOUND", "Account not found");
    return;
  }

  sendSuccess(res, { user: serializeOwnUserAccount(user) });
});

// PATCH /api/v1/users/:userId/profile — Strict Ownership + Property-Level Allowlist
usersRouter.patch(
  "/:userId/profile",
  authenticate,
  requireCapability("profile:update:own"),
  validateBody(UpdateOwnProfileSchema),
  async (req, res) => {
    const actor = req.actor!;
    const targetUserId = String(req.params.userId);

    if (actor.id !== targetUserId) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "BOLA_UNAUTHORIZED_PROFILE_EDIT_BLOCKED",
        resourceType: "UserProfile",
        resourceId: targetUserId,
        outcome: "DENIED",
        reason: "Attempted to modify another user's profile",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(res, 403, "FORBIDDEN", "Cannot edit another user's profile");
      return;
    }

    const prisma = await getPrisma();
    const updatedProfile = await prisma.userProfile.update({
      where: { userId: actor.id },
      data: {
        ...(req.body.displayName !== undefined ? { displayName: req.body.displayName } : {}),
        ...(req.body.preferredLanguage !== undefined
          ? { preferredLanguage: req.body.preferredLanguage }
          : {}),
        ...(req.body.city !== undefined ? { city: req.body.city } : {}),
        ...(req.body.pincode !== undefined ? { pincode: req.body.pincode } : {}),
        ...(req.body.addressLine !== undefined ? { addressLine: req.body.addressLine } : {}),
      },
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "USER_PROFILE_UPDATED",
      resourceType: "UserProfile",
      resourceId: updatedProfile.id,
      outcome: "SUCCESS",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { profile: updatedProfile });
  }
);

// GET /api/v1/public/verify/:platformCode — Safe Public QR Card Verification Page (Section 4.3)
publicVerifyRouter.get("/verify/:platformCode", async (req, res) => {
  const prisma = await getPrisma();
  const code = String(req.params.platformCode).toUpperCase().trim();

  const user = await prisma.user.findUnique({
    where: { platformCode: code },
    include: {
      profile: {
        select: {
          displayName: true,
          city: true,
        },
      },
      organization: {
        select: {
          businessName: true,
          tier: true,
          verificationLevel: true,
          recyclerRegistration: {
            select: {
              authorityName: true,
              registrationNumber: true,
              permittedStreams: true,
              cpcbPortalChecked: true,
              validUntil: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    sendError(res, 404, "PLATFORM_ID_NOT_FOUND", "No active platform ID matched this code");
    return;
  }

  // Strictly public-safe fields ONLY: never expose phone, email, addressLine, tokens or raw KYC docs
  sendSuccess(res, {
    publicCard: {
      platformCode: user.platformCode,
      displayName:
        user.organization?.businessName ?? user.profile?.displayName ?? "Registered Member",
      operatingCity: user.profile?.city ?? null,
      role: user.role,
      supplyChainTier: user.tier,
      accountStatus: user.accountStatus,
      verificationLevel: user.verificationLevel,
      issuedAt: user.createdAt,
      recyclerAuthorisationSummary:
        user.verificationLevel === "LEVEL_4_AUTHORISED_RECYCLER" &&
        user.organization?.recyclerRegistration
          ? user.organization.recyclerRegistration
          : null,
      legalNotice:
        "This is a Kabadiwala Connect platform-issued profile badge, NOT a government-issued identity card or statutory certificate.",
    },
  });
});

// Recursive helper building PII-safe upstream BatchLineage genealogy tree (up to 4 hops)
async function buildPublicLineageNode(orderId: string, depth = 0): Promise<Record<string, unknown> | null> {
  if (depth > 4) return null;
  const prisma = await getPrisma();
  const ord = await prisma.transactionOrder.findUnique({
    where: { id: orderId },
    include: {
      seller: { select: { platformCode: true, tier: true, verificationLevel: true } },
      buyer: {
        select: {
          platformCode: true,
          tier: true,
          verificationLevel: true,
          organization: {
            select: {
              businessName: true,
              recyclerRegistration: {
                select: {
                  authorityName: true,
                  registrationNumber: true,
                  cpcbPortalChecked: true,
                },
              },
            },
          },
        },
      },
      storefront: { select: { shopTitle: true } },
      items: {
        include: {
          material: {
            select: { slug: true, nameEn: true, defaultUnit: true, isRegulatedHazardous: true },
          },
        },
      },
      weighingRecords: {
        select: {
          totalEstimatedGrams: true,
          totalActualGrams: true,
          ocrDiscrepancyFlag: true,
          createdAt: true,
        },
      },
      handoverRecords: {
        select: {
          handoverPincode: true,
          evidenceHashSha256: true,
          sellerConfirmedAt: true,
          buyerConfirmedAt: true,
          disclaimerNote: true,
        },
      },
      childLineageLinks: {
        select: {
          attributedGrams: true,
          childSourceOrderId: true,
        },
      },
    },
  });

  if (!ord) return null;

  const upstreamSources = [];
  for (const link of ord.childLineageLinks) {
    const childNode = await buildPublicLineageNode(link.childSourceOrderId, depth + 1);
    if (childNode) {
      upstreamSources.push({
        attributedGrams: link.attributedGrams,
        sourceTransaction: childNode,
      });
    }
  }

  // Strictly scrub private phone numbers, emails, street addresses, and raw financial margins!
  return {
    orderNumber: ord.orderNumber,
    qrTraceToken: ord.qrTraceToken,
    status: ord.status,
    sellerPlatformCode: ord.seller.platformCode,
    sellerTier: ord.sellerTier,
    buyerPlatformCode: ord.buyer.platformCode,
    buyerBusinessName:
      ord.storefront?.shopTitle ??
      ord.buyer.organization?.businessName ??
      ord.buyer.platformCode,
    buyerTier: ord.buyerTier,
    buyerVerificationLevel: ord.buyer.verificationLevel,
    verifiedAuthorisedRecyclerFacility:
      ord.buyer.verificationLevel === "LEVEL_4_AUTHORISED_RECYCLER" &&
      ord.buyer.organization?.recyclerRegistration?.cpcbPortalChecked
        ? ord.buyer.organization.recyclerRegistration
        : null,
    materials: ord.items.map((it) => ({
      materialSlug: it.material.slug,
      materialName: it.material.nameEn,
      isRegulatedHazardous: it.material.isRegulatedHazardous,
      estimatedGrams: it.estimatedGrams,
      verifiedActualGrams: it.actualGrams,
    })),
    weighingMilestones: ord.weighingRecords,
    handoverMilestones: ord.handoverRecords,
    createdAt: ord.createdAt,
    completedAt: ord.completedAt,
    upstreamChildLots: upstreamSources,
  };
}

// GET /api/v1/public/trace/:qrTraceToken — Safe Public QR Traceability Milestone View (Section 6.2)
publicVerifyRouter.get("/trace/:qrTraceToken", async (req, res) => {
  const prisma = await getPrisma();
  const token = String(req.params.qrTraceToken).trim();

  const rootOrder = await prisma.transactionOrder.findUnique({
    where: { qrTraceToken: token },
    select: { id: true, status: true, buyerTier: true },
  });

  if (!rootOrder) {
    sendError(
      res,
      404,
      "TRACE_RECORD_NOT_FOUND",
      "No transaction record matched this QR traceability token"
    );
    return;
  }

  const lineageTree = await buildPublicLineageNode(rootOrder.id, 0);

  sendSuccess(res, {
    traceRecord: lineageTree,
    statutoryNotice:
      "Kabadiwala Connect platform handover & lineage record. A QR scan retrieves recorded platform milestones only and MUST NOT be treated as a statutory government EPR or recycling completion certificate unless supported by verified facility processing records.",
  });
});
