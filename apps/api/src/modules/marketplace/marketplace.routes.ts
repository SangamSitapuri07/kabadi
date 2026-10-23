import crypto from "crypto";
import { Router } from "express";
import {
  CreateMaterialListingSchema,
  DeviceXrayScanRequestSchema,
  RecordWeighingSchema,
  TransactionStatus,
  UpsertStorefrontRateSchema,
  calculateAmountPaise,
  canTransitionTransaction,
  paiseToInrString,
} from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import { sha256Hex } from "../../lib/security";
import {
  aiRateLimiter,
  authenticate,
  requireCapability,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";

export const marketplaceRouter = Router();

// GET /api/v1/materials — Database-driven Material & Regulated Stream Catalog
marketplaceRouter.get("/materials", async (_req, res) => {
  const prisma = await getPrisma();
  const categories = await prisma.materialCategory.findMany({
    where: { isActive: true },
    orderBy: [{ streamGroup: "asc" }, { nameEn: "asc" }],
  });
  sendSuccess(res, { categories });
});

// GET /api/v1/storefronts — Zomato-Style Multi-Tier Kabadi Storefront Discovery
marketplaceRouter.get("/storefronts", async (req, res) => {
  const prisma = await getPrisma();
  const tierFilter = typeof req.query.tier === "string" ? req.query.tier : undefined;

  const storefronts = await prisma.storefront.findMany({
    where: {
      ...(tierFilter
        ? {
            organization: {
              tier: tierFilter as
                | "TIER_1_LOCAL_COLLECTOR"
                | "TIER_2_AREA_SHOP"
                | "TIER_3_WHOLESALE_AGGREGATOR"
                | "TIER_4_AUTHORISED_RECYCLER",
            },
          }
        : {}),
    },
    include: {
      organization: {
        select: {
          id: true,
          tier: true,
          platformCode: true,
          businessName: true,
          city: true,
          pincode: true,
          serviceRadiusKm: true,
          verificationLevel: true,
          recyclerRegistration: {
            select: {
              authorityName: true,
              registrationNumber: true,
              cpcbPortalChecked: true,
              permittedStreams: true,
            },
          },
        },
      },
      rateItems: {
        where: { isActive: true },
        include: {
          material: {
            select: {
              slug: true,
              nameEn: true,
              nameHi: true,
              namePa: true,
              streamGroup: true,
              defaultUnit: true,
              isRegulatedHazardous: true,
            },
          },
        },
        orderBy: { pickupRatePaise: "desc" },
      },
    },
    orderBy: [{ isOpen: "desc" }, { ratingAvg: "desc" }],
  });

  sendSuccess(res, {
    storefronts,
    pricingDisclaimer:
      "Published storefront rates are business purchase offers for specified grades/minimum weights and remain subject to physical inspection and verified scale weighing.",
  });
});

// POST /api/v1/storefronts/my/rates — Versioned Rate Menu Update (Never Silently Overwrites History!)
marketplaceRouter.post(
  "/storefronts/my/rates",
  authenticate,
  requireCapability("storefront:manage:own"),
  validateBody(UpsertStorefrontRateSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();

    const org = await prisma.organization.findUnique({
      where: { ownerUserId: actor.id },
      include: { storefront: true },
    });

    if (!org || !org.storefront) {
      sendError(res, 404, "STOREFRONT_NOT_FOUND", "No storefront exists for this account");
      return;
    }

    const material = await prisma.materialCategory.findUnique({
      where: { slug: req.body.materialSlug },
    });

    if (!material) {
      sendError(res, 404, "MATERIAL_NOT_FOUND", "Material category does not exist");
      return;
    }

    // Enforce regulated stream buyer verification gate!
    if (
      material.isRegulatedHazardous &&
      org.tier === "TIER_4_AUTHORISED_RECYCLER" &&
      actor.verificationLevel !== "LEVEL_4_AUTHORISED_RECYCLER"
    ) {
      sendError(
        res,
        403,
        "RECYCLER_VERIFICATION_REQUIRED",
        "Level 4 Verified Authorised Recycler status is required before publishing industrial regulated e-waste offers"
      );
      return;
    }

    const currentActive = await prisma.storefrontRateItem.findFirst({
      where: {
        storefrontId: org.storefront.id,
        materialId: material.id,
        isActive: true,
      },
    });

    const nextVersion = currentActive ? currentActive.version + 1 : 1;

    const createdRate = await prisma.$transaction(async (tx) => {
      if (currentActive) {
        await tx.storefrontRateItem.update({
          where: { id: currentActive.id },
          data: { isActive: false, supersededAt: new Date() },
        });
      }
      return tx.storefrontRateItem.create({
        data: {
          storefrontId: org.storefront!.id,
          materialId: material.id,
          pickupRatePaise: req.body.pickupRatePaise,
          dropoffRatePaise: req.body.dropoffRatePaise,
          minWeightGrams: req.body.minWeightGrams,
          purityGrade: req.body.purityGrade,
          version: nextVersion,
          isActive: true,
        },
        include: { material: true },
      });
    });

    await prisma.priceHistory.create({
      data: {
        city: org.city,
        tier: org.tier,
        materialId: material.id,
        medianRatePaise: Math.round(
          (createdRate.pickupRatePaise + createdRate.dropoffRatePaise) / 2
        ),
        minRatePaise: Math.min(createdRate.pickupRatePaise, createdRate.dropoffRatePaise),
        maxRatePaise: Math.max(createdRate.pickupRatePaise, createdRate.dropoffRatePaise),
        sampleCount: 1,
      },
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "STOREFRONT_RATE_VERSION_PUBLISHED",
      resourceType: "StorefrontRateItem",
      resourceId: createdRate.id,
      outcome: "SUCCESS",
      metadata: {
        materialSlug: material.slug,
        version: nextVersion,
        pickupRatePaise: createdRate.pickupRatePaise,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { rateItem: createdRate }, 201);
  }
);

// POST /api/v1/listings — Create Multi-Tier Listing & Optional Direct Storefront Pickup Request
marketplaceRouter.post(
  "/listings",
  authenticate,
  requireCapability("listing:create"),
  validateBody(CreateMaterialListingSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const body = req.body as {
      title: string;
      pickupPincode: string;
      pickupAddressPrivate: string;
      preferredMode: "BUYER_PICKUP" | "SELLER_DROPOFF";
      targetStorefrontId?: string;
      items: Array<{
        materialSlug: string;
        estimatedGrams: number;
        conditionNote?: string;
      }>;
    };

    const userProfile = await prisma.userProfile.findUnique({
      where: { userId: actor.id },
    });

    const slugs = body.items.map((i) => i.materialSlug);
    const materials = await prisma.materialCategory.findMany({
      where: { slug: { in: slugs }, isActive: true },
    });
    const matMap = new Map(materials.map((m) => [m.slug, m]));

    if (matMap.size !== new Set(slugs).size) {
      sendError(res, 400, "UNKNOWN_MATERIAL", "One or more selected materials are invalid");
      return;
    }

    let targetStorefront = null;
    if (body.targetStorefrontId) {
      targetStorefront = await prisma.storefront.findUnique({
        where: { id: body.targetStorefrontId },
        include: {
          organization: true,
          rateItems: { where: { isActive: true } },
        },
      });
      if (!targetStorefront) {
        sendError(res, 404, "STOREFRONT_NOT_FOUND", "Selected buyer storefront not found");
        return;
      }
      if (targetStorefront.organization.ownerUserId === actor.id) {
        sendError(res, 400, "SELF_ORDER_FORBIDDEN", "Cannot create an order with your own storefront");
        return;
      }
    }

    // Compute exact integer-paise indicative amounts from published rate cards
    let totalIndicativePaise = 0;
    const computedItems = body.items.map((item) => {
      const mat = matMap.get(item.materialSlug)!;
      const matchingRate = targetStorefront?.rateItems.find(
        (r) => r.materialId === mat.id
      );
      const ratePaise = matchingRate
        ? body.preferredMode === "SELLER_DROPOFF"
          ? matchingRate.dropoffRatePaise
          : matchingRate.pickupRatePaise
        : 1500; // Illustrative fallback if open broadcast listing
      const subtotalPaise = calculateAmountPaise(
        item.estimatedGrams,
        ratePaise,
        mat.defaultUnit as "KG" | "PIECE"
      );
      totalIndicativePaise += subtotalPaise;
      return {
        materialId: mat.id,
        estimatedGrams: item.estimatedGrams,
        indicativeRatePaise: ratePaise,
        indicativeSubtotalPaise: subtotalPaise,
        conditionNote: item.conditionNote ?? null,
      };
    });

    const result = await prisma.$transaction(async (tx) => {
      const listing = await tx.materialListing.create({
        data: {
          ownerId: actor.id,
          title: body.title,
          sellerTier: actor.tier,
          pickupCity: userProfile?.city ?? "Ludhiana",
          pickupPincode: body.pickupPincode,
          pickupAddressPrivate: body.pickupAddressPrivate,
          preferredMode: body.preferredMode,
          indicativeEstimatePaise: totalIndicativePaise,
          status: targetStorefront ? "REQUESTED" : "LISTED",
          items: { create: computedItems },
        },
        include: { items: { include: { material: true } } },
      });

      let order = null;
      if (targetStorefront) {
        const orderNumber = `KC-ORD-${new Date()
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, "")}-${crypto.randomInt(1000, 9999)}`;
        order = await tx.transactionOrder.create({
          data: {
            orderNumber,
            listingId: listing.id,
            sellerId: actor.id,
            buyerId: targetStorefront.organization.ownerUserId,
            storefrontId: targetStorefront.id,
            sellerTier: actor.tier,
            buyerTier: targetStorefront.organization.tier,
            fulfillmentMode: body.preferredMode,
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
          include: { items: { include: { material: true } }, storefront: true },
        });
      }

      return { listing, order };
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "MATERIAL_LISTING_CREATED",
      resourceType: "MaterialListing",
      resourceId: result.listing.id,
      outcome: "SUCCESS",
      metadata: {
        indicativeEstimatePaise: totalIndicativePaise,
        orderNumber: result.order?.orderNumber ?? null,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, result, 201);
  }
);

// GET /api/v1/orders — Strictly Scoped to Seller/Buyer Participant or Admin!
marketplaceRouter.get("/orders", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();

  const orders = await prisma.transactionOrder.findMany({
    where:
      actor.role === "ADMIN"
        ? {}
        : {
            OR: [{ sellerId: actor.id }, { buyerId: actor.id }],
          },
    include: {
      storefront: { select: { shopTitle: true, slug: true } },
      items: { include: { material: { select: { slug: true, nameEn: true, defaultUnit: true } } } },
      weighingRecords: true,
      handoverRecords: true,
      paymentRecords: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  sendSuccess(res, { orders });
});

// GET /api/v1/orders/:orderId — Object-Level Participant Check (BOLA Defense!)
marketplaceRouter.get("/orders/:orderId", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const order = await prisma.transactionOrder.findUnique({
    where: { id: String(req.params.orderId) },
    include: {
      listing: true,
      items: { include: { material: true } },
      weighingRecords: true,
      handoverRecords: true,
      paymentRecords: true,
    },
  });

  if (!order) {
    sendError(res, 404, "ORDER_NOT_FOUND", "Transaction not found");
    return;
  }

  if (
    order.sellerId !== actor.id &&
    order.buyerId !== actor.id &&
    actor.role !== "ADMIN"
  ) {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "BOLA_ORDER_ACCESS_DENIED",
      resourceType: "TransactionOrder",
      resourceId: order.id,
      outcome: "DENIED",
      reason: "User attempted to view private transaction belonging to other parties",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(res, 403, "FORBIDDEN", "Not authorised to access this transaction");
    return;
  }

  sendSuccess(res, { order });
});

// POST /api/v1/orders/:orderId/accept — Buyer Accepts Order
marketplaceRouter.post("/orders/:orderId/accept", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const order = await prisma.transactionOrder.findUnique({
    where: { id: String(req.params.orderId) },
  });

  if (!order) {
    sendError(res, 404, "ORDER_NOT_FOUND", "Order not found");
    return;
  }
  if (order.buyerId !== actor.id) {
    sendError(res, 403, "FORBIDDEN", "Only the designated buyer may accept this request");
    return;
  }
  if (!canTransitionTransaction(order.status as TransactionStatus, "COLLECTED")) {
    // Allow REQUESTED -> ACCEPTED
    if (!canTransitionTransaction(order.status as TransactionStatus, "ACCEPTED")) {
      sendError(res, 400, "INVALID_STATE_TRANSITION", `Cannot accept from ${order.status}`);
      return;
    }
  }

  const updated = await prisma.transactionOrder.update({
    where: { id: order.id },
    data: { status: "ACCEPTED" },
  });

  await recordAuditEvent({
    actorId: actor.id,
    actorRole: actor.role,
    action: "ORDER_ACCEPTED",
    resourceType: "TransactionOrder",
    resourceId: order.id,
    outcome: "SUCCESS",
    correlationId: req.correlationId,
    ipAddress: req.ip,
  });

  sendSuccess(res, { order: updated });
});

// POST /api/v1/orders/:orderId/weigh-and-settle — Actual Scale Weight + OCR Check + Cash/UPI Settlement + Stock Bin Update
marketplaceRouter.post(
  "/orders/:orderId/weigh-and-settle",
  authenticate,
  validateBody(RecordWeighingSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();

    const order = await prisma.transactionOrder.findUnique({
      where: { id: String(req.params.orderId) },
      include: { items: { include: { material: true } }, seller: { include: { profile: true } } },
    });

    if (!order) {
      sendError(res, 404, "ORDER_NOT_FOUND", "Order not found");
      return;
    }
    if (order.buyerId !== actor.id) {
      sendError(res, 403, "FORBIDDEN", "Only the buying participant can record scale weighing");
      return;
    }
    if (order.status === "DISPUTED" || order.status === "ON_HOLD") {
      sendError(
        res,
        409,
        "ORDER_DISPUTED_LOCKED",
        "Order is currently frozen under active dispute/hold review — Admin arbitration required"
      );
      return;
    }
    if (order.status === "COMPLETED" || order.status === "CANCELLED") {
      sendError(
        res,
        400,
        "IMMUTABLE_COMPLETED_ORDER",
        "Completed or cancelled transactions cannot be directly modified"
      );
      return;
    }

    if (req.body.adjustmentPaise !== 0 && !req.body.adjustmentReason) {
      sendError(
        res,
        400,
        "ADJUSTMENT_REASON_REQUIRED",
        "Any price adjustment from locked rates requires an explicit reason"
      );
      return;
    }

    const actualMap = new Map<string, number>(
      req.body.items.map((i: { orderItemId: string; actualGrams: number }) => [
        i.orderItemId,
        i.actualGrams,
      ])
    );

    let totalEstimatedGrams = 0;
    let totalActualGrams = 0;
    let computedMeasuredTotalPaise = 0;

    for (const item of order.items) {
      const actualGrams = actualMap.get(item.id) ?? item.estimatedGrams;
      totalEstimatedGrams += item.estimatedGrams;
      totalActualGrams += actualGrams;
      const sub = calculateAmountPaise(
        actualGrams,
        item.lockedRatePaise,
        item.material.defaultUnit as "KG" | "PIECE"
      );
      computedMeasuredTotalPaise += sub;
    }

    const finalSettlementPaise = Math.max(
      0,
      computedMeasuredTotalPaise + req.body.adjustmentPaise
    );

    // Resolve verified server-side scale OCR scan if linked (`scaleScanId`)
    let verifiedScaleOcrGrams: number | null = req.body.scaleOcrGrams ?? null;
    let verifiedScalePhotoKey: string | null = null;
    if (req.body.scaleScanId) {
      const scanRec = await prisma.aIScanRecord.findUnique({
        where: { id: req.body.scaleScanId },
      });
      if (!scanRec || scanRec.scanType !== "SCALE_OCR_CHECK") {
        sendError(res, 400, "INVALID_SCALE_SCAN", "Referenced scaleScanId is not a valid scale OCR record");
        return;
      }
      const parsedScan = scanRec.structuredResultJson as Record<string, unknown>;
      if (parsedScan?.replayFraudDetected === true) {
        sendError(
          res,
          409,
          "SCALE_PHOTO_REPLAY_BLOCKED",
          "Cannot settle order with a duplicate/replayed scale photograph — capture a fresh scale reading"
        );
        return;
      }
      if (typeof parsedScan?.scaleReadGrams === "number") {
        verifiedScaleOcrGrams = parsedScan.scaleReadGrams;
      }
      verifiedScalePhotoKey = scanRec.mediaStorageKey ?? null;
    }

    // Check scale OCR discrepancy signal (> max(150g, 3%) deviation from declared actual weight)
    const ocrDiscrepancyFlag =
      typeof verifiedScaleOcrGrams === "number" &&
      Math.abs(verifiedScaleOcrGrams - totalActualGrams) >
        Math.max(150, totalActualGrams * 0.03);

    const buyerOrg = await prisma.organization.findUnique({
      where: { ownerUserId: actor.id },
    });

    const settledOrder = await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        const actualGrams = actualMap.get(item.id) ?? item.estimatedGrams;
        const sub = calculateAmountPaise(
          actualGrams,
          item.lockedRatePaise,
          item.material.defaultUnit as "KG" | "PIECE"
        );
        await tx.orderItem.update({
          where: { id: item.id },
          data: {
            actualGrams,
            finalSubtotalPaise: sub,
          },
        });

        // Auto-stock into Buyer's InventoryBin for upward multi-tier aggregation!
        if (buyerOrg) {
          await tx.inventoryBin.upsert({
            where: {
              organizationId_materialId: {
                organizationId: buyerOrg.id,
                materialId: item.materialId,
              },
            },
            update: {
              availableGrams: { increment: actualGrams },
              weightedAvgCostPaise: item.lockedRatePaise,
            },
            create: {
              organizationId: buyerOrg.id,
              materialId: item.materialId,
              availableGrams: actualGrams,
              weightedAvgCostPaise: item.lockedRatePaise,
            },
          });
        }
      }

      await tx.weighingRecord.create({
        data: {
          orderId: order.id,
          recordedById: actor.id,
          totalEstimatedGrams,
          totalActualGrams,
          scaleOcrGrams: verifiedScaleOcrGrams,
          ocrDiscrepancyFlag,
          scalePhotoKey: verifiedScalePhotoKey,
          notes: req.body.adjustmentReason ?? null,
        },
      });

      const receiptHash = sha256Hex(
        `${order.orderNumber}:${totalActualGrams}:${finalSettlementPaise}:${Date.now()}`
      );

      await tx.handoverRecord.create({
        data: {
          orderId: order.id,
          sellerConfirmedAt: new Date(),
          buyerConfirmedAt: new Date(),
          handoverPincode: order.seller.profile?.pincode ?? "141001",
          evidenceHashSha256: receiptHash,
        },
      });

      // Automatically offset any active Morning Cash Advance (Peshgi) owed by Seller to Buyer!
      let advanceOffsetPaise = 0;
      if (req.body.autoOffsetKhataAdvance !== false) {
        const latestKhata = await tx.khataLedgerEntry.findFirst({
          where: {
            lenderId: actor.id,
            borrowerId: order.sellerId,
          },
          orderBy: { createdAt: "desc" },
        });
        if (latestKhata && latestKhata.balanceAfterPaise > 0) {
          advanceOffsetPaise = Math.min(
            latestKhata.balanceAfterPaise,
            finalSettlementPaise
          );
          if (advanceOffsetPaise > 0) {
            await tx.khataLedgerEntry.create({
              data: {
                lenderId: actor.id,
                borrowerId: order.sellerId,
                entryType: "ORDER_EARNINGS_OFFSET",
                amountPaise: advanceOffsetPaise,
                balanceAfterPaise: latestKhata.balanceAfterPaise - advanceOffsetPaise,
                relatedOrderId: order.id,
                notes: `Auto-deducted against settled order ${order.orderNumber}`,
              },
            });
            await tx.paymentRecord.create({
              data: {
                orderId: order.id,
                amountPaise: advanceOffsetPaise,
                method: "LEDGER_OFFSET",
                status: "PAID",
                recordedById: actor.id,
                paidAt: new Date(),
              },
            });
          }
        }
      }

      const netDirectPayoutPaise = Math.max(0, finalSettlementPaise - advanceOffsetPaise);
      if (netDirectPayoutPaise > 0 || advanceOffsetPaise === 0) {
        await tx.paymentRecord.create({
          data: {
            orderId: order.id,
            amountPaise: netDirectPayoutPaise,
            method: req.body.paymentMethod ?? "CASH",
            status: "PAID",
            recordedById: actor.id,
            paidAt: new Date(),
          },
        });
      }

      return tx.transactionOrder.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          finalSettlementPaise,
          priceAdjustmentReason: req.body.adjustmentReason ?? null,
          completedAt: new Date(),
        },
        include: {
          items: { include: { material: true } },
          weighingRecords: true,
          handoverRecords: true,
          paymentRecords: true,
        },
      });
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "ORDER_WEIGHED_AND_SETTLED",
      resourceType: "TransactionOrder",
      resourceId: order.id,
      outcome: "SUCCESS",
      metadata: {
        totalEstimatedGrams,
        totalActualGrams,
        finalSettlementInr: paiseToInrString(finalSettlementPaise),
        ocrDiscrepancyFlag,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { order: settledOrder });
  }
);

// GET /api/v1/inventory/bins — Dual-Sided Buyer Stock Bins Ready to Sell Upward!
marketplaceRouter.get("/inventory/bins", authenticate, async (req, res) => {
  const prisma = await getPrisma();
  const org = await prisma.organization.findUnique({
    where: { ownerUserId: req.actor!.id },
  });
  if (!org) {
    sendSuccess(res, { bins: [] });
    return;
  }
  const bins = await prisma.inventoryBin.findMany({
    where: { organizationId: org.id },
    include: { material: true },
    orderBy: { availableGrams: "desc" },
  });
  sendSuccess(res, { bins });
});

// POST /api/v1/ai/xray-estimate — Camera AI Device X-Ray Component BOM Valuation (Section 7 & 10)
marketplaceRouter.post(
  "/ai/xray-estimate",
  authenticate,
  aiRateLimiter,
  requireCapability("ai:scan"),
  validateBody(DeviceXrayScanRequestSchema),
  async (req, res) => {
    const prisma = await getPrisma();
    const actor = req.actor!;
    const { deviceQuery, observedCondition, coilTypeHint } = req.body;

    const allRefs = await prisma.deviceReferenceBOM.findMany();
    const q = deviceQuery.toLowerCase();

    const matched =
      allRefs.find((ref) => {
        if (
          coilTypeHint !== "UNKNOWN" &&
          ref.coilType &&
          ref.coilType !== coilTypeHint
        ) {
          return false;
        }
        return (
          q.includes(ref.slug.replace(/-/g, " ")) ||
          ref.modelName.toLowerCase().split(" ").some((tok) => tok.length > 2 && q.includes(tok)) ||
          q.includes(ref.deviceCategory.toLowerCase().replace(/_/g, " "))
        );
      }) ?? allRefs[0];

    if (!matched) {
      sendError(res, 404, "NO_BOM_REFERENCE", "No matching device BOM catalog found");
      return;
    }

    const components = Array.isArray(matched.componentsJson)
      ? (matched.componentsJson as Array<{
          materialSlug: string;
          label: string;
          grams: number;
          indicativeValuePaise: number;
        }>)
      : [];

    const scrapFloorPaise = components.reduce(
      (sum, comp) => sum + (comp.indicativeValuePaise ?? 0),
      0
    );

    const confidence =
      q.length >= 6 && matched.modelName.toLowerCase().includes(q.split(" ")[0] ?? "")
        ? 0.89
        : 0.72;

    const recommendedPathway =
      observedCondition === "POWERS_ON_INTACT" ||
      observedCondition === "CRACKED_SCREEN_BOOTS"
        ? "REFURBISH_OR_REPAIR"
        : observedCondition === "DEAD_BOOT_INTACT_BODY"
        ? "PARTS_HARVEST_AND_HIGH_GRADE_PCB"
        : "MATERIAL_RECOVERY_FLOOR";

    const scanRecord = await prisma.aIScanRecord.create({
      data: {
        actorId: actor.id,
        scanType: "DEVICE_XRAY",
        modelVersion: "kc-xray-bom-v1.0",
        confidence,
        requiresHumanConfirm: true,
        indicativeMinPaise: scrapFloorPaise,
        indicativeMaxPaise: matched.refurbishRangeMaxPaise,
        structuredResultJson: {
          matchedModel: matched.modelName,
          deviceCategory: matched.deviceCategory,
          coilType: matched.coilType,
          observedCondition,
          recommendedPathway,
          components,
        },
      },
    });

    sendSuccess(res, {
      scanId: scanRecord.id,
      modelVersion: scanRecord.modelVersion,
      confidence,
      requiresHumanConfirmation: true,
      priceType: "INDICATIVE_ESTIMATE",
      matchedDevice: {
        category: matched.deviceCategory,
        modelName: matched.modelName,
        typicalWeightGrams: matched.typicalTotalGrams,
        coilType: matched.coilType,
        safetyGuidance: matched.safetyNotes,
      },
      internalComponentsXray: components.map((c) => ({
        ...c,
        indicativeValueInr: paiseToInrString(c.indicativeValuePaise),
      })),
      indicativePathways: {
        scrapMaterialFloor: {
          minPaise: scrapFloorPaise,
          maxPaise: Math.round(scrapFloorPaise * 1.18),
          displayRangeInr: `₹${paiseToInrString(scrapFloorPaise)} – ₹${paiseToInrString(
            Math.round(scrapFloorPaise * 1.18)
          )}`,
        },
        partsHarvest: {
          minPaise: matched.partsHarvestMinPaise,
          maxPaise: matched.partsHarvestMaxPaise,
          displayRangeInr: `₹${paiseToInrString(
            matched.partsHarvestMinPaise
          )} – ₹${paiseToInrString(matched.partsHarvestMaxPaise)}`,
        },
        refurbishRepair: {
          minPaise: matched.refurbishRangeMinPaise,
          maxPaise: matched.refurbishRangeMaxPaise,
          displayRangeInr: `₹${paiseToInrString(
            matched.refurbishRangeMinPaise
          )} – ₹${paiseToInrString(matched.refurbishRangeMaxPaise)}`,
        },
        recommendedPathway,
      },
      honestyDisclaimer:
        "Indicative AI estimate based on reference internal component weights. Final settlement depends on physical inspection, buyer offer, and verified scale weighing.",
    });
  }
);
