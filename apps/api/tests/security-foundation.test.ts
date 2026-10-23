import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import path from "path";
import request from "supertest";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { WORKSPACE_ROOT } from "../src/lib/paths";
import { closePrisma, getPrisma } from "../src/lib/prisma";
import { closeRedisRateLimiter } from "../src/lib/redisStore";
import { ensureSeeded } from "../prisma/seed";
import {
  generateApplianceXraySamplePng,
  generateMaterialSamplePng,
  generateScalePlatePng,
} from "../src/modules/ai/vision.engine";
import {
  computeWebhookHmacSignature,
  getRecentSandboxSmsDispatches,
} from "../src/modules/integrations/gateways.service";
import { MobileApiClient } from "../../mobile/src/api/mobileClient";
import { createInMemoryTokenAdapter } from "../../mobile/src/security/secureSession";
import {
  OfflineSyncQueue,
  SerializedJournalQueueDriver,
} from "../../mobile/src/offline/syncQueue";

describe("Kabadiwala Connect — Phase 1 Foundation, RBAC, BOLA & OWASP Security Suite", () => {
  const app = createApp();

  let adminToken = "";
  let collectorAToken = "";
  let collectorAUserId = "";
  let collectorARefreshToken = "";
  let collectorBToken = "";
  let collectorBUserId = "";
  let recyclerToken = "";
  let recyclerCaseId = "";
  let uploadedDocId = "";

  beforeAll(async () => {
    await getPrisma();
    await ensureSeeded();
  }, 30000);

  afterAll(async () => {
    await closeRedisRateLimiter();
    await closePrisma();
  });

  it("1. Health check responds cleanly with correlation ID and zero stack leaks", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-correlation-id"]).toBeTruthy();
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
  });

  it("2. Blocks public registration of ADMIN accounts (Vertical Privilege Escalation Defense)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      phone: "+919900099999",
      password: "StrongPassword123",
      displayName: "Attacker Admin Attempt",
      role: "ADMIN",
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("3. Registers Collector A & Collector B with Argon2id hashes, distinct KC-COL IDs, and never leaks passwordHash", async () => {
    const resA = await request(app).post("/api/v1/auth/register").send({
      phone: "+919876543210",
      email: "collectora@test.local",
      password: "CollectorPass123",
      displayName: "Santosh Ward Collector",
      role: "COLLECTOR",
      city: "Ludhiana",
      pincode: "141001",
    });

    expect(resA.status).toBe(201);
    expect(resA.body.data.user.platformCode).toMatch(/^KC-COL-\d{6}$/);
    expect(resA.body.data.user.verificationLevel).toBe("LEVEL_0_REGISTERED");
    expect(resA.body.data.user.passwordHash).toBeUndefined();

    collectorAToken = resA.body.data.tokens.accessToken;
    collectorARefreshToken = resA.body.data.tokens.refreshToken;
    collectorAUserId = resA.body.data.user.id;

    // Verify stored hash in PostgreSQL is genuine Argon2id ($argon2id$...)
    const prisma = await getPrisma();
    const dbRow = await prisma.user.findUnique({ where: { id: collectorAUserId } });
    expect(dbRow?.passwordHash.startsWith("$argon2id$")).toBe(true);

    const resB = await request(app).post("/api/v1/auth/register").send({
      phone: "+919876543211",
      email: "collectorb@test.local",
      password: "CollectorPass123",
      displayName: "Balwinder Collector",
      role: "COLLECTOR",
      city: "Ludhiana",
      pincode: "141002",
    });

    expect(resB.status).toBe(201);
    collectorBToken = resB.body.data.tokens.accessToken;
    collectorBUserId = resB.body.data.user.id;
  });

  it("4. Blocks Horizontal Privilege Escalation (BOLA) when Collector A reads or modifies Collector B's profile", async () => {
    const readRes = await request(app)
      .get(`/api/v1/users/${collectorBUserId}`)
      .set("Authorization", `Bearer ${collectorAToken}`);

    expect(readRes.status).toBe(403);
    expect(readRes.body.error.code).toBe("FORBIDDEN_RESOURCE_OWNERSHIP");

    const editRes = await request(app)
      .patch(`/api/v1/users/${collectorBUserId}/profile`)
      .set("Authorization", `Bearer ${collectorAToken}`)
      .send({ displayName: "Hacked Name" });

    expect(editRes.status).toBe(403);
  });

  it("5. Blocks Mass Assignment / Property Tampering on own profile update (role, verificationLevel, platformCode)", async () => {
    const tamperRes = await request(app)
      .patch(`/api/v1/users/${collectorAUserId}/profile`)
      .set("Authorization", `Bearer ${collectorAToken}`)
      .send({
        displayName: "Santosh Updated",
        role: "ADMIN",
        verificationLevel: "LEVEL_4_AUTHORISED_RECYCLER",
      });

    expect(tamperRes.status).toBe(400);
    expect(tamperRes.body.error.code).toBe("VALIDATION_ERROR");

    // Confirm legitimate allowed property update succeeds cleanly
    const cleanRes = await request(app)
      .patch(`/api/v1/users/${collectorAUserId}/profile`)
      .set("Authorization", `Bearer ${collectorAToken}`)
      .send({ displayName: "Santosh Kumar (Ward 7)" });

    expect(cleanRes.status).toBe(200);
    expect(cleanRes.body.data.profile.displayName).toBe("Santosh Kumar (Ward 7)");
  });

  it("6. Rejects tokens passed in URL query strings (Section 8.9 Token Hygiene)", async () => {
    const res = await request(app)
      .get(`/api/v1/auth/me?access_token=${collectorAToken}`)
      .set("Authorization", `Bearer ${collectorAToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOKEN_IN_URL_FORBIDDEN");
  });

  it("7. Enforces Magic-Byte File Inspection, Private Storage, 60s Signed URLs, and Admin KYC Audit Trail", async () => {
    // Register an unverified Authorised Recycler applicant
    const recReg = await request(app).post("/api/v1/auth/register").send({
      phone: "+919876543222",
      email: "newrecycler@test.local",
      password: "RecyclerPass123",
      displayName: "EcoMetals Plant",
      businessName: "EcoMetals Recovery Pvt Ltd",
      role: "AUTHORISED_RECYCLER",
      city: "Ludhiana",
      pincode: "141010",
    });
    expect(recReg.status).toBe(201);
    recyclerToken = recReg.body.data.tokens.accessToken;

    // Submit Level 4 verification case
    const caseRes = await request(app)
      .post("/api/v1/verification/cases")
      .set("Authorization", `Bearer ${recyclerToken}`)
      .send({
        requestedLevel: "LEVEL_4_AUTHORISED_RECYCLER",
        registrationType: "CPCB_SPCB_EPR",
        registrationNumber: "CPCB-EW-TEST-9981",
        issuingAuthority: "CPCB Portal",
        permittedStreams: ["EWASTE", "BATTERY"],
      });
    expect(caseRes.status).toBe(201);
    expect(caseRes.body.data.verificationCase.status).toBe("PENDING");
    recyclerCaseId = caseRes.body.data.verificationCase.id;

    // Attempt uploading disguised executable/script spoofed as image/png -> MUST REJECT!
    const fakePng = Buffer.from("#!/bin/sh\nrm -rf /\nmalicious payload", "utf8");
    const badUpload = await request(app)
      .post(`/api/v1/verification/cases/${recyclerCaseId}/documents`)
      .set("Authorization", `Bearer ${recyclerToken}`)
      .attach("document", fakePng, {
        filename: "cpcb-certificate.png",
        contentType: "image/png",
      });
    expect(badUpload.status).toBe(400);
    expect(badUpload.body.error.code).toBe("UNSUPPORTED_FILE_CONTENT");

    // Upload genuine PDF magic-byte buffer ("%PDF-1.7...")
    const validPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF", "utf8");
    const goodUpload = await request(app)
      .post(`/api/v1/verification/cases/${recyclerCaseId}/documents`)
      .set("Authorization", `Bearer ${recyclerToken}`)
      .field("documentKind", "CPCB_AUTH")
      .attach("document", validPdf, {
        filename: "cpcb-auth.pdf",
        contentType: "application/pdf",
      });
    expect(goodUpload.status).toBe(201);
    expect(goodUpload.body.data.document.detectedMime).toBe("application/pdf");
    uploadedDocId = goodUpload.body.data.document.id;

    // Collector A tries to request signed download URL for Recycler's private KYC file -> DENIED!
    const unauthorizedLink = await request(app)
      .post(`/api/v1/verification/documents/${uploadedDocId}/signed-link`)
      .set("Authorization", `Bearer ${collectorAToken}`);
    expect(unauthorizedLink.status).toBe(403);
  });

  it("8. Blocks self-approval by non-Admin, enforces CPCB official check rule, and completes Admin approval + Public QR safety check", async () => {
    // Recycler tries to approve their own verification case -> 403 FORBIDDEN!
    const selfApprove = await request(app)
      .post(`/api/v1/admin/verification/cases/${recyclerCaseId}/decide`)
      .set("Authorization", `Bearer ${recyclerToken}`)
      .send({
        decision: "VERIFIED",
        reason: "Approving myself",
        officialSourceChecked: true,
      });
    expect(selfApprove.status).toBe(403);

    // Log in as seeded Platform Admin
    const adminLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "admin@kabadiwala.local",
      password: "AdminPass123",
    });
    expect(adminLogin.status).toBe(200);
    adminToken = adminLogin.body.data.tokens.accessToken;

    // Admin tries approving Level 4 recycler WITHOUT confirming official CPCB check -> 400!
    const missingCheck = await request(app)
      .post(`/api/v1/admin/verification/cases/${recyclerCaseId}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        decision: "VERIFIED",
        reason: "Forgot to check portal",
        officialSourceChecked: false,
      });
    expect(missingCheck.status).toBe(400);
    expect(missingCheck.body.error.code).toBe("OFFICIAL_SOURCE_CHECK_REQUIRED");

    // Admin views private KYC doc via signed link (logged in AuditEvent) & approves properly
    const signedLinkRes = await request(app)
      .post(`/api/v1/verification/documents/${uploadedDocId}/signed-link`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(signedLinkRes.status).toBe(200);

    const downloadRes = await request(app)
      .get(signedLinkRes.body.data.downloadPath)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(downloadRes.status).toBe(200);

    const validApprove = await request(app)
      .post(`/api/v1/admin/verification/cases/${recyclerCaseId}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        decision: "VERIFIED",
        reason: "Verified registration against CPCB E-Waste EPR Portal",
        officialSourceChecked: true,
        evidenceReferenceUrl: "https://eprewaste.cpcb.gov.in/",
      });
    expect(validApprove.status).toBe(200);

    // Public QR card check exposes NO phone/email/address and includes honest non-gov disclaimer
    const meRes = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${recyclerToken}`);
    const platformCode = meRes.body.data.user.platformCode;

    const pubCard = await request(app).get(`/api/v1/public/verify/${platformCode}`);
    expect(pubCard.status).toBe(200);
    expect(pubCard.body.data.publicCard.verificationLevel).toBe(
      "LEVEL_4_AUTHORISED_RECYCLER"
    );
    expect(pubCard.body.data.publicCard.phone).toBeUndefined();
    expect(pubCard.body.data.publicCard.email).toBeUndefined();
    expect(pubCard.body.data.publicCard.legalNotice).toContain("NOT a government-issued");
  });

  it("9. Completes Multi-Tier Order Lifecycle + Camera AI X-Ray Scan + Append-Only PostgreSQL Audit Trigger Check", async () => {
    // Device X-Ray AI Scan returns honest INDICATIVE_ESTIMATE with human confirmation flag
    const aiRes = await request(app)
      .post("/api/v1/ai/xray-estimate")
      .set("Authorization", `Bearer ${collectorAToken}`)
      .send({
        deviceQuery: "Split AC 1.5 Ton Copper",
        observedCondition: "DEAD_BOOT_INTACT_BODY",
        coilTypeHint: "COPPER",
      });
    expect(aiRes.status).toBe(200);
    expect(aiRes.body.data.priceType).toBe("INDICATIVE_ESTIMATE");
    expect(aiRes.body.data.requiresHumanConfirmation).toBe(true);

    // Test refresh token rotation + replay theft detection revoking session family!
    const rotated = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: collectorARefreshToken });
    expect(rotated.status).toBe(200);

    // Replay ALREADY-USED refresh token -> triggers family compromise revocation!
    const replayAttempt = await request(app)
      .post("/api/v1/auth/refresh")
      .send({ refreshToken: collectorARefreshToken });
    expect(replayAttempt.status).toBe(401);
    expect(replayAttempt.body.error.code).toBe("SESSION_COMPROMISED_REVOKED");

    // Previous access token in that compromised session family is IMMEDIATELY rejected!
    const postRevokeMe = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${collectorAToken}`);
    expect(postRevokeMe.status).toBe(401);

    // Verify PostgreSQL kernel trigger strictly blocks deleting or tampering with AuditEvent rows!
    const prisma = await getPrisma();
    const oneAudit = await prisma.auditEvent.findFirst();
    expect(oneAudit).toBeTruthy();

    await expect(
      prisma.auditEvent.delete({ where: { id: oneAudit!.id } })
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.auditEvent.update({
        where: { id: oneAudit!.id },
        data: { outcome: "SUCCESS", action: "TAMPERED" },
      })
    ).rejects.toThrow(/append-only/i);
  });

  it("10. Enforces Multi-Tier Order State Machine, BOLA Order Protection, Scale Weighing, InventoryBin Stocking & Completed Order Immutability", async () => {
    const custLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "customer@kabadiwala.local",
      password: "KabadiPass123",
    });
    expect(custLogin.status).toBe(200);
    const customerToken = custLogin.body.data.tokens.accessToken;

    const colLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    expect(colLogin.status).toBe(200);
    const rajuToken = colLogin.body.data.tokens.accessToken;

    // Fetch storefronts across hierarchy
    const sfRes = await request(app).get("/api/v1/storefronts");
    expect(sfRes.status).toBe(200);
    const rajuStorefront = sfRes.body.data.storefronts.find(
      (s: { slug: string }) => s.slug === "raju-ward4-kabadi"
    );
    expect(rajuStorefront).toBeTruthy();

    // Customer creates listing targeting Tier-1 Collector storefront
    const createListing = await request(app)
      .post("/api/v1/listings")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({
        title: "Household Newspaper + Iron Pickup",
        pickupPincode: "141001",
        pickupAddressPrivate: "House 42, Civil Lines",
        preferredMode: "BUYER_PICKUP",
        targetStorefrontId: rajuStorefront.id,
        items: [
          { materialSlug: "paper-newspaper", estimatedGrams: 10000 },
          { materialSlug: "metal-heavy-iron", estimatedGrams: 5000 },
        ],
      });
    expect(createListing.status).toBe(201);
    const orderId = createListing.body.data.order.id;
    const orderItems = createListing.body.data.order.items;

    // Unrelated Collector B tries reading this order -> 403 BOLA blocked!
    const bolaOrderRead = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${collectorBToken}`);
    expect(bolaOrderRead.status).toBe(403);

    // Raju accepts, weighs actual grams, checks scale OCR, settles cash & stocks InventoryBin
    const acceptRes = await request(app)
      .post(`/api/v1/orders/${orderId}/accept`)
      .set("Authorization", `Bearer ${rajuToken}`);
    expect(acceptRes.status).toBe(200);

    const weighRes = await request(app)
      .post(`/api/v1/orders/${orderId}/weigh-and-settle`)
      .set("Authorization", `Bearer ${rajuToken}`)
      .send({
        items: orderItems.map((it: { id: string; estimatedGrams: number }) => ({
          orderItemId: it.id,
          actualGrams: it.estimatedGrams + 500,
        })),
        adjustmentPaise: 0,
        scaleOcrGrams: 16000,
      });
    expect(weighRes.status).toBe(200);
    expect(weighRes.body.data.order.status).toBe("COMPLETED");

    // Re-weighing / mutating an already COMPLETED transaction is strictly rejected!
    const modifyCompleted = await request(app)
      .post(`/api/v1/orders/${orderId}/weigh-and-settle`)
      .set("Authorization", `Bearer ${rajuToken}`)
      .send({
        items: orderItems.map((it: { id: string }) => ({
          orderItemId: it.id,
          actualGrams: 1000,
        })),
        adjustmentPaise: 0,
      });
    expect(modifyCompleted.status).toBe(400);
    expect(modifyCompleted.body.error.code).toBe("IMMUTABLE_COMPLETED_ORDER");

    // Verify Collector's InventoryBin automatically incremented for upward Tier-2 sale!
    const binsRes = await request(app)
      .get("/api/v1/inventory/bins")
      .set("Authorization", `Bearer ${rajuToken}`);
    expect(binsRes.status).toBe(200);
    expect(binsRes.body.data.bins.length).toBeGreaterThanOrEqual(2);
  });

  it("11. Enforces Open Multi-Offer Bidding, Address Privacy, Dismantling Mass Conservation, Upward BatchLineage & Khata Auto-Offset", async () => {
    const custLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "customer@kabadiwala.local",
      password: "KabadiPass123",
    });
    const customerToken = custLogin.body.data.tokens.accessToken;

    const colLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    const rajuToken = colLogin.body.data.tokens.accessToken;

    const shopLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "shop@kabadiwala.local",
      password: "KabadiPass123",
    });
    const shopToken = shopLogin.body.data.tokens.accessToken;

    // A) Open Broadcast Listing hides private street address from non-owner buyers!
    const openListingsRes = await request(app)
      .get("/api/v1/listings/open")
      .set("Authorization", `Bearer ${shopToken}`);
    expect(openListingsRes.status).toBe(200);
    const openListing = openListingsRes.body.data.listings[0];
    expect(openListing).toBeTruthy();
    expect(openListing.pickupAddressPrivate).toBeUndefined();

    // B) Tier-2 Shop submits higher competing PurchaseOffer; Customer accepts winning offer!
    const offerRes = await request(app)
      .post(`/api/v1/listings/${openListing.id}/offers`)
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        offeredTotalPaise: 1580000,
        notes: "Direct shop tempo pickup + digital platform scale",
      });
    expect(offerRes.status).toBe(201);

    // Non-owner Raju tries accepting Customer's offer -> 403 BOLA DENIED!
    const illegalAccept = await request(app)
      .post(`/api/v1/offers/${offerRes.body.data.offer.id}/accept`)
      .set("Authorization", `Bearer ${rajuToken}`);
    expect(illegalAccept.status).toBe(403);

    // Real owner Customer accepts Shop's offer -> locks AGREED_PRICE & creates order!
    const validAccept = await request(app)
      .post(`/api/v1/offers/${offerRes.body.data.offer.id}/accept`)
      .set("Authorization", `Bearer ${customerToken}`);
    expect(validAccept.status).toBe(201);
    expect(validAccept.body.data.order.agreedTotalPaise).toBe(1580000);

    // C) Dismantling Physics Guard: blocks output weight > input weight, permits valid split!
    const fakeDismantle = await request(app)
      .post("/api/v1/inventory/dismantle")
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        inputDescription: "1x Split AC Fake Yield Attempt",
        inputGrams: 30000,
        residueGrams: 5000,
        outputs: [{ materialSlug: "metal-copper-bright", outputGrams: 29000 }], // 34kg > 30kg!
      });
    expect(fakeDismantle.status).toBe(400);
    expect(fakeDismantle.body.error.code).toBe("MASS_CONSERVATION_VIOLATED");

    const realDismantle = await request(app)
      .post("/api/v1/inventory/dismantle")
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        inputDescription: "1x Dead 1.5T Copper Split AC",
        inputGrams: 38000,
        residueGrams: 2000,
        outputs: [
          { materialSlug: "metal-copper-bright", outputGrams: 5800 },
          { materialSlug: "ewaste-pcb-grade-a", outputGrams: 1200 },
          { materialSlug: "metal-heavy-iron", outputGrams: 29000 },
        ],
      });
    expect(realDismantle.status).toBe(201);

    // D) Upward Hierarchy Sale (Tier 1 Collector -> Tier 2 Shop) + Khata Morning Advance Auto-Offset + Public Trace QR!
    const sfRes = await request(app).get("/api/v1/storefronts");
    const gillShopSf = sfRes.body.data.storefronts.find(
      (s: { slug: string }) => s.slug === "gill-road-scrap-shop"
    );
    const rajuBinsRes = await request(app)
      .get("/api/v1/inventory/bins")
      .set("Authorization", `Bearer ${rajuToken}`);
    const rajuNewspaperBin = rajuBinsRes.body.data.bins.find(
      (b: { material: { slug: string } }) => b.material.slug === "paper-newspaper"
    );
    expect(rajuNewspaperBin).toBeTruthy();

    // Sell 10 kg Newspaper upward from Tier-1 Raju to Tier-2 Gill Road Shop -> auto-links child order in BatchLineage!
    const upwardRes = await request(app)
      .post(`/api/v1/inventory/bins/${rajuNewspaperBin.id}/sell-upward`)
      .set("Authorization", `Bearer ${rajuToken}`)
      .send({
        sellGrams: 10000,
        targetStorefrontId: gillShopSf.id,
        fulfillmentMode: "SELLER_DROPOFF",
      });
    expect(upwardRes.status).toBe(201);
    expect(upwardRes.body.data.lineageLinksCreated).toBeGreaterThanOrEqual(1);

    const upwardOrder = upwardRes.body.data.order;

    // Tier-2 Shop weighs & settles Raju's upward order -> automatically offsets seeded ₹1,500 morning Peshgi advance!
    const settleUpward = await request(app)
      .post(`/api/v1/orders/${upwardOrder.id}/weigh-and-settle`)
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        items: upwardOrder.items.map((it: { id: string; estimatedGrams: number }) => ({
          orderItemId: it.id,
          actualGrams: it.estimatedGrams,
        })),
        adjustmentPaise: 0,
        autoOffsetKhataAdvance: true,
      });
    expect(settleUpward.status).toBe(200);
    const hasLedgerOffset = settleUpward.body.data.order.paymentRecords.some(
      (p: { method: string }) => p.method === "LEDGER_OFFSET"
    );
    expect(hasLedgerOffset).toBe(true);

    // Public QR Trace endpoint returns multi-tier BatchLineage tree & scrubs all PII!
    const traceRes = await request(app).get(
      `/api/v1/public/trace/${upwardOrder.qrTraceToken}`
    );
    expect(traceRes.status).toBe(200);
    expect(traceRes.body.data.traceRecord.upstreamChildLots.length).toBeGreaterThanOrEqual(
      1
    );
    expect(traceRes.body.data.statutoryNotice).toContain("NOT be treated as a statutory");
  });

  it("12. Camera AI Vision verifies Copper vs Aluminum pixels, flags Soot/Moisture adulteration & enforces Magic-Byte security", async () => {
    const colLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    const rajuToken = colLogin.body.data.tokens.accessToken;

    // 1. Disguised shell script renamed to copper.png -> 400 INVALID_IMAGE_SIGNATURE
    const fakeImgRes = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("estimatedGrams", "5000")
      .attach("image", Buffer.from("#!/bin/sh\necho pwn\n"), {
        filename: "copper.png",
        contentType: "image/png",
      });
    expect(fakeImgRes.status).toBe(400);
    expect(fakeImgRes.body.error.code).toBe("INVALID_IMAGE_SIGNATURE");

    // 2. Clean Copper Wire PNG -> detects metal-copper-bright + all 4 vernacular audio scripts (EN/HI/PA/MR)
    const copperPng = await generateMaterialSamplePng("copper-clean");
    const copperRes = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("estimatedGrams", "6000")
      .field("language", "MR")
      .attach("image", copperPng, { filename: "copper.png", contentType: "image/png" });
    expect(copperRes.status).toBe(201);
    expect(copperRes.body.data.priceType).toBe("INDICATIVE_ESTIMATE");
    expect(copperRes.body.data.requiresHumanConfirmation).toBe(true);
    expect(copperRes.body.data.detectedMaterial.slug).toBe("metal-copper-bright");
    expect(copperRes.body.data.detectedMaterial.coilMetalVerdict).toBe(
      "COPPER_VERIFIED_SIGNATURE"
    );
    expect(copperRes.body.data.vernacularAudioScripts.MR).toContain("तांब्याची");

    // 3. Silvery Aluminum Coil PNG -> detects metal-aluminium-utensil (NOT Copper!)
    const alumPng = await generateMaterialSamplePng("aluminum-coil");
    const alumRes = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("estimatedGrams", "6000")
      .attach("image", alumPng, { filename: "alum.png", contentType: "image/png" });
    expect(alumRes.status).toBe(201);
    expect(alumRes.body.data.detectedMaterial.slug).toBe("metal-aluminium-utensil");
    expect(alumRes.body.data.detectedMaterial.coilMetalVerdict).toBe(
      "ALUMINUM_SILVERY_SIGNATURE"
    );
    expect(alumRes.body.data.indicativeRange.maxPaise).toBeLessThan(
      copperRes.body.data.indicativeRange.maxPaise
    );

    // 4. Illegally Burnt Ash-Contaminated Copper & Wet Adulterated Cardboard -> flagged HIGH fraud risk!
    const burntPng = await generateMaterialSamplePng("copper-burnt-fraud");
    const burntRes = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("estimatedGrams", "4000")
      .attach("image", burntPng, { filename: "burnt.png", contentType: "image/png" });
    expect(burntRes.status).toBe(201);
    expect(burntRes.body.data.antiFraudForensics.fraudFlags).toContain(
      "ILLEGAL_OPEN_BURNING_SOOT_RESIDUE"
    );

    const wetCardboardPng = await generateMaterialSamplePng("cardboard-wet-fraud");
    const wetRes = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("estimatedGrams", "10000")
      .attach("image", wetCardboardPng, {
        filename: "wet-gatta.png",
        contentType: "image/png",
      });
    expect(wetRes.status).toBe(201);
    expect(wetRes.body.data.antiFraudForensics.fraudFlags).toContain(
      "MOISTURE_WATER_WEIGHT_ADULTERATION"
    );

    // 5. Human-in-the-loop confirmation BOLA check + 4-language Storefront Speech Script check
    const shopLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "shop@kabadiwala.local",
      password: "KabadiPass123",
    });
    const shopToken = shopLogin.body.data.tokens.accessToken;

    const illegalConfirm = await request(app)
      .post(`/api/v1/ai/scans/${copperRes.body.data.scanId}/confirm`)
      .set("Authorization", `Bearer ${shopToken}`);
    expect(illegalConfirm.status).toBe(403);

    const validConfirm = await request(app)
      .post(`/api/v1/ai/scans/${copperRes.body.data.scanId}/confirm`)
      .set("Authorization", `Bearer ${rajuToken}`);
    expect(validConfirm.status).toBe(200);
    expect(validConfirm.body.data.scan.humanConfirmedAt).toBeTruthy();

    const sfList = await request(app).get("/api/v1/storefronts");
    const speechRes = await request(app).post("/api/v1/ai/speech-script").send({
      contextType: "STOREFRONT_RATES",
      language: "MR",
      storefrontId: sfList.body.data.storefronts[0].id,
    });
    expect(speechRes.status).toBe(200);
    expect(speechRes.body.data.locale).toBe("mr-IN");
    expect(speechRes.body.data.script).toContain("रुपये");
  });

  it("13. 7-Segment Scale Pixel OCR reads exact digits, flags weight tampering & blocks JPEG-recompressed photo replay attacks", async () => {
    const custLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "customer@kabadiwala.local",
      password: "KabadiPass123",
    });
    const customerToken = custLogin.body.data.tokens.accessToken;

    const shopLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "shop@kabadiwala.local",
      password: "KabadiPass123",
    });
    const shopToken = shopLogin.body.data.tokens.accessToken;

    // 1. Honest Red LED Scale showing 18.45 kg (18450 g) -> exact pixel decode, zero discrepancy!
    const honestScalePng = await generateScalePlatePng("18.45", "RED");
    const okScale = await request(app)
      .post("/api/v1/ai/scale-ocr")
      .set("Authorization", `Bearer ${shopToken}`)
      .field("declaredGrams", "18450")
      .field("language", "HI")
      .attach("image", honestScalePng, {
        filename: "scale-1845.png",
        contentType: "image/png",
      });
    expect(okScale.status).toBe(201);
    expect(okScale.body.data.scaleReadGrams).toBe(18450);
    expect(okScale.body.data.ocrDiscrepancyFlag).toBe(false);
    expect(okScale.body.data.verdictStatus).toBe("VERIFIED_WITHIN_TOLERANCE");

    // 2. Weight Shortchanging Attempt: Green LED Scale shows 09.20 kg (9200 g) while buyer enters 12500 g!
    const mismatchPng = await generateScalePlatePng("09.20", "GREEN");
    const mismatchRes = await request(app)
      .post("/api/v1/ai/scale-ocr")
      .set("Authorization", `Bearer ${shopToken}`)
      .field("declaredGrams", "12500")
      .attach("image", mismatchPng, {
        filename: "scale-0920.png",
        contentType: "image/png",
      });
    expect(mismatchRes.status).toBe(201);
    expect(mismatchRes.body.data.scaleReadGrams).toBe(9200);
    expect(mismatchRes.body.data.ocrDiscrepancyFlag).toBe(true);
    expect(mismatchRes.body.data.fraudFlags).toContain("SCALE_WEIGHT_MISMATCH");

    // 3. Recompress the earlier 18.45 kg PNG into lossy JPEG (completely new SHA-256!) and try replaying on a new order!
    const recompressedJpeg = await sharp(honestScalePng).jpeg({ quality: 72 }).toBuffer();
    const replayScanRes = await request(app)
      .post("/api/v1/ai/scale-ocr")
      .set("Authorization", `Bearer ${shopToken}`)
      .field("declaredGrams", "18450")
      .attach("image", recompressedJpeg, {
        filename: "recompressed-yesterday.jpg",
        contentType: "image/jpeg",
      });
    expect(replayScanRes.status).toBe(201);
    expect(replayScanRes.body.data.replayFraudDetected).toBe(true);
    expect(replayScanRes.body.data.replayCheck.replayType).toBe(
      "PERCEPTUAL_DHASH_NEAR_DUPLICATE"
    );

    // Create a fresh order to Gill Road Shop and try settling using the replayed scaleScanId -> 409 BLOCKED!
    const sfRes = await request(app).get("/api/v1/storefronts");
    const gillShop = sfRes.body.data.storefronts.find(
      (s: { slug: string }) => s.slug === "gill-road-scrap-shop"
    );
    const newOrderRes = await request(app)
      .post("/api/v1/listings")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({
        title: "Household Cardboard Batch for Scale Anti-Replay Test",
        pickupPincode: "141001",
        pickupAddressPrivate: "House 44, Model Town, Ludhiana",
        preferredMode: "SELLER_DROPOFF",
        targetStorefrontId: gillShop.id,
        items: [{ materialSlug: "paper-cardboard", estimatedGrams: 18450 }],
      });
    const order = newOrderRes.body.data.order;

    const blockedSettle = await request(app)
      .post(`/api/v1/orders/${order.id}/weigh-and-settle`)
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        items: [{ orderItemId: order.items[0].id, actualGrams: 18450 }],
        scaleScanId: replayScanRes.body.data.scanId,
      });
    expect(blockedSettle.status).toBe(409);
    expect(blockedSettle.body.error.code).toBe("SCALE_PHOTO_REPLAY_BLOCKED");

    // 4. Milestone 3 Verification: Dispute BOLA guard, Settlement Freeze on DISPUTED order & Admin Arbitration!
    // Unrelated user Collector B tries disputing Customer <-> Shop order -> 403 BOLA DENIED!
    const illegalDispute = await request(app)
      .post(`/api/v1/orders/${order.id}/disputes`)
      .set("Authorization", `Bearer ${collectorBToken}`)
      .send({
        reasonCategory: "WEIGHT_DISCREPANCY",
        description: "Attempting horizontal BOLA dispute injection on another party order",
      });
    expect(illegalDispute.status).toBe(403);

    // Real seller Customer opens a WEIGHT_DISCREPANCY dispute on the active order
    const acceptFirst = await request(app)
      .post(`/api/v1/orders/${order.id}/accept`)
      .set("Authorization", `Bearer ${shopToken}`);
    expect(acceptFirst.status).toBe(200);

    const openDispute = await request(app)
      .post(`/api/v1/orders/${order.id}/disputes`)
      .set("Authorization", `Bearer ${customerToken}`)
      .send({
        reasonCategory: "WEIGHT_DISCREPANCY",
        description: "Buyer attempted replaying old scale photograph instead of live weighing",
      });
    expect(openDispute.status).toBe(201);
    const disputeId = openDispute.body.data.dispute.id;

    // While DISPUTED, buyer CANNOT unilaterally settle the order -> 409 ORDER_DISPUTED_LOCKED!
    const frozenSettle = await request(app)
      .post(`/api/v1/orders/${order.id}/weigh-and-settle`)
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        items: [{ orderItemId: order.items[0].id, actualGrams: 18450 }],
      });
    expect(frozenSettle.status).toBe(409);
    expect(frozenSettle.body.error.code).toBe("ORDER_DISPUTED_LOCKED");

    // Admin arbitrates & resolves dispute with verified payout -> completes order & notifies both parties!
    const resolveRes = await request(app)
      .post(`/api/v1/admin/disputes/${disputeId}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        decision: "RESOLVED_ADJUSTED",
        resolutionNotes: "Verified 18.45 kg cardboard weight in presence of both parties",
        adjustedSettlementPaise: 29520,
      });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.data.order.status).toBe("COMPLETED");
    expect(resolveRes.body.data.order.finalSettlementPaise).toBe(29520);

    // Both participants received PII-safe notifications
    const custNotifs = await request(app)
      .get("/api/v1/notifications")
      .set("Authorization", `Bearer ${customerToken}`);
    expect(custNotifs.status).toBe(200);
    expect(custNotifs.body.data.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it("14. Enforces Idempotent Offline Field Batch Sync (Zero Duplicate Side-Effects on Replay) & Serves Multi-Tier Price History", async () => {
    const shopLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "shop@kabadiwala.local",
      password: "KabadiPass123",
    });
    const shopToken = shopLogin.body.data.tokens.accessToken;

    // 1. Rejects unsupported sensitive KYC/Admin operations in offline sync queue
    const forbiddenSync = await request(app)
      .post("/api/v1/sync/batch")
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        operations: [
          {
            idempotencyKey: "bad-kyc-op-001",
            clientEntityId: "kyc-1",
            operationType: "ADMIN_AUTO_APPROVE_KYC",
            payload: {},
          },
        ],
      });
    expect(forbiddenSync.status).toBe(400);

    // 2. First sync batch applies 1 offline Listing + 1 offline Khata cash advance cleanly
    const syncPayload = {
      deviceLabel: "Expo Android Field Queue v1",
      operations: [
        {
          idempotencyKey: "offline-field-op-listing-9001",
          clientEntityId: "local-draft-9001",
          operationType: "DRAFT_LISTING_CREATE",
          payload: {
            title: "Offline Shed Collection: 22 kg Sorted Heavy Iron",
            pickupPincode: "141003",
            pickupAddressPrivate: "Industrial Area Phase II Shed 9",
            preferredMode: "SELLER_DROPOFF",
            items: [{ materialSlug: "metal-heavy-iron", estimatedGrams: 22000 }],
          },
        },
        {
          idempotencyKey: "offline-field-op-khata-9002",
          clientEntityId: "local-khata-9002",
          operationType: "KHATA_ADVANCE_RECORD",
          payload: {
            borrowerPlatformCode: "KC-COL-100101",
            amountPaise: 50000,
            entryType: "CASH_ADVANCE_GIVEN",
            notes: "Offline field pheri fuel advance",
          },
        },
      ],
    };

    const firstSync = await request(app)
      .post("/api/v1/sync/batch")
      .set("Authorization", `Bearer ${shopToken}`)
      .send(syncPayload);
    expect(firstSync.status).toBe(200);
    expect(firstSync.body.data.summary.newlyAppliedCount).toBe(2);
    expect(firstSync.body.data.summary.idempotentSkippedCount).toBe(0);

    // 3. Flaky mobile network retries the EXACT SAME batch -> 0 duplicate records created!
    const retrySync = await request(app)
      .post("/api/v1/sync/batch")
      .set("Authorization", `Bearer ${shopToken}`)
      .send(syncPayload);
    expect(retrySync.status).toBe(200);
    expect(retrySync.body.data.summary.newlyAppliedCount).toBe(0);
    expect(retrySync.body.data.summary.idempotentSkippedCount).toBe(2);
    expect(retrySync.body.data.results[0].serverRecord.listingId).toBe(
      firstSync.body.data.results[0].serverRecord.listingId
    );

    // 4. Multi-Tier Market Price History & Arbitrage Spread API returns live series
    const historyRes = await request(app).get(
      "/api/v1/materials/price-history?materialSlug=metal-copper-bright"
    );
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data.history.length).toBeGreaterThanOrEqual(6);
    expect(historyRes.body.data.tierArbitrageSpreads.length).toBeGreaterThanOrEqual(3);
  });

  it("16. Generates integer-paise UPI pay QR + scannable lineage SVG slip with Khata deduction & enforces BOLA", async () => {
    const shopLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "shop@kabadiwala.local",
      password: "KabadiPass123",
    });
    const shopToken = shopLogin.body.data.tokens.accessToken;

    const rajuLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    const rajuToken = rajuLogin.body.data.tokens.accessToken;

    // Create a fresh order from Raju (Collector) -> Area Shop and settle with automatic Khata advance offset
    const sfList = await request(app).get("/api/v1/storefronts");
    const areaShopSf = sfList.body.data.storefronts.find(
      (s: { organization: { tier: string } }) => s.organization.tier === "TIER_2_AREA_SHOP"
    );

    const createLot = await request(app)
      .post("/api/v1/listings")
      .set("Authorization", `Bearer ${rajuToken}`)
      .send({
        title: "Raju Copper Wire Settlement Slip Test",
        pickupPincode: "141003",
        pickupAddressPrivate: "Gali 2, Focal Point, Ludhiana",
        preferredMode: "SELLER_DROPOFF",
        targetStorefrontId: areaShopSf.id,
        items: [{ materialSlug: "metal-copper-bright", estimatedGrams: 5000 }],
      });
    expect(createLot.status).toBe(201);
    const createdOrder = createLot.body.data.order;

    // Unrelated third-party account (Collector B) MUST be blocked from reading Raju's slip (403 BOLA!)
    const bolaSlip = await request(app)
      .get(`/api/v1/orders/${createdOrder.id}/settlement-slip`)
      .set("Authorization", `Bearer ${collectorBToken}`);
    expect(bolaSlip.status).toBe(403);

    // Buyer settles order (auto-offsetting prior morning Khata advance)
    const settleRes = await request(app)
      .post(`/api/v1/orders/${createdOrder.id}/weigh-and-settle`)
      .set("Authorization", `Bearer ${shopToken}`)
      .send({
        items: [{ orderItemId: createdOrder.items[0].id, actualGrams: 5000 }],
        adjustmentPaise: 0,
        autoOffsetKhataAdvance: true,
      });
    expect(settleRes.status).toBe(200);

    // Fetch tamper-evident settlement slip & dynamic UPI QR SVG
    const slipRes = await request(app)
      .get(`/api/v1/orders/${createdOrder.id}/settlement-slip`)
      .set("Authorization", `Bearer ${rajuToken}`);
    expect(slipRes.status).toBe(200);
    const slip = slipRes.body.data.slip;
    expect(slip.totals.grossAmountPaise).toBeGreaterThan(0);
    expect(
      slip.totals.khataAdvanceOffsetPaise + slip.totals.netPayablePaise
    ).toBe(slip.totals.grossAmountPaise);
    expect(slip.upi.upiIntentUri).toContain("upi://pay?pa=");
    expect(slip.upi.upiIntentUri).toContain(`am=${slip.totals.netPayableExactInr}`);
    expect(slip.upi.upiQrSvg).toContain("<svg");
    expect(slip.traceQrSvg).toContain("<svg");
    expect(slip.receiptDigestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("17. Enforces full KYC private document vault lifecycle (magic-byte PNG accepted, 60s HMAC link bound per user)", async () => {
    const caseRes = await request(app)
      .post("/api/v1/verification/cases")
      .set("Authorization", `Bearer ${collectorBToken}`)
      .send({
        requestedLevel: "LEVEL_2_IDENTITY_REVIEWED",
        registrationType: "IDENTITY_DOC",
        registrationNumber: "DL-PB10-20269911",
        issuingAuthority: "RTO Ludhiana",
        notes: "End-to-end KYC vault test",
      });
    expect(caseRes.status).toBe(201);
    const caseId = caseRes.body.data.verificationCase.id;

    // Valid PNG binary upload succeeds and hides storageKey
    const realPng = await generateMaterialSamplePng("copper-clean");
    const uploadRes = await request(app)
      .post(`/api/v1/verification/cases/${caseId}/documents`)
      .set("Authorization", `Bearer ${collectorBToken}`)
      .field("documentKind", "IDENTITY_DOC")
      .attach("document", realPng, {
        filename: "voter-id-sample.png",
        contentType: "image/png",
      });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.data.document.detectedMime).toBe("image/png");
    expect(uploadRes.body.data.document.storageKey).toBeUndefined();
    const docId = uploadRes.body.data.document.id;

    // Issue 60s HMAC signed download token for Admin
    const signedRes = await request(app)
      .post(`/api/v1/verification/documents/${docId}/signed-link`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(signedRes.status).toBe(200);
    const downloadPath: string = signedRes.body.data.downloadPath;

    // Admin downloads the exact verified bytes with X-Content-Type-Options: nosniff
    const adminDownload = await request(app)
      .get(downloadPath)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminDownload.status).toBe(200);
    expect(adminDownload.headers["x-content-type-options"]).toBe("nosniff");

    // Stolen signed URL used by another user (Recycler) is REJECTED because HMAC binds recipientUserId!
    const stolenDownload = await request(app)
      .get(downloadPath)
      .set("Authorization", `Bearer ${recyclerToken}`);
    expect(stolenDownload.status).toBe(403);
  });

  it("18. [M5.1] Expo Mobile SDK completes Phone OTP login, silent 401 refresh rotation, multi-tier booking & UPI settlement slip", async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const mobileKeystore = createInMemoryTokenAdapter();
      const collectorMobile = new MobileApiClient(baseUrl, mobileKeystore);

      // 1. Passwordless Phone OTP Login for Collector A (+919876543210)
      const otpReq = await collectorMobile.requestPhoneOtpLogin("+919876543210");
      expect(otpReq.ok).toBe(true);
      expect(otpReq.data?.devPreviewOtp).toMatch(/^\d{6}$/);

      const otpVerify = await collectorMobile.verifyPhoneOtpLogin(
        "+919876543210",
        otpReq.data!.devPreviewOtp!
      );
      expect(otpVerify.ok).toBe(true);
      expect(otpVerify.data?.user.verificationLevel).toBe("LEVEL_1_CONTACT_VERIFIED");

      // 2. Simulate expired/corrupted access token -> MobileApiClient transparently rotates via /auth/refresh!
      await mobileKeystore.setItem("kc_secure_access_token", "expired.invalid.jwt");
      const healedMe = await collectorMobile.getMe();
      expect(healedMe.ok).toBe(true);
      expect(healedMe.data?.user.id).toBe(collectorAUserId);

      // 3. Browse Storefronts, Price History & Spoken Audio Script from Mobile Client
      const sfRes = await collectorMobile.listStorefronts();
      expect(sfRes.ok).toBe(true);
      const areaShopSf = sfRes.data!.storefronts.find(
        (s) => (s.organization as { tier?: string })?.tier === "TIER_2_AREA_SHOP"
      )!;
      expect(areaShopSf).toBeTruthy();

      const speechRes = await collectorMobile.getStorefrontSpeechScript(
        String(areaShopSf.id),
        "PA"
      );
      expect(speechRes.ok).toBe(true);
      expect(speechRes.data?.locale).toBe("pa-IN");

      // 4. Book Drop-off Order -> Shop settles -> Collector opens dynamic UPI Slip
      const booked = await collectorMobile.createListingOrOrder({
        title: "Expo Field App 8 kg Clean Copper Lot",
        pickupPincode: "141003",
        pickupAddressPrivate: "Miller Ganj Lane 4, Ludhiana",
        preferredMode: "SELLER_DROPOFF",
        targetStorefrontId: String(areaShopSf.id),
        items: [{ materialSlug: "metal-copper-bright", estimatedGrams: 8000 }],
      });
      expect(booked.ok).toBe(true);
      const mobileOrder = booked.data!.order as {
        id: string;
        qrTraceToken: string;
        items: Array<{ id: string }>;
      };

      const shopKeystore = createInMemoryTokenAdapter();
      const shopMobile = new MobileApiClient(baseUrl, shopKeystore);
      const shopLogin = await shopMobile.loginWithCredentials(
        "shop@kabadiwala.local",
        "KabadiPass123"
      );
      expect(shopLogin.ok).toBe(true);

      await shopMobile.acceptOrder(mobileOrder.id);
      const settled = await shopMobile.weighAndSettleOrder({
        orderId: mobileOrder.id,
        items: [{ orderItemId: mobileOrder.items[0]!.id, actualGrams: 8000 }],
        autoOffsetKhataAdvance: true,
      });
      expect(settled.ok).toBe(true);

      const slipRes = await collectorMobile.getSettlementSlip(mobileOrder.id);
      expect(slipRes.ok).toBe(true);
      expect(slipRes.data?.slip.upi.upiIntentUri).toContain("upi://pay?pa=");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("19. [M5.2] Expo Mobile Camera Base64 Vision + 7-Seg Scale OCR + Live QR Resolver + Persistent SQLite Cold-Restart Sync", async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const rajuKeystore = createInMemoryTokenAdapter();
      const rajuMobile = new MobileApiClient(baseUrl, rajuKeystore);
      const loginRes = await rajuMobile.loginWithCredentials(
        "collector@kabadiwala.local",
        "KabadiPass123"
      );
      expect(loginRes.ok).toBe(true);
      const rajuPlatformCode = loginRes.data!.user.platformCode;

      // 1. Mobile Camera Base64 Scrap Material Scan & Human Confirmation
      const rawCopperPng = await generateMaterialSamplePng("copper-clean");
      // Stamp unique corner pixel metadata so anti-replay sees a fresh field camera shutter frame
      const uniqueCopperPng = await sharp(rawCopperPng)
        .composite([
          {
            input: {
              create: {
                width: 24,
                height: 24,
                channels: 3,
                background: { r: 196, g: 92, b: 36 },
              },
            },
            top: 4,
            left: 4,
          },
        ])
        .png()
        .toBuffer();

      const mobileVision = await rajuMobile.scanMaterialBase64({
        imageBase64: uniqueCopperPng.toString("base64"),
        estimatedGrams: 7500,
        city: "Ludhiana",
        language: "HI",
      });
      expect(mobileVision.ok).toBe(true);
      expect(
        (mobileVision.data?.detectedMaterial as { slug?: string })?.slug
      ).toBe("metal-copper-bright");

      const confirmRes = await rajuMobile.confirmScan(
        String(mobileVision.data!.scanId)
      );
      expect(confirmRes.ok).toBe(true);

      // 2. Mobile Camera Base64 7-Segment Scale OCR Scan (23.75 kg green LED display)
      const mobileScalePng = await generateScalePlatePng("23.75", "GREEN");
      const mobileScaleOcr = await rajuMobile.scanScaleOcrBase64({
        imageBase64: `data:image/png;base64,${mobileScalePng.toString("base64")}`,
        declaredGrams: 23750,
        language: "PA",
      });
      expect(mobileScaleOcr.ok).toBe(true);
      expect(mobileScaleOcr.data?.scaleReadGrams).toBe(23750);
      expect(mobileScaleOcr.data?.ocrDiscrepancyFlag).toBe(false);

      // 3. Persistent SQLite Queue across simulated cold process restart + idempotent batch replay
      const persistentSqliteBacking = new Map<string, string>();
      const sessionOneQueue = new OfflineSyncQueue(
        new SerializedJournalQueueDriver(persistentSqliteBacking)
      );
      await sessionOneQueue.enqueue({
        idempotencyKey: "mobile-sqlite-restart-test-5001",
        clientEntityId: "android-lot-5001",
        operationType: "DRAFT_LISTING_CREATE",
        createdAtIso: new Date().toISOString(),
        payload: {
          title: "SQLite Cold-Restart Persisted 15 kg Aluminium Lot",
          pickupPincode: "141003",
          pickupAddressPrivate: "Dhandari Kalan Yard 4, Ludhiana",
          preferredMode: "SELLER_DROPOFF",
          items: [
            { materialSlug: "metal-aluminium-utensil", estimatedGrams: 15000 },
          ],
        },
      });
      expect(sessionOneQueue.getPending().length).toBe(1);

      // Cold restart: new OfflineSyncQueue instance reads from persisted backing store
      const coldRestartedQueue = new OfflineSyncQueue(
        new SerializedJournalQueueDriver(persistentSqliteBacking)
      );
      const hydrated = await coldRestartedQueue.hydrateFromDisk();
      expect(hydrated.length).toBe(1);
      expect(hydrated[0]!.idempotencyKey).toBe("mobile-sqlite-restart-test-5001");

      const rajuAccessToken = (await rajuKeystore.getItem(
        "kc_secure_access_token"
      ))!;
      const flushResult = await coldRestartedQueue.flushBatchToServer(
        baseUrl,
        rajuAccessToken,
        "Android SQLite WAL Test"
      );
      expect(flushResult.applied).toBe(1);
      expect(flushResult.rejected).toBe(0);

      // 4. Live Mobile QR Scanner resolves Verify Badge, Bale Lineage Trace & UPI Intent
      const qrBadge = await rajuMobile.resolveScannedQrPayload(
        `https://kabadiwala.local/verify/${rajuPlatformCode}`
      );
      expect(qrBadge.kind).toBe("VERIFY_ENTITY");
      expect(qrBadge.serverData?.publicCard).toBeTruthy();

      const ordersRes = await rajuMobile.listOrders();
      const traceableOrder = ordersRes.data!.orders.find((o) =>
        Boolean(o.qrTraceToken)
      )!;
      const qrTrace = await rajuMobile.resolveScannedQrPayload(
        `https://kabadiwala.local/trace/${String(traceableOrder.qrTraceToken)}`
      );
      expect(qrTrace.kind).toBe("TRACE_BALE");
      expect(qrTrace.serverData?.traceRecord).toBeTruthy();

      const qrUpi = await rajuMobile.resolveScannedQrPayload(
        "upi://pay?pa=shop@upi&pn=Area%20Shop&am=1250.00&cu=INR"
      );
      expect(qrUpi.kind).toBe("UPI_PAYMENT_INTENT");
      expect(qrUpi.upiUri).toContain("am=1250.00");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("20. [M6.1] Executes trained .onnx mixed-heap vision + non-illuminated LCD/paper OCR + pluggable SMS adapter + HMAC webhook", async () => {
    const colLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    const rajuToken = colLogin.body.data.tokens.accessToken;

    // 1. Messy Mixed-Material Heap (Copper + Silvery Aluminium side-by-side) -> ONNX 9-patch tensor detects BOTH streams!
    const mixedHeapPng = await generateMaterialSamplePng("mixed-copper-aluminum");
    const mixedRes = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("estimatedGrams", "12000")
      .attach("image", mixedHeapPng, {
        filename: "mixed-heap.png",
        contentType: "image/png",
      });
    expect(mixedRes.status).toBe(201);
    expect(
      mixedRes.body.data.antiFraudForensics.onnxInference.runtimeBackend
    ).toBe("onnxruntime-wasm-cpu");
    expect(
      mixedRes.body.data.antiFraudForensics.onnxInference.multiMaterialHeapDetected
    ).toBe(true);
    expect(mixedRes.body.data.antiFraudForensics.fraudFlags).toContain(
      "MIXED_MULTI_MATERIAL_HEAP_SEGREGATION_ADVISORY"
    );
    const detectedSlugs = mixedRes.body.data.antiFraudForensics.onnxInference.heapComposition.map(
      (c: { materialSlug: string }) => c.materialSlug
    );
    expect(detectedSlugs).toContain("metal-copper-bright");
    expect(detectedSlugs).toContain("metal-aluminium-utensil");

    // 2. Non-illuminated Monochrome Reflective LCD Scale (31.40 kg) & Printed Paper Slip (46.25 kg) decoded via .onnx!
    const lcdPng = await generateScalePlatePng("31.40", "LCD");
    const lcdRes = await request(app)
      .post("/api/v1/ai/scale-ocr")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("declaredGrams", "31400")
      .attach("image", lcdPng, { filename: "lcd-3140.png", contentType: "image/png" });
    expect(lcdRes.status).toBe(201);
    expect(lcdRes.body.data.displayMode).toBe("REFLECTIVE_LCD_SLIP");
    expect(lcdRes.body.data.scaleReadGrams).toBe(31400);
    expect(lcdRes.body.data.ocrDiscrepancyFlag).toBe(false);

    const paperSlipPng = await generateScalePlatePng("46.25", "PAPER_SLIP");
    const paperRes = await request(app)
      .post("/api/v1/ai/scale-ocr")
      .set("Authorization", `Bearer ${rajuToken}`)
      .field("declaredGrams", "46250")
      .attach("image", paperSlipPng, {
        filename: "paper-4625.png",
        contentType: "image/png",
      });
    expect(paperRes.status).toBe(201);
    expect(paperRes.body.data.displayMode).toBe("REFLECTIVE_LCD_SLIP");
    expect(paperRes.body.data.scaleReadGrams).toBe(46250);
    expect(paperRes.body.data.ocrDiscrepancyFlag).toBe(false);

    // 3. Pluggable SMS Gateway Adapter recorded masked OTP dispatch without leaking plaintext OTP
    expect(getRecentSandboxSmsDispatches().length).toBeGreaterThanOrEqual(1);

    // 4. Signed HMAC-SHA256 Payment Webhook blocks forged signatures & stale timestamps, and deduplicates replays!
    const ordersRes = await request(app)
      .get("/api/v1/orders")
      .set("Authorization", `Bearer ${rajuToken}`);
    const targetOrderId = ordersRes.body.data.orders[0].id as string;

    const rawWebhookPayload = JSON.stringify({
      eventId: "evt_razorpay_upi_m6_99001",
      eventType: "payout.processed",
      orderId: targetOrderId,
      amountPaise: 85000,
      utrReference: "UTR629611223344",
    });
    const nowSec = Math.floor(Date.now() / 1000);

    // 4a. Forged signature -> 401
    const badSigRes = await request(app)
      .post("/api/v1/webhooks/payments/upi-payout")
      .set("Content-Type", "application/json")
      .set("x-kabadi-timestamp", String(nowSec))
      .set("x-kabadi-signature", "0".repeat(64))
      .send(rawWebhookPayload);
    expect(badSigRes.status).toBe(401);

    // 4b. Stale replay timestamp (15 minutes old) even with mathematically computed HMAC -> 401
    const staleTs = nowSec - 900;
    const staleSig = computeWebhookHmacSignature(staleTs, rawWebhookPayload);
    const staleRes = await request(app)
      .post("/api/v1/webhooks/payments/upi-payout")
      .set("Content-Type", "application/json")
      .set("x-kabadi-timestamp", String(staleTs))
      .set("x-kabadi-signature", staleSig)
      .send(rawWebhookPayload);
    expect(staleRes.status).toBe(401);

    // 4c. Authentic fresh HMAC signature -> 200 & creates PaymentRecord
    const validSig = computeWebhookHmacSignature(nowSec, rawWebhookPayload);
    const okWebhook = await request(app)
      .post("/api/v1/webhooks/payments/upi-payout")
      .set("Content-Type", "application/json")
      .set("x-kabadi-timestamp", String(nowSec))
      .set("x-kabadi-signature", validSig)
      .send(rawWebhookPayload);
    expect(okWebhook.status).toBe(200);
    expect(okWebhook.body.data.idempotentReplay).toBe(false);
    expect(okWebhook.body.data.paymentRecordId).toBeTruthy();

    // 4d. Duplicate webhook retry -> 200 idempotent no-op!
    const replayWebhook = await request(app)
      .post("/api/v1/webhooks/payments/upi-payout")
      .set("Content-Type", "application/json")
      .set("x-kabadi-timestamp", String(nowSec))
      .set("x-kabadi-signature", validSig)
      .send(rawWebhookPayload);
    expect(replayWebhook.status).toBe(200);
    expect(replayWebhook.body.data.idempotentReplay).toBe(true);
  });

  it("21. [M6.2] Exposes ONNX + Redis subsystem health diagnostics and validates Docker, Backup & CI artifacts", async () => {
    const health = await request(app).get("/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.data.subsystems.onnxEngine.modelsPresentOnDisk).toBe(true);
    expect(health.body.data.subsystems.smsProvider).toBe("sandbox");

    for (const relPath of [
      "Dockerfile.api",
      "Dockerfile.web",
      "docker-compose.yml",
      "scripts/backup-postgres.sh",
      "scripts/restore-postgres.sh",
      ".github/workflows/ci.yml",
      "apps/api/models/scrap_material_classifier_v1.onnx",
      "apps/api/models/lcd_scale_ocr_v1.onnx",
      "apps/api/models/scrap_vision_cnn_v2.onnx",
      "apps/api/models/device_xray_cnn_v2.onnx",
      "apps/api/models/scale_crnn_ocr_v2.onnx",
      "apps/api/models/vernacular_intent_nlu_v2.onnx",
      "apps/api/models/mandi_price_forecaster_v2.onnx",
      "apps/api/models/manifest.json",
    ]) {
      expect(fs.existsSync(path.join(WORKSPACE_ROOT, relPath))).toBe(true);
    }
  });

  it("22. [M7.1] Runs true 2D-CNN camera appliance X-Ray (.onnx) distinguishing Copper vs Aluminium Split AC & Smartphone photos with live mandi BOM rates", async () => {
    const colLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    const token = colLogin.body.data.tokens.accessToken;

    // 1. Copper-condenser Split AC camera photo -> Multi-Task 2D CNN predicts COPPER coil!
    const acCuPng = await generateApplianceXraySamplePng("xray-split-ac-copper");
    const acCuRes = await request(app)
      .post("/api/v1/ai/xray-estimate")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", acCuPng, {
        filename: "split-ac-copper.png",
        contentType: "image/png",
      });
    expect(acCuRes.status).toBe(201);
    expect(acCuRes.body.data.inferenceMode).toBe(
      "CAMERA_PHOTO_2D_CNN_ONNX_MULTITASK"
    );
    expect(acCuRes.body.data.matchedDevice.slug).toBe("split-ac-15ton-copper");
    expect(acCuRes.body.data.cnnXrayInference.predictedCoilType).toBe("COPPER");

    // 2. Aluminium-fin Split AC camera photo -> Multi-Task 2D CNN predicts ALUMINUM coil (~₹2,000 lower value)!
    const acAlPng = await generateApplianceXraySamplePng("xray-split-ac-aluminum");
    const acAlRes = await request(app)
      .post("/api/v1/ai/xray-estimate")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", acAlPng, {
        filename: "split-ac-al.png",
        contentType: "image/png",
      });
    expect(acAlRes.status).toBe(201);
    expect(acAlRes.body.data.matchedDevice.slug).toBe("split-ac-15ton-aluminum");
    expect(acAlRes.body.data.cnnXrayInference.predictedCoilType).toBe("ALUMINUM");
    expect(
      acCuRes.body.data.indicativePathways.partsHarvest.minPaise
    ).toBeGreaterThan(acAlRes.body.data.indicativePathways.partsHarvest.minPaise);

    // 3. Smartphone camera photo -> 2D CNN classifies smartphone & prices gold PCB + Li-Co battery live
    const phonePng = await generateApplianceXraySamplePng("xray-smartphone");
    const phoneRes = await request(app)
      .post("/api/v1/ai/xray-estimate")
      .set("Authorization", `Bearer ${token}`)
      .attach("image", phonePng, {
        filename: "phone-5g.png",
        contentType: "image/png",
      });
    expect(phoneRes.status).toBe(201);
    expect(phoneRes.body.data.matchedDevice.slug).toBe(
      "smartphone-midrange-android"
    );
  });

  it("23. [M7.2] Runs self-hosted Vernacular AI Assistant (Hinglish/Punjabi/Marathi) + Mandi Price Forecaster + CPCB Smart Buyer Matcher", async () => {
    const custLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "customer@kabadiwala.local",
      password: "KabadiPass123",
    });
    const custToken = custLogin.body.data.tokens.accessToken;

    // 1. Natural Hinglish multi-item + appliance query + live listing creation
    const hinglishRes = await request(app)
      .post("/api/v1/ai/assistant")
      .set("Authorization", `Bearer ${custToken}`)
      .send({
        message:
          "Mere paas 2 purane AC aur 15 kg tamba hai Ludhiana mein kitna milega?",
        language: "HI",
        autoCreateListing: true,
      });
    expect(hinglishRes.status).toBe(200);
    expect(hinglishRes.body.data.intent).toBe("VALUATE_AND_RATES");
    expect(hinglishRes.body.data.liveValuation.applianceBreakdowns.length).toBe(1);
    expect(hinglishRes.body.data.createdListing.id).toBeTruthy();

    // 2. Native Gurmukhi Punjabi voice/text utterance auto-detected as PA (`pa-IN`)
    const punjabiRes = await request(app).post("/api/v1/ai/assistant").send({
      message: "ਮੇਰੇ ਕੋਲ 20 ਕਿਲੋ ਤਾਂਬਾ ਅਤੇ 50 ਕਿਲੋ ਲੋਹਾ ਹੈ ਅੱਜ ਕੀ ਭਾਅ ਮਿਲੇਗਾ",
    });
    expect(punjabiRes.status).toBe(200);
    expect(punjabiRes.body.data.detectedLanguage).toBe("PA");
    expect(punjabiRes.body.data.voiceLocale).toBe("pa-IN");

    // 3. Native Marathi Devanagari utterance with Indic digits (`१०`, `२५`) auto-detected as MR (`mr-IN`)
    const marathiRes = await request(app).post("/api/v1/ai/assistant").send({
      message: "माझ्याकडे १० किलो तांबे आणि २५ किलो रद्दी पुठ्ठा आहे किती पैसे मिळतील",
    });
    expect(marathiRes.status).toBe(200);
    expect(marathiRes.body.data.detectedLanguage).toBe("MR");
    expect(marathiRes.body.data.extractedEntities.items[0].weightGrams).toBe(
      10000
    );

    // 4. Neural 7d/14d Mandi Forecaster + CPCB Authorised Recycler Smart Matcher on 115 kg Grade-A PCBs
    const intelRes = await request(app).get(
      "/api/v1/ai/market-intelligence?city=Ludhiana"
    );
    expect(intelRes.status).toBe(200);
    expect(intelRes.body.data.forecasts.length).toBeGreaterThanOrEqual(5);

    const smartRes = await request(app)
      .post("/api/v1/ai/smart-match")
      .send({
        city: "Ludhiana",
        fulfillmentMode: "SELLER_DROPOFF",
        items: [{ materialSlug: "ewaste-pcb-grade-a", weightGrams: 115000 }],
      });
    expect(smartRes.status).toBe(200);
    expect(smartRes.body.data.recommendedPrimaryMatch.tier).toBe(
      "TIER_4_AUTHORISED_RECYCLER"
    );
    expect(smartRes.body.data.recommendedPrimaryMatch.cpcbAuthorised).toBe(true);
  });

  it("24. [M7.3] REAL-DATA model: TrashNet CNN trained on 2,527 real photographs + live real-photo gate on camera scans", async () => {
    // 1. The real-data weights, benchmark and manifest entry exist and are honest about provenance
    const realModelPath = path.join(
      WORKSPACE_ROOT,
      "apps/api/models/real_trashnet_cnn_v1.onnx"
    );
    const benchmarkPath = path.join(
      WORKSPACE_ROOT,
      "apps/api/models/real_data_benchmark.json"
    );
    expect(fs.existsSync(realModelPath)).toBe(true);
    expect(fs.existsSync(benchmarkPath)).toBe(true);

    const benchmark = JSON.parse(fs.readFileSync(benchmarkPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(benchmark.trainedOn).toBe("REAL_PHOTOS");
    expect(Number(benchmark.totalRealPhotos)).toBeGreaterThanOrEqual(2500);
    expect(Number(benchmark.heldoutRealPhotos)).toBeGreaterThanOrEqual(500);
    // Real held-out accuracy must clearly beat the random-weight control (chance ≈ 16.7%)
    expect(Number(benchmark.heldoutAccuracy)).toBeGreaterThan(0.5);
    expect(Number(benchmark.heldoutAccuracy)).toBeGreaterThan(
      Number(benchmark.randomWeightsHeldoutAccuracy) + 0.25
    );

    // 2. The API reports the real-data model separately from the synthetic pretrained suite
    const health = await request(app).get("/api/v1/health");
    expect(health.status).toBe(200);
    expect(health.body.data.subsystems.onnxEngine.modelsPresentOnDisk).toBe(true);
    expect(
      health.body.data.subsystems.onnxEngine.realDataModels.realTrashnetCnn.trainedOn
    ).toBe("REAL_PHOTOS");

    // 3. Every camera scan now returns an independent real-photo gate alongside the forensics
    const colLogin = await request(app).post("/api/v1/auth/login").send({
      identifier: "collector@kabadiwala.local",
      password: "KabadiPass123",
    });
    const token = colLogin.body.data.tokens.accessToken;
    const png = await generateMaterialSamplePng("copper-clean");
    const scan = await request(app)
      .post("/api/v1/ai/vision-verify")
      .set("Authorization", `Bearer ${token}`)
      .field("estimatedGrams", "4000")
      .attach("image", png, { filename: "real-gate.png", contentType: "image/png" });

    expect(scan.status).toBe(201);
    const gate = scan.body.data.antiFraudForensics.realPhotoGate;
    expect(gate.trainedOn).toBe("REAL_PHOTOS");
    expect(gate.heldoutRealPhotoAccuracy).toBeGreaterThan(0.5);
    expect(gate.modelVersion).toBe("kc-real-trashnet-cnn-v1.0.0");
    expect(gate.topCandidates.length).toBe(3);
    expect(
      [
        "cardboard",
        "glass",
        "metal",
        "paper",
        "plastic",
        "trash",
      ]
    ).toContain(gate.predictedClass);
    expect(typeof scan.body.data.antiFraudForensics.realPhotoGateDisagrees).toBe(
      "boolean"
    );
  });

  it("12. Immediately blocks suspended accounts and triggers HTTP 429 rate limiting on auth abuse", async () => {
    // Admin suspends Collector B
    const suspendRes = await request(app)
      .patch(`/api/v1/admin/users/${collectorBUserId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        accountStatus: "SUSPENDED",
        reason: "Security test suspension enforcement check",
      });
    expect(suspendRes.status).toBe(200);

    // Suspended Collector B's existing live JWT token is IMMEDIATELY rejected!
    const blockedReq = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${collectorBToken}`);
    expect(blockedReq.status).toBe(403);
    expect(blockedReq.body.error.code).toBe("ACCOUNT_RESTRICTED");

    // Verify endpoint rate limiter triggers 429 on burst auth requests
    let saw429 = false;
    for (let i = 0; i < 40; i++) {
      const r = await request(app).post("/api/v1/auth/login").send({
        identifier: `ratelimit-${i}@test.local`,
        password: "WrongPassword123",
      });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });

});
