import crypto from "crypto";
import { Router } from "express";
import {
  CreateDismantlingSchema,
  CreateKhataAdvanceSchema,
  CreatePurchaseOfferSchema,
  SellBinUpwardSchema,
  SupplyChainTier,
  calculateAmountPaise,
  paiseToInrString,
} from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import {
  authenticate,
  requireCapability,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";

export const supplyChainRouter = Router();

const TIER_HIERARCHY_RANK: Record<SupplyChainTier, number> = {
  TIER_0_GENERATOR: 0,
  TIER_1_LOCAL_COLLECTOR: 1,
  TIER_2_AREA_SHOP: 2,
  TIER_3_WHOLESALE_AGGREGATOR: 3,
  TIER_4_AUTHORISED_RECYCLER: 4,
  PLATFORM_STAFF: 99,
};

// ============================================================================
// 1. OPEN MULTI-BUYER BIDDING WORKFLOW (/listings/open, /offers)
// ============================================================================

// GET /api/v1/listings/open — Broadcast Scrap Board (Scrubs private street address!)
supplyChainRouter.get("/listings/open", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();

  const listings = await prisma.materialListing.findMany({
    where: { status: "LISTED" },
    include: {
      owner: {
        select: {
          id: true,
          platformCode: true,
          tier: true,
          verificationLevel: true,
          profile: { select: { displayName: true } },
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
              defaultUnit: true,
              isRegulatedHazardous: true,
            },
          },
        },
      },
      offers: {
        where: { status: { in: ["OPEN", "ACCEPTED"] } },
        orderBy: { offeredTotalPaise: "desc" },
        include: {
          buyer: {
            select: {
              id: true,
              platformCode: true,
              tier: true,
              verificationLevel: true,
              profile: { select: { displayName: true } },
              organization: { select: { businessName: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 40,
  });

  // Section 5.2 Privacy Rule: NEVER leak pickupAddressPrivate on open unaccepted broadcast listings!
  const sanitized = listings.map((l) => ({
    id: l.id,
    ownerId: l.ownerId,
    ownerDisplayName: l.owner.profile?.displayName ?? l.owner.platformCode,
    ownerPlatformCode: l.owner.platformCode,
    sellerTier: l.sellerTier,
    title: l.title,
    pickupCity: l.pickupCity,
    pickupPincode: l.pickupPincode,
    // Only the listing owner themselves sees their private street address prior to acceptance
    ...(l.ownerId === actor.id || actor.role === "ADMIN"
      ? { pickupAddressPrivate: l.pickupAddressPrivate }
      : {}),
    preferredMode: l.preferredMode,
    indicativeEstimatePaise: l.indicativeEstimatePaise,
    status: l.status,
    createdAt: l.createdAt,
    items: l.items,
    offers: l.offers,
  }));

  sendSuccess(res, { listings: sanitized });
});

// POST /api/v1/listings/:listingId/offers — Submit Versioned Competing Purchase Offer
supplyChainRouter.post(
  "/listings/:listingId/offers",
  authenticate,
  requireCapability("offer:create"),
  validateBody(CreatePurchaseOfferSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const listingId = String(req.params.listingId);
    const { offeredTotalPaise, notes } = req.body as {
      offeredTotalPaise: number;
      notes?: string;
    };

    const listing = await prisma.materialListing.findUnique({
      where: { id: listingId },
      include: { items: { include: { material: true } } },
    });

    if (!listing) {
      sendError(res, 404, "LISTING_NOT_FOUND", "Material listing does not exist");
      return;
    }
    if (listing.status !== "LISTED") {
      sendError(
        res,
        400,
        "LISTING_NOT_OPEN",
        `Listing is currently ${listing.status} and cannot receive new offers`
      );
      return;
    }
    if (listing.ownerId === actor.id) {
      sendError(res, 400, "SELF_OFFER_FORBIDDEN", "Cannot submit an offer on your own listing");
      return;
    }

    // Versioned offer preservation: supersede previous OPEN offer by this buyer without deleting history
    const priorOffer = await prisma.purchaseOffer.findFirst({
      where: { listingId: listing.id, buyerId: actor.id },
      orderBy: { version: "desc" },
    });

    const nextVersion = priorOffer ? priorOffer.version + 1 : 1;

    const offer = await prisma.$transaction(async (tx) => {
      if (priorOffer && priorOffer.status === "OPEN") {
        await tx.purchaseOffer.update({
          where: { id: priorOffer.id },
          data: { status: "SUPERSEDED" },
        });
      }
      return tx.purchaseOffer.create({
        data: {
          listingId: listing.id,
          buyerId: actor.id,
          priceType: "STOREFRONT_RATE_OR_OFFER",
          offeredTotalPaise,
          version: nextVersion,
          notes: notes ?? null,
          status: "OPEN",
        },
      });
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "PURCHASE_OFFER_SUBMITTED",
      resourceType: "PurchaseOffer",
      resourceId: offer.id,
      outcome: "SUCCESS",
      metadata: {
        listingId: listing.id,
        version: nextVersion,
        offeredInr: paiseToInrString(offeredTotalPaise),
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { offer }, 201);
  }
);

// POST /api/v1/offers/:offerId/accept — Listing Owner Accepts Offer & Creates Locked Order
supplyChainRouter.post("/offers/:offerId/accept", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const offerId = String(req.params.offerId);

  const offer = await prisma.purchaseOffer.findUnique({
    where: { id: offerId },
    include: {
      listing: { include: { items: { include: { material: true } } } },
      buyer: { include: { organization: { include: { storefront: true } } } },
    },
  });

  if (!offer) {
    sendError(res, 404, "OFFER_NOT_FOUND", "Offer not found");
    return;
  }

  // Strict BOLA check: ONLY the listing owner can accept an offer on their listing!
  if (offer.listing.ownerId !== actor.id) {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "BOLA_OFFER_ACCEPT_DENIED",
      resourceType: "PurchaseOffer",
      resourceId: offer.id,
      outcome: "DENIED",
      reason: "Non-owner attempted to accept purchase offer",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(res, 403, "FORBIDDEN", "Only the listing owner can accept an offer");
    return;
  }

  if (offer.status !== "OPEN" || offer.listing.status !== "LISTED") {
    sendError(res, 400, "OFFER_NO_LONGER_OPEN", "Offer or listing is no longer open");
    return;
  }

  const totalEstGrams = Math.max(
    1,
    offer.listing.items.reduce((s, i) => s + i.estimatedGrams, 0)
  );
  const blendedRatePerKgPaise = Math.round(
    (offer.offeredTotalPaise * 1000) / totalEstGrams
  );

  const createdOrder = await prisma.$transaction(async (tx) => {
    await tx.purchaseOffer.update({
      where: { id: offer.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });

    await tx.purchaseOffer.updateMany({
      where: {
        listingId: offer.listingId,
        id: { not: offer.id },
        status: "OPEN",
      },
      data: { status: "REJECTED" },
    });

    await tx.materialListing.update({
      where: { id: offer.listingId },
      data: { status: "ACCEPTED" },
    });

    const orderNumber = `KC-ORD-${new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "")}-${crypto.randomInt(1000, 9999)}`;

    return tx.transactionOrder.create({
      data: {
        orderNumber,
        listingId: offer.listingId,
        sellerId: actor.id,
        buyerId: offer.buyerId,
        storefrontId: offer.buyer.organization?.storefront?.id ?? null,
        sellerTier: offer.listing.sellerTier,
        buyerTier: offer.buyer.tier,
        fulfillmentMode: offer.listing.preferredMode,
        status: "ACCEPTED",
        indicativeTotalPaise: offer.listing.indicativeEstimatePaise,
        agreedTotalPaise: offer.offeredTotalPaise,
        qrTraceToken: `KC-TRACE-${crypto.randomBytes(8).toString("hex").toUpperCase()}`,
        items: {
          create: offer.listing.items.map((item) => ({
            materialId: item.materialId,
            lockedRatePaise: blendedRatePerKgPaise,
            estimatedGrams: item.estimatedGrams,
            agreedSubtotalPaise: calculateAmountPaise(
              item.estimatedGrams,
              blendedRatePerKgPaise,
              item.material.defaultUnit as "KG" | "PIECE"
            ),
          })),
        },
      },
      include: { items: { include: { material: true } } },
    });
  });

  await recordAuditEvent({
    actorId: actor.id,
    actorRole: actor.role,
    action: "PURCHASE_OFFER_ACCEPTED",
    resourceType: "TransactionOrder",
    resourceId: createdOrder.id,
    outcome: "SUCCESS",
    metadata: {
      offerId: offer.id,
      agreedInr: paiseToInrString(offer.offeredTotalPaise),
    },
    correlationId: req.correlationId,
    ipAddress: req.ip,
  });

  sendSuccess(res, { order: createdOrder }, 201);
});

// ============================================================================
// 2. APPLIANCE DISMANTLING SPLITTER & UPWARD MULTI-TIER BATCH LINEAGE
// ============================================================================

// GET /api/v1/inventory/dismantle — List Own Organization's Dismantling Records
supplyChainRouter.get("/inventory/dismantle", authenticate, async (req, res) => {
  const prisma = await getPrisma();
  const org = await prisma.organization.findUnique({
    where: { ownerUserId: req.actor!.id },
  });
  if (!org) {
    sendSuccess(res, { records: [] });
    return;
  }
  const records = await prisma.dismantlingRecord.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  sendSuccess(res, { records });
});

// POST /api/v1/inventory/dismantle — Split Appliance/Lot into Pure Material Stock Bins
supplyChainRouter.post(
  "/inventory/dismantle",
  authenticate,
  requireCapability("storefront:manage:own"),
  validateBody(CreateDismantlingSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const body = req.body as {
      inputDescription: string;
      inputGrams: number;
      residueGrams: number;
      outputs: Array<{ materialSlug: string; outputGrams: number }>;
    };

    const org = await prisma.organization.findUnique({
      where: { ownerUserId: actor.id },
    });
    if (!org) {
      sendError(res, 403, "ORGANIZATION_REQUIRED", "Only Collector/Business/Recycler accounts hold stock bins");
      return;
    }

    // Physics Mass-Balance Guard: output streams + residue MUST NOT exceed input weight!
    const totalOutGrams =
      body.outputs.reduce((sum, o) => sum + o.outputGrams, 0) + body.residueGrams;

    if (totalOutGrams > body.inputGrams) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "MASS_BALANCE_VIOLATION_BLOCKED",
        resourceType: "DismantlingRecord",
        outcome: "DENIED",
        reason: `Output mass (${totalOutGrams}g) exceeded input mass (${body.inputGrams}g)`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        400,
        "MASS_CONSERVATION_VIOLATED",
        `Recovered output mass (${(totalOutGrams / 1000).toFixed(
          2
        )} kg) cannot exceed input weight (${(body.inputGrams / 1000).toFixed(2)} kg)`
      );
      return;
    }

    const slugs = body.outputs.map((o) => o.materialSlug);
    const materials = await prisma.materialCategory.findMany({
      where: { slug: { in: slugs } },
    });
    const matMap = new Map(materials.map((m) => [m.slug, m]));
    if (matMap.size !== new Set(slugs).size) {
      sendError(res, 400, "UNKNOWN_MATERIAL", "One or more output material slugs do not exist");
      return;
    }

    const record = await prisma.$transaction(async (tx) => {
      for (const out of body.outputs) {
        const mat = matMap.get(out.materialSlug)!;
        await tx.inventoryBin.upsert({
          where: {
            organizationId_materialId: {
              organizationId: org.id,
              materialId: mat.id,
            },
          },
          update: {
            availableGrams: { increment: out.outputGrams },
          },
          create: {
            organizationId: org.id,
            materialId: mat.id,
            availableGrams: out.outputGrams,
            weightedAvgCostPaise: 0,
          },
        });
      }

      return tx.dismantlingRecord.create({
        data: {
          organizationId: org.id,
          inputDescription: body.inputDescription,
          inputGrams: body.inputGrams,
          outputsJson: body.outputs,
          residueGrams: body.residueGrams,
        },
      });
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "DISMANTLING_BATCH_RECORDED",
      resourceType: "DismantlingRecord",
      resourceId: record.id,
      outcome: "SUCCESS",
      metadata: {
        inputGrams: body.inputGrams,
        recoveredStreams: body.outputs.length,
        residueGrams: body.residueGrams,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { record }, 201);
  }
);

// POST /api/v1/inventory/bins/:binId/sell-upward — Upward Hierarchy Sale + Auto BatchLineage
supplyChainRouter.post(
  "/inventory/bins/:binId/sell-upward",
  authenticate,
  requireCapability("storefront:manage:own"),
  validateBody(SellBinUpwardSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const binId = String(req.params.binId);
    const { sellGrams, targetStorefrontId, fulfillmentMode } = req.body as {
      sellGrams: number;
      targetStorefrontId: string;
      fulfillmentMode: "BUYER_PICKUP" | "SELLER_DROPOFF";
    };

    const bin = await prisma.inventoryBin.findUnique({
      where: { id: binId },
      include: { organization: true, material: true },
    });

    if (!bin) {
      sendError(res, 404, "BIN_NOT_FOUND", "Inventory bin not found");
      return;
    }

    // Strict BOLA check on bin ownership
    if (bin.organization.ownerUserId !== actor.id) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "BOLA_INVENTORY_BIN_DENIED",
        resourceType: "InventoryBin",
        resourceId: bin.id,
        outcome: "DENIED",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(res, 403, "FORBIDDEN", "Not authorised to sell from another shop's inventory bin");
      return;
    }

    if (bin.availableGrams < sellGrams) {
      sendError(
        res,
        400,
        "INSUFFICIENT_BIN_STOCK",
        `Bin only has ${(bin.availableGrams / 1000).toFixed(2)} kg available`
      );
      return;
    }

    const buyerStorefront = await prisma.storefront.findUnique({
      where: { id: targetStorefrontId },
      include: {
        organization: true,
        rateItems: {
          where: { isActive: true, materialId: bin.materialId },
        },
      },
    });

    if (!buyerStorefront) {
      sendError(res, 404, "BUYER_STOREFRONT_NOT_FOUND", "Target buyer storefront not found");
      return;
    }

    const sellerRank = TIER_HIERARCHY_RANK[actor.tier];
    const buyerRank =
      TIER_HIERARCHY_RANK[buyerStorefront.organization.tier as SupplyChainTier];

    if (buyerRank <= sellerRank) {
      sendError(
        res,
        400,
        "UPWARD_HIERARCHY_REQUIRED",
        `Upward batch sales must target a higher tier than ${actor.tier}`
      );
      return;
    }

    const rateItem = buyerStorefront.rateItems[0];
    if (!rateItem) {
      sendError(
        res,
        400,
        "MATERIAL_NOT_ACCEPTED_BY_BUYER",
        `${buyerStorefront.shopTitle} does not currently publish an active rate for ${bin.material.nameEn}`
      );
      return;
    }

    const unitRatePaise =
      fulfillmentMode === "SELLER_DROPOFF"
        ? rateItem.dropoffRatePaise
        : rateItem.pickupRatePaise;

    const agreedTotalPaise = calculateAmountPaise(
      sellGrams,
      unitRatePaise,
      bin.material.defaultUnit as "KG" | "PIECE"
    );
    const costBasisPaise = calculateAmountPaise(
      sellGrams,
      bin.weightedAvgCostPaise,
      bin.material.defaultUnit as "KG" | "PIECE"
    );

    // Find recent completed inbound orders containing this material to link in BatchLineage!
    const sourceInboundOrders = await prisma.transactionOrder.findMany({
      where: {
        buyerId: actor.id,
        status: "COMPLETED",
        items: { some: { materialId: bin.materialId } },
      },
      include: { items: true },
      orderBy: { completedAt: "desc" },
      take: 20,
    });

    const outcome = await prisma.$transaction(async (tx) => {
      await tx.inventoryBin.update({
        where: { id: bin.id },
        data: { availableGrams: { decrement: sellGrams } },
      });

      const orderNumber = `KC-UPW-${new Date()
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "")}-${crypto.randomInt(1000, 9999)}`;

      const parentOrder = await tx.transactionOrder.create({
        data: {
          orderNumber,
          sellerId: actor.id,
          buyerId: buyerStorefront.organization.ownerUserId,
          storefrontId: buyerStorefront.id,
          sellerTier: actor.tier,
          buyerTier: buyerStorefront.organization.tier,
          fulfillmentMode,
          status: "REQUESTED",
          indicativeTotalPaise: agreedTotalPaise,
          agreedTotalPaise,
          qrTraceToken: `KC-TRACE-${crypto.randomBytes(8).toString("hex").toUpperCase()}`,
          items: {
            create: [
              {
                materialId: bin.materialId,
                lockedRatePaise: unitRatePaise,
                estimatedGrams: sellGrams,
                agreedSubtotalPaise: agreedTotalPaise,
              },
            ],
          },
        },
        include: { items: { include: { material: true } }, storefront: true },
      });

      // Automatically link child source transactions up to `sellGrams` for end-to-end genealogy!
      let remainingToAttribute = sellGrams;
      const lineageLinks = [];
      for (const childOrd of sourceInboundOrders) {
        if (remainingToAttribute <= 0) break;
        const matGramsInChild = childOrd.items
          .filter((it) => it.materialId === bin.materialId)
          .reduce((s, it) => s + (it.actualGrams ?? it.estimatedGrams), 0);

        if (matGramsInChild <= 0) continue;
        const attributed = Math.min(remainingToAttribute, matGramsInChild);
        remainingToAttribute -= attributed;

        const createdLink = await tx.batchLineage.create({
          data: {
            parentBulkOrderId: parentOrder.id,
            childSourceOrderId: childOrd.id,
            attributedGrams: attributed,
          },
        });
        lineageLinks.push(createdLink);
      }

      return { parentOrder, lineageLinksCount: lineageLinks.length };
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "UPWARD_BATCH_SALE_CREATED",
      resourceType: "TransactionOrder",
      resourceId: outcome.parentOrder.id,
      outcome: "SUCCESS",
      metadata: {
        fromTier: actor.tier,
        toTier: buyerStorefront.organization.tier,
        sellGrams,
        agreedInr: paiseToInrString(agreedTotalPaise),
        lineageLinksCount: outcome.lineageLinksCount,
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(
      res,
      {
        order: outcome.parentOrder,
        lineageLinksCreated: outcome.lineageLinksCount,
        economics: {
          costBasisPaise,
          expectedRevenuePaise: agreedTotalPaise,
          projectedGrossMarginPaise: agreedTotalPaise - costBasisPaise,
        },
      },
      201
    );
  }
);

// ============================================================================
// 3. KHATA CASH ADVANCES (PESHGI) & RUNNING BALANCE LEDGER
// ============================================================================

// GET /api/v1/khata — Strictly Scoped to Participant Lender/Borrower or Admin
supplyChainRouter.get("/khata", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();

  const entries = await prisma.khataLedgerEntry.findMany({
    where:
      actor.role === "ADMIN"
        ? {}
        : {
            OR: [{ lenderId: actor.id }, { borrowerId: actor.id }],
          },
    include: {
      lender: {
        select: {
          id: true,
          platformCode: true,
          tier: true,
          profile: { select: { displayName: true } },
        },
      },
      borrower: {
        select: {
          id: true,
          platformCode: true,
          tier: true,
          profile: { select: { displayName: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  sendSuccess(res, { entries });
});

// POST /api/v1/khata/entries — Record Morning Cash Advance (Peshgi) or Cash Repayment
supplyChainRouter.post(
  "/khata/entries",
  authenticate,
  requireCapability("storefront:manage:own"),
  validateBody(CreateKhataAdvanceSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const { borrowerPlatformCode, amountPaise, entryType, notes } = req.body as {
      borrowerPlatformCode: string;
      amountPaise: number;
      entryType: "CASH_ADVANCE_GIVEN" | "CASH_REPAYMENT";
      notes?: string;
    };

    const borrower = await prisma.user.findUnique({
      where: { platformCode: borrowerPlatformCode.toUpperCase().trim() },
    });

    if (!borrower) {
      sendError(res, 404, "BORROWER_NOT_FOUND", "No member matched that Platform ID");
      return;
    }
    if (borrower.id === actor.id) {
      sendError(res, 400, "SELF_ADVANCE_FORBIDDEN", "Cannot issue a cash advance to yourself");
      return;
    }

    const latestEntry = await prisma.khataLedgerEntry.findFirst({
      where: { lenderId: actor.id, borrowerId: borrower.id },
      orderBy: { createdAt: "desc" },
    });

    const priorBalance = latestEntry?.balanceAfterPaise ?? 0;
    const balanceAfterPaise =
      entryType === "CASH_ADVANCE_GIVEN"
        ? priorBalance + amountPaise
        : Math.max(0, priorBalance - amountPaise);

    const entry = await prisma.khataLedgerEntry.create({
      data: {
        lenderId: actor.id,
        borrowerId: borrower.id,
        entryType,
        amountPaise,
        balanceAfterPaise,
        notes: notes ?? null,
      },
      include: {
        lender: { select: { platformCode: true, profile: { select: { displayName: true } } } },
        borrower: { select: { platformCode: true, profile: { select: { displayName: true } } } },
      },
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "KHATA_LEDGER_ENTRY_RECORDED",
      resourceType: "KhataLedgerEntry",
      resourceId: entry.id,
      outcome: "SUCCESS",
      metadata: {
        borrowerPlatformCode: borrower.platformCode,
        entryType,
        amountInr: paiseToInrString(amountPaise),
        balanceAfterInr: paiseToInrString(balanceAfterPaise),
      },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { entry }, 201);
  }
);
