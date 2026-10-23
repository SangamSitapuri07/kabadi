import { Router } from "express";
import {
  AdminUserStatusSchema,
  AdminVerificationDecisionSchema,
} from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import {
  authenticate,
  requireRoles,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";

export const adminRouter = Router();

// Every route inside adminRouter strictly enforces authenticated ADMIN role
adminRouter.use(authenticate, requireRoles("ADMIN"));

// GET /api/v1/admin/verification/cases — Pending & Historical Verification Queue
adminRouter.get("/verification/cases", async (_req, res) => {
  const prisma = await getPrisma();
  const cases = await prisma.verificationCase.findMany({
    include: {
      applicant: {
        select: {
          id: true,
          phone: true,
          email: true,
          role: true,
          tier: true,
          platformCode: true,
          verificationLevel: true,
          profile: { select: { displayName: true, city: true, pincode: true } },
          organization: {
            include: {
              businessRegistration: true,
              recyclerRegistration: true,
            },
          },
        },
      },
      documents: {
        select: {
          id: true,
          documentKind: true,
          detectedMime: true,
          sizeBytes: true,
          sha256Digest: true,
          uploadedAt: true,
        },
      },
      decisions: {
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { submittedAt: "desc" },
  });

  sendSuccess(res, { cases });
});

// POST /api/v1/admin/verification/cases/:caseId/decide — Controlled Verification Review
adminRouter.post(
  "/verification/cases/:caseId/decide",
  validateBody(AdminVerificationDecisionSchema),
  async (req, res) => {
    const admin = req.actor!;
    const prisma = await getPrisma();
    const caseId = String(req.params.caseId);
    const body = req.body;

    const vCase = await prisma.verificationCase.findUnique({
      where: { id: caseId },
      include: {
        applicant: { include: { organization: { include: { recyclerRegistration: true } } } },
      },
    });

    if (!vCase) {
      sendError(res, 404, "CASE_NOT_FOUND", "Verification case not found");
      return;
    }

    // Prevent self-review even among staff
    if (vCase.applicantId === admin.id) {
      sendError(
        res,
        403,
        "SELF_APPROVAL_FORBIDDEN",
        "An account may never review or approve its own verification submission"
      );
      return;
    }

    // Section 3.4 & 4.5: Level 4 Authorised Recycler approval MUST confirm official portal check!
    if (
      body.decision === "VERIFIED" &&
      vCase.requestedLevel === "LEVEL_4_AUTHORISED_RECYCLER" &&
      !body.officialSourceChecked
    ) {
      sendError(
        res,
        400,
        "OFFICIAL_SOURCE_CHECK_REQUIRED",
        "Level 4 Authorised Recycler approval requires confirming verification against the official CPCB/SPCB source"
      );
      return;
    }

    const grantedLevel = body.decision === "VERIFIED" ? vCase.requestedLevel : null;

    const result = await prisma.$transaction(async (tx) => {
      const updatedCase = await tx.verificationCase.update({
        where: { id: vCase.id },
        data: {
          status: body.decision,
          reviewedAt: new Date(),
        },
      });

      const decisionRecord = await tx.verificationDecision.create({
        data: {
          caseId: vCase.id,
          reviewerId: admin.id,
          previousStatus: vCase.status,
          newStatus: body.decision,
          grantedLevel,
          reason: body.reason,
        },
      });

      if (grantedLevel) {
        await tx.user.update({
          where: { id: vCase.applicantId },
          data: { verificationLevel: grantedLevel },
        });
        if (vCase.applicant.organization) {
          await tx.organization.update({
            where: { id: vCase.applicant.organization.id },
            data: { verificationLevel: grantedLevel },
          });
          if (
            grantedLevel === "LEVEL_4_AUTHORISED_RECYCLER" &&
            vCase.applicant.organization.recyclerRegistration
          ) {
            await tx.recyclerRegistration.update({
              where: { organizationId: vCase.applicant.organization.id },
              data: {
                cpcbPortalChecked: true,
                evidenceSourceUrl:
                  body.evidenceReferenceUrl ?? "https://eprewaste.cpcb.gov.in/",
                verifiedAt: new Date(),
              },
            });
          }
        }
      }

      return { updatedCase, decisionRecord };
    });

    await recordAuditEvent({
      actorId: admin.id,
      actorRole: admin.role,
      action: "ADMIN_VERIFICATION_DECISION",
      resourceType: "VerificationCase",
      resourceId: vCase.id,
      outcome: "SUCCESS",
      reason: body.reason,
      metadata: {
        applicantId: vCase.applicantId,
        decision: body.decision,
        grantedLevel,
        officialSourceChecked: body.officialSourceChecked,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, result);
  }
);

// PATCH /api/v1/admin/users/:userId/status — Suspend / Reactivate Account & Revoke Active Sessions
adminRouter.patch(
  "/users/:userId/status",
  validateBody(AdminUserStatusSchema),
  async (req, res) => {
    const admin = req.actor!;
    const targetUserId = String(req.params.userId);
    const prisma = await getPrisma();

    if (targetUserId === admin.id) {
      sendError(res, 400, "CANNOT_RESTRICT_SELF", "Cannot change your own admin status here");
      return;
    }

    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { accountStatus: req.body.accountStatus },
      select: {
        id: true,
        platformCode: true,
        role: true,
        accountStatus: true,
      },
    });

    if (req.body.accountStatus !== "ACTIVE") {
      await prisma.refreshToken.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedReason: `ACCOUNT_${req.body.accountStatus}`,
        },
      });
    }

    await recordAuditEvent({
      actorId: admin.id,
      actorRole: admin.role,
      action: "ADMIN_ACCOUNT_STATUS_CHANGED",
      resourceType: "User",
      resourceId: targetUserId,
      outcome: "SUCCESS",
      reason: req.body.reason,
      metadata: { newStatus: req.body.accountStatus },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { user: updated });
  }
);

// GET /api/v1/admin/audit-events — Restricted Append-Only Security & Business Audit Trail
adminRouter.get("/audit-events", async (req, res) => {
  const prisma = await getPrisma();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));

  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      actor: {
        select: {
          platformCode: true,
          role: true,
        },
      },
    },
  });

  sendSuccess(res, { events });
});

// GET /api/v1/admin/metrics — Operational Overview Across All 5 Tiers
adminRouter.get("/metrics", async (_req, res) => {
  const prisma = await getPrisma();
  const [userCount, storefrontCount, orderCount, pendingCases, auditCount] =
    await Promise.all([
      prisma.user.count(),
      prisma.storefront.count(),
      prisma.transactionOrder.count(),
      prisma.verificationCase.count({ where: { status: "PENDING" } }),
      prisma.auditEvent.count(),
    ]);

  sendSuccess(res, {
    metrics: {
      totalUsers: userCount,
      activeStorefronts: storefrontCount,
      totalTransactions: orderCount,
      pendingVerifications: pendingCases,
      immutableAuditEvents: auditCount,
    },
  });
});
