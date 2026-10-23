import crypto from "crypto";
import QRCode from "qrcode";
import { Router } from "express";
import {
  AdminResolveDisputeSchema,
  CreateDismantlingSchema,
  CreateDisputeSchema,
  CreateKhataAdvanceSchema,
  CreateMaterialListingSchema,
  OfflineSyncBatchSchema,
  TransactionStatus,
  calculateAmountPaise,
  canTransitionTransaction,
} from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import { sha256Hex } from "../../lib/security";

function formatPaiseExact(paise: number): string {
  const safe = Math.trunc(paise);
  const whole = Math.trunc(safe / 100);
  const frac = Math.abs(safe) % 100;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}
import {
  authenticate,
  requireCapability,
  requireRoles,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";

export const operationsRouter = Router();

// ============================================================================
// 1. IDEMPOTENT OFFLINE FIELD SYNC ENGINE (Architecture v0.2 Section 11.2)
// ============================================================================

operationsRouter.post(
  "/sync/batch",
  authenticate,
  validateBody(OfflineSyncBatchSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const { deviceLabel, operations } = req.body;

    const results: Array<{
      idempotencyKey: string;
      clientEntityId: string;
      operationType: string;
      status: "APPLIED" | "IDEMPOTENT_REPLAY_IGNORED" | "REJECTED_VALIDATION";
      alreadyApplied: boolean;
      serverRecord?: Record<string, unknown>;
      error?: string;
    }> = [];

    let newlyAppliedCount = 0;
    let idempotentSkippedCount = 0;
    let rejectedCount = 0;

    for (const op of operations) {
      // 1. Check strict server-side idempotency ledger (`@@unique([actorId, idempotencyKey])`)
      const existingOp = await prisma.syncOperation.findUnique({
        where: {
          actorId_idempotencyKey: {
            actorId: actor.id,
            idempotencyKey: op.idempotencyKey,
          },
        },
      });

      if (existingOp) {
        idempotentSkippedCount++;
        const stored = existingOp.payloadJson as Record<string, unknown>;
        results.push({
          idempotencyKey: op.idempotencyKey,
          clientEntityId: op.clientEntityId,
          operationType: op.operationType,
          status: "IDEMPOTENT_REPLAY_IGNORED",
          alreadyApplied: true,
          serverRecord: (stored.appliedResult as Record<string, unknown>) ?? stored,
        });
        continue;
      }

      // 2. Validate & execute supported field operation atomically
      if (op.operationType === "DRAFT_LISTING_CREATE") {
        const parsed = CreateMaterialListingSchema.safeParse(op.payload);
        if (!parsed.success) {
          rejectedCount++;
          results.push({
            idempotencyKey: op.idempotencyKey,
            clientEntityId: op.clientEntityId,
            operationType: op.operationType,
            status: "REJECTED_VALIDATION",
            alreadyApplied: false,
            error: "Invalid offline listing payload schema",
          });
          continue;
        }

        const p = parsed.data;
        const slugs = p.items.map((i) => i.materialSlug);
        const materials = await prisma.materialCategory.findMany({
          where: { slug: { in: slugs } },
        });
        const matBySlug = new Map(materials.map((m) => [m.slug, m]));
        if (materials.length !== slugs.length) {
          rejectedCount++;
          results.push({
            idempotencyKey: op.idempotencyKey,
            clientEntityId: op.clientEntityId,
            operationType: op.operationType,
            status: "REJECTED_VALIDATION",
            alreadyApplied: false,
            error: "Unknown material category slug in offline draft",
          });
          continue;
        }

        const targetSf = p.targetStorefrontId
          ? await prisma.storefront.findUnique({
              where: { id: p.targetStorefrontId },
              include: {
                organization: true,
                rateItems: { where: { isActive: true } },
              },
            })
          : null;

        let totalIndicativePaise = 0;
        const computedItems = p.items.map((it) => {
          const mat = matBySlug.get(it.materialSlug)!;
          const sfRate = targetSf?.rateItems.find((r) => r.materialId === mat.id);
          const ratePaise = sfRate
            ? p.preferredMode === "SELLER_DROPOFF"
              ? sfRate.dropoffRatePaise
              : sfRate.pickupRatePaise
            : 2500;
          const sub = calculateAmountPaise(it.estimatedGrams, ratePaise, mat.defaultUnit);
          totalIndicativePaise += sub;
          return {
            materialId: mat.id,
            estimatedGrams: it.estimatedGrams,
            indicativeRatePaise: ratePaise,
            indicativeSubtotalPaise: sub,
            conditionNote: it.conditionNote ?? null,
          };
        });

        const synced = await prisma.$transaction(async (tx) => {
          const listing = await tx.materialListing.create({
            data: {
              ownerId: actor.id,
              title: p.title,
              sellerTier: actor.tier,
              pickupCity: "Ludhiana",
              pickupPincode: p.pickupPincode,
              pickupAddressPrivate: p.pickupAddressPrivate,
              preferredMode: p.preferredMode,
              indicativeEstimatePaise: totalIndicativePaise,
              status: targetSf ? "REQUESTED" : "LISTED",
              items: { create: computedItems },
            },
          });

          let orderSummary: Record<string, unknown> | null = null;
          if (targetSf) {
            const ord = await tx.transactionOrder.create({
              data: {
                orderNumber: `KC-ORD-SYNC-${crypto.randomInt(10000, 99999)}`,
                listingId: listing.id,
                sellerId: actor.id,
                buyerId: targetSf.organization.ownerUserId,
                storefrontId: targetSf.id,
                sellerTier: actor.tier,
                buyerTier: targetSf.organization.tier,
                fulfillmentMode: p.preferredMode,
                status: "REQUESTED",
                indicativeTotalPaise: totalIndicativePaise,
                agreedTotalPaise: totalIndicativePaise,
                qrTraceToken: `KC-TRACE-${crypto.randomBytes(8).toString("hex").toUpperCase()}`,
                items: {
                  create: computedItems.map((ci) => ({
                    materialId: ci.materialId,
                    lockedRatePaise: ci.indicativeRatePaise,
                    estimatedGrams: ci.estimatedGrams,
                    agreedSubtotalPaise: ci.indicativeSubtotalPaise,
                  })),
                },
              },
            });
            orderSummary = {
              id: ord.id,
              orderNumber: ord.orderNumber,
              qrTraceToken: ord.qrTraceToken,
            };
          }

          const appliedResult = {
            listingId: listing.id,
            title: listing.title,
            indicativeEstimatePaise: listing.indicativeEstimatePaise,
            order: orderSummary,
          };

          await tx.syncOperation.create({
            data: {
              actorId: actor.id,
              idempotencyKey: op.idempotencyKey,
              operationType: op.operationType,
              clientEntityId: op.clientEntityId,
              payloadJson: JSON.parse(
                JSON.stringify({ input: op.payload, appliedResult })
              ),
              status: "APPLIED",
            },
          });

          return appliedResult;
        });

        newlyAppliedCount++;
        results.push({
          idempotencyKey: op.idempotencyKey,
          clientEntityId: op.clientEntityId,
          operationType: op.operationType,
          status: "APPLIED",
          alreadyApplied: false,
          serverRecord: synced,
        });
      } else if (op.operationType === "KHATA_ADVANCE_RECORD") {
        const parsed = CreateKhataAdvanceSchema.safeParse(op.payload);
        if (!parsed.success) {
          rejectedCount++;
          results.push({
            idempotencyKey: op.idempotencyKey,
            clientEntityId: op.clientEntityId,
            operationType: op.operationType,
            status: "REJECTED_VALIDATION",
            alreadyApplied: false,
            error: "Invalid offline Khata advance payload",
          });
          continue;
        }

        const p = parsed.data;
        const borrower = await prisma.user.findUnique({
          where: { platformCode: p.borrowerPlatformCode },
        });
        if (!borrower || borrower.id === actor.id) {
          rejectedCount++;
          results.push({
            idempotencyKey: op.idempotencyKey,
            clientEntityId: op.clientEntityId,
            operationType: op.operationType,
            status: "REJECTED_VALIDATION",
            alreadyApplied: false,
            error: "Unknown or invalid supplier Platform Code",
          });
          continue;
        }

        const synced = await prisma.$transaction(async (tx) => {
          const prev = await tx.khataLedgerEntry.findFirst({
            where: { lenderId: actor.id, borrowerId: borrower.id },
            orderBy: { createdAt: "desc" },
          });
          const priorBal = prev?.balanceAfterPaise ?? 0;
          const nextBal =
            p.entryType === "CASH_ADVANCE_GIVEN"
              ? priorBal + p.amountPaise
              : Math.max(0, priorBal - p.amountPaise);

          const entry = await tx.khataLedgerEntry.create({
            data: {
              lenderId: actor.id,
              borrowerId: borrower.id,
              entryType: p.entryType,
              amountPaise: p.amountPaise,
              balanceAfterPaise: nextBal,
              notes: p.notes ?? "Synced offline Khata entry",
            },
          });

          const appliedResult = {
            khataEntryId: entry.id,
            balanceAfterPaise: entry.balanceAfterPaise,
          };

          await tx.syncOperation.create({
            data: {
              actorId: actor.id,
              idempotencyKey: op.idempotencyKey,
              operationType: op.operationType,
              clientEntityId: op.clientEntityId,
              payloadJson: JSON.parse(
                JSON.stringify({ input: op.payload, appliedResult })
              ),
              status: "APPLIED",
            },
          });

          return appliedResult;
        });

        newlyAppliedCount++;
        results.push({
          idempotencyKey: op.idempotencyKey,
          clientEntityId: op.clientEntityId,
          operationType: op.operationType,
          status: "APPLIED",
          alreadyApplied: false,
          serverRecord: synced,
        });
      } else if (op.operationType === "DISMANTLING_LOG") {
        const parsed = CreateDismantlingSchema.safeParse(op.payload);
        if (!parsed.success) {
          rejectedCount++;
          results.push({
            idempotencyKey: op.idempotencyKey,
            clientEntityId: op.clientEntityId,
            operationType: op.operationType,
            status: "REJECTED_VALIDATION",
            alreadyApplied: false,
            error: "Invalid offline dismantling schema",
          });
          continue;
        }

        const p = parsed.data;
        const sumOut =
          p.outputs.reduce((acc, o) => acc + o.outputGrams, 0) + p.residueGrams;
        const org = await prisma.organization.findUnique({
          where: { ownerUserId: actor.id },
        });

        if (!org || sumOut > p.inputGrams) {
          rejectedCount++;
          results.push({
            idempotencyKey: op.idempotencyKey,
            clientEntityId: op.clientEntityId,
            operationType: op.operationType,
            status: "REJECTED_VALIDATION",
            alreadyApplied: false,
            error: !org
              ? "Account has no shop organization for dismantling"
              : "Mass conservation violated (outputs + residue > input)",
          });
          continue;
        }

        const slugs = p.outputs.map((o) => o.materialSlug);
        const mats = await prisma.materialCategory.findMany({
          where: { slug: { in: slugs } },
        });
        const matMap = new Map(mats.map((m) => [m.slug, m]));

        const synced = await prisma.$transaction(async (tx) => {
          const rec = await tx.dismantlingRecord.create({
            data: {
              organizationId: org.id,
              inputDescription: p.inputDescription,
              inputGrams: p.inputGrams,
              residueGrams: p.residueGrams,
              outputsJson: p.outputs,
            },
          });

          for (const out of p.outputs) {
            const m = matMap.get(out.materialSlug);
            if (!m) continue;
            await tx.inventoryBin.upsert({
              where: {
                organizationId_materialId: {
                  organizationId: org.id,
                  materialId: m.id,
                },
              },
              update: { availableGrams: { increment: out.outputGrams } },
              create: {
                organizationId: org.id,
                materialId: m.id,
                availableGrams: out.outputGrams,
                weightedAvgCostPaise: 0,
              },
            });
          }

          const appliedResult = { dismantlingRecordId: rec.id };

          await tx.syncOperation.create({
            data: {
              actorId: actor.id,
              idempotencyKey: op.idempotencyKey,
              operationType: op.operationType,
              clientEntityId: op.clientEntityId,
              payloadJson: JSON.parse(
                JSON.stringify({ input: op.payload, appliedResult })
              ),
              status: "APPLIED",
            },
          });

          return appliedResult;
        });

        newlyAppliedCount++;
        results.push({
          idempotencyKey: op.idempotencyKey,
          clientEntityId: op.clientEntityId,
          operationType: op.operationType,
          status: "APPLIED",
          alreadyApplied: false,
          serverRecord: synced,
        });
      }
    }

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "OFFLINE_SYNC_BATCH_PROCESSED",
      resourceType: "SyncOperation",
      outcome: "SUCCESS",
      metadata: {
        deviceLabel,
        totalSubmitted: operations.length,
        newlyAppliedCount,
        idempotentSkippedCount,
        rejectedCount,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, {
      deviceLabel,
      summary: {
        totalSubmitted: operations.length,
        newlyAppliedCount,
        idempotentSkippedCount,
        rejectedCount,
      },
      results,
    });
  }
);

// GET /api/v1/sync/operations — Inspect Own (or Admin All) Idempotent Sync Ledger
operationsRouter.get("/sync/operations", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const operations = await prisma.syncOperation.findMany({
    where: actor.role === "ADMIN" ? {} : { actorId: actor.id },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  sendSuccess(res, { operations });
});

// ============================================================================
// 2. TRANSACTION DISPUTES, ESCROW HOLD & ADMIN RESOLUTION WORKFLOW
// ============================================================================

// POST /api/v1/orders/:orderId/disputes — Participant Raises Dispute (Freezes Settlement)
operationsRouter.post(
  "/orders/:orderId/disputes",
  authenticate,
  requireCapability("dispute:raise"),
  validateBody(CreateDisputeSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const orderId = String(req.params.orderId);
    const { reasonCategory, description } = req.body;

    const order = await prisma.transactionOrder.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      sendError(res, 404, "ORDER_NOT_FOUND", "Order not found");
      return;
    }

    // Strict Horizontal BOLA Check: Only actual Seller or Buyer on the order can dispute!
    if (order.sellerId !== actor.id && order.buyerId !== actor.id) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "BOLA_DENIED",
        resourceType: "TransactionOrder",
        resourceId: order.id,
        outcome: "DENIED",
        reason: "Non-participant attempted to raise a transaction dispute",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        403,
        "FORBIDDEN",
        "Only the buyer or seller participating in this order may raise a dispute"
      );
      return;
    }

    if (!canTransitionTransaction(order.status as TransactionStatus, "DISPUTED")) {
      sendError(
        res,
        400,
        "INVALID_STATE_TRANSITION",
        `Cannot open a dispute when order is in state ${order.status}`
      );
      return;
    }

    const counterpartyId = order.sellerId === actor.id ? order.buyerId : order.sellerId;

    const created = await prisma.$transaction(async (tx) => {
      const dispute = await tx.dispute.create({
        data: {
          orderId: order.id,
          raisedById: actor.id,
          reasonCategory,
          description,
          status: "OPEN",
        },
      });

      const updatedOrder = await tx.transactionOrder.update({
        where: { id: order.id },
        data: { status: "DISPUTED" },
      });

      await tx.notification.create({
        data: {
          userId: counterpartyId,
          title: `Dispute Opened on Order ${order.orderNumber}`,
          body: `Category: ${reasonCategory}. Unilateral settlement is paused pending review.`,
        },
      });

      return { dispute, updatedOrder };
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "ORDER_DISPUTE_RAISED",
      resourceType: "Dispute",
      resourceId: created.dispute.id,
      outcome: "SUCCESS",
      reason: `${reasonCategory}: ${description.slice(0, 120)}`,
      metadata: { orderId: order.id, orderNumber: order.orderNumber, reasonCategory },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, created, 201);
  }
);

// GET /api/v1/disputes — Participant's Own Disputes OR Full Queue for ADMIN
operationsRouter.get("/disputes", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();

  const disputes = await prisma.dispute.findMany({
    where:
      actor.role === "ADMIN"
        ? {}
        : {
            OR: [
              { raisedById: actor.id },
              { order: { sellerId: actor.id } },
              { order: { buyerId: actor.id } },
            ],
          },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          status: true,
          sellerId: true,
          buyerId: true,
          sellerTier: true,
          buyerTier: true,
          agreedTotalPaise: true,
          finalSettlementPaise: true,
          qrTraceToken: true,
        },
      },
      raisedBy: {
        select: {
          platformCode: true,
          role: true,
          profile: { select: { displayName: true } },
        },
      },
      resolvedBy: {
        select: {
          platformCode: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  sendSuccess(res, { disputes });
});

// POST /api/v1/admin/disputes/:disputeId/resolve — Admin Arbitration & Settlement Release / Cancel
operationsRouter.post(
  "/admin/disputes/:disputeId/resolve",
  authenticate,
  requireRoles("ADMIN"),
  validateBody(AdminResolveDisputeSchema),
  async (req, res) => {
    const admin = req.actor!;
    const prisma = await getPrisma();
    const disputeId = String(req.params.disputeId);
    const { decision, resolutionNotes, adjustedSettlementPaise } = req.body;

    const dispute = await prisma.dispute.findUnique({
      where: { id: disputeId },
      include: { order: true },
    });

    if (!dispute) {
      sendError(res, 404, "DISPUTE_NOT_FOUND", "Dispute record not found");
      return;
    }

    const nextOrderStatus: TransactionStatus =
      decision === "UNDER_REVIEW"
        ? "ON_HOLD"
        : decision === "RESOLVED_CANCELLED"
          ? "CANCELLED"
          : decision === "RESOLVED_ADJUSTED"
            ? "COMPLETED"
            : "ACCEPTED";

    const arbitratedAmount =
      decision === "RESOLVED_ADJUSTED"
        ? (adjustedSettlementPaise ??
          dispute.order.finalSettlementPaise ??
          dispute.order.agreedTotalPaise)
        : dispute.order.finalSettlementPaise;

    const nextDisputeStatus =
      decision === "UNDER_REVIEW"
        ? "UNDER_REVIEW"
        : decision === "REJECTED"
          ? "REJECTED"
          : "RESOLVED";

    const resolved = await prisma.$transaction(async (tx) => {
      const updatedDispute = await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: nextDisputeStatus,
          resolvedById: decision === "UNDER_REVIEW" ? null : admin.id,
          resolutionNotes,
          resolvedAt: decision === "UNDER_REVIEW" ? null : new Date(),
        },
      });

      const updatedOrder = await tx.transactionOrder.update({
        where: { id: dispute.orderId },
        data: {
          status: nextOrderStatus,
          finalSettlementPaise: arbitratedAmount,
          priceAdjustmentReason: resolutionNotes,
          completedAt:
            decision === "RESOLVED_ADJUSTED" ? new Date() : dispute.order.completedAt,
        },
      });

      if (
        decision === "RESOLVED_ADJUSTED" &&
        dispute.order.finalSettlementPaise === null &&
        typeof arbitratedAmount === "number"
      ) {
        await tx.paymentRecord.create({
          data: {
            orderId: dispute.orderId,
            amountPaise: arbitratedAmount,
            method: "CASH",
            status: "PAID",
            recordedById: admin.id,
            paidAt: new Date(),
          },
        });
      }

      // Notify both transaction participants without exposing sensitive PII
      for (const participantId of [dispute.order.sellerId, dispute.order.buyerId]) {
        await tx.notification.create({
          data: {
            userId: participantId,
            title: `Admin Arbitration Decision on ${dispute.order.orderNumber}: ${decision}`,
            body: resolutionNotes,
          },
        });
      }

      return { dispute: updatedDispute, order: updatedOrder };
    });

    await recordAuditEvent({
      actorId: admin.id,
      actorRole: admin.role,
      action: "ADMIN_DISPUTE_RESOLVED",
      resourceType: "Dispute",
      resourceId: dispute.id,
      outcome: "SUCCESS",
      reason: `${decision}: ${resolutionNotes}`,
      metadata: {
        orderId: dispute.orderId,
        nextOrderStatus,
        arbitratedAmountPaise: arbitratedAmount ?? null,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, resolved);
  }
);

// ============================================================================
// 3. MULTI-TIER PRICE HISTORY TRENDS, ANALYTICS & PII-SAFE NOTIFICATIONS
// ============================================================================

operationsRouter.get("/materials/price-history", async (req, res) => {
  const prisma = await getPrisma();
  const slugFilter = req.query.materialSlug ? String(req.query.materialSlug) : undefined;
  const city = req.query.city ? String(req.query.city) : "Ludhiana";

  const history = await prisma.priceHistory.findMany({
    where: {
      city,
      ...(slugFilter ? { material: { slug: slugFilter } } : {}),
    },
    include: {
      material: {
        select: {
          slug: true,
          nameEn: true,
          nameHi: true,
          namePa: true,
          nameMr: true,
          streamGroup: true,
          defaultUnit: true,
        },
      },
    },
    orderBy: { recordedAt: "asc" },
  });

  // Compute live inter-tier arbitrage spread summary across open storefronts
  const activeRates = await prisma.storefrontRateItem.findMany({
    where: { isActive: true, storefront: { isOpen: true } },
    include: {
      material: { select: { slug: true, nameEn: true } },
      storefront: { include: { organization: { select: { tier: true } } } },
    },
  });

  const spreadMap = new Map<
    string,
    { slug: string; nameEn: string; minPickupPaise: number; maxDropoffPaise: number }
  >();
  for (const r of activeRates) {
    const cur = spreadMap.get(r.material.slug);
    if (!cur) {
      spreadMap.set(r.material.slug, {
        slug: r.material.slug,
        nameEn: r.material.nameEn,
        minPickupPaise: r.pickupRatePaise,
        maxDropoffPaise: r.dropoffRatePaise,
      });
    } else {
      cur.minPickupPaise = Math.min(cur.minPickupPaise, r.pickupRatePaise);
      cur.maxDropoffPaise = Math.max(cur.maxDropoffPaise, r.dropoffRatePaise);
    }
  }

  const tierArbitrageSpreads = Array.from(spreadMap.values()).map((s) => ({
    ...s,
    fullChainSpreadPaisePerKg: Math.max(0, s.maxDropoffPaise - s.minPickupPaise),
  }));

  sendSuccess(res, { city, history, tierArbitrageSpreads });
});

operationsRouter.get("/notifications", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const notifications = await prisma.notification.findMany({
    where: { userId: actor.id },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  const unreadCount = notifications.filter((n) => n.readAt === null).length;
  sendSuccess(res, { notifications, unreadCount });
});

operationsRouter.post("/notifications/read-all", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  await prisma.notification.updateMany({
    where: { userId: actor.id, readAt: null },
    data: { readAt: new Date() },
  });
  sendSuccess(res, { markedRead: true });
});

// ============================================================================
// 4. DYNAMIC PAISE-EXACT UPI INTENT QR & TAMPER-EVIDENT THERMAL SETTLEMENT SLIP
// ============================================================================

operationsRouter.get("/orders/:orderId/settlement-slip", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const orderId = String(req.params.orderId);

  const order = await prisma.transactionOrder.findUnique({
    where: { id: orderId },
    include: {
      seller: {
        select: {
          id: true,
          platformCode: true,
          role: true,
          tier: true,
          verificationLevel: true,
          profile: { select: { displayName: true, city: true } },
          organization: { select: { businessName: true } },
        },
      },
      buyer: {
        select: {
          id: true,
          platformCode: true,
          role: true,
          tier: true,
          verificationLevel: true,
          profile: { select: { displayName: true, city: true } },
          organization: { select: { businessName: true } },
        },
      },
      storefront: {
        select: {
          shopTitle: true,
          servicePincodes: true,
        },
      },
      items: {
        include: {
          material: {
            select: {
              slug: true,
              nameEn: true,
              nameHi: true,
              namePa: true,
              nameMr: true,
              defaultUnit: true,
              isRegulatedHazardous: true,
            },
          },
        },
      },
      paymentRecords: {
        orderBy: { createdAt: "asc" },
      },
      handoverRecords: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!order) {
    sendError(res, 404, "ORDER_NOT_FOUND", "Order not found");
    return;
  }

  // Strict Horizontal BOLA Enforcement: Only actual Seller, Buyer, or Security Admin may access settlement receipt
  if (order.sellerId !== actor.id && order.buyerId !== actor.id && actor.role !== "ADMIN") {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "BOLA_SETTLEMENT_SLIP_DENIED",
      resourceType: "TransactionOrder",
      resourceId: order.id,
      outcome: "DENIED",
      reason: "Unauthorized user attempted to read private settlement slip & UPI QR",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(
      res,
      403,
      "FORBIDDEN",
      "Only participants on this order or Security Admin may access its settlement slip"
    );
    return;
  }

  const grossAmountPaise = order.finalSettlementPaise ?? order.agreedTotalPaise;
  const khataAdvanceOffsetPaise = order.paymentRecords
    .filter((p) => p.method === "LEDGER_OFFSET")
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const netPayablePaise = Math.max(0, grossAmountPaise - khataAdvanceOffsetPaise);
  const netPayableExactInr = formatPaiseExact(netPayablePaise);

  const sellerName =
    order.seller.organization?.businessName ??
    order.seller.profile?.displayName ??
    order.seller.platformCode;
  const buyerName =
    order.storefront?.shopTitle ??
    order.buyer.organization?.businessName ??
    order.buyer.profile?.displayName ??
    order.buyer.platformCode;

  // Privacy-safe Platform ID handle (never leaks personal phone numbers in QR payload)
  const payeeVpa = `${order.seller.platformCode
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ".")}@okaxis`;

  const upiIntentUri =
    netPayablePaise > 0
      ? `upi://pay?pa=${encodeURIComponent(payeeVpa)}&pn=${encodeURIComponent(
          sellerName
        )}&am=${netPayableExactInr}&cu=INR&tr=${encodeURIComponent(
          order.orderNumber
        )}&tn=${encodeURIComponent(`Kabadiwala ${order.orderNumber}`)}`
      : null;

  const originHeader =
    typeof req.headers.origin === "string" && req.headers.origin.startsWith("http")
      ? req.headers.origin
      : `${req.protocol}://${req.get("host") ?? "localhost:3000"}`;
  const publicTraceUrl = `${originHeader}/trace/${encodeURIComponent(order.qrTraceToken)}`;

  const [upiQrSvg, traceQrSvg] = await Promise.all([
    upiIntentUri
      ? QRCode.toString(upiIntentUri, {
          type: "svg",
          errorCorrectionLevel: "M",
          margin: 1,
          width: 190,
          color: { dark: "#022c22", light: "#ffffff" },
        })
      : Promise.resolve(null),
    QRCode.toString(publicTraceUrl, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 190,
      color: { dark: "#1e1b4b", light: "#ffffff" },
    }),
  ]);

  const canonicalSlipPayload = JSON.stringify({
    orderNumber: order.orderNumber,
    status: order.status,
    sellerCode: order.seller.platformCode,
    buyerCode: order.buyer.platformCode,
    grossAmountPaise,
    khataAdvanceOffsetPaise,
    netPayablePaise,
    qrTraceToken: order.qrTraceToken,
  });
  const receiptDigestSha256 = sha256Hex(Buffer.from(canonicalSlipPayload, "utf8"));

  sendSuccess(res, {
    slip: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      fulfillmentMode: order.fulfillmentMode,
      createdAt: order.createdAt,
      completedAt: order.completedAt,
      qrTraceToken: order.qrTraceToken,
      publicTraceUrl,
      seller: {
        platformCode: order.seller.platformCode,
        displayName: sellerName,
        tier: order.seller.tier,
      },
      buyer: {
        platformCode: order.buyer.platformCode,
        displayName: buyerName,
        tier: order.buyer.tier,
        verificationLevel: order.buyer.verificationLevel,
      },
      lineItems: order.items.map((it) => ({
        id: it.id,
        nameEn: it.material.nameEn,
        nameHi: it.material.nameHi,
        namePa: it.material.namePa,
        nameMr: it.material.nameMr,
        isRegulatedHazardous: it.material.isRegulatedHazardous,
        lockedRatePaise: it.lockedRatePaise,
        estimatedGrams: it.estimatedGrams,
        actualGrams: it.actualGrams,
        subtotalPaise: it.finalSubtotalPaise ?? it.agreedSubtotalPaise,
      })),
      totals: {
        grossAmountPaise,
        grossFormattedInr: formatPaiseExact(grossAmountPaise),
        khataAdvanceOffsetPaise,
        khataOffsetFormattedInr: formatPaiseExact(khataAdvanceOffsetPaise),
        netPayablePaise,
        netPayableExactInr,
      },
      upi: {
        payeeVpa,
        upiIntentUri,
        upiQrSvg,
      },
      traceQrSvg,
      handoverHashSha256: order.handoverRecords[0]?.evidenceHashSha256 ?? null,
      receiptDigestSha256,
      statutoryDisclaimer:
        "Commercial weighment & settlement slip generated by Kabadiwala Connect. Not a GST tax invoice or statutory CPCB Form-6 manifest.",
    },
  });
});

