import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { z } from "zod";
import {
  ScaleOcrVerifyFieldsSchema,
  VernacularSpeechScriptRequestSchema,
  VisionMaterialScanFieldsSchema,
  calculateAmountPaise,
  paiseToInrString,
} from "@kabadi/shared";
import { WORKSPACE_ROOT } from "../../lib/paths";
import { getPrisma } from "../../lib/prisma";
import {
  detectVerifiedMimeFromMagicBytes,
  verifyAccessToken,
} from "../../lib/security";
import {
  aiRateLimiter,
  authenticate,
  requireCapability,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";
import {
  getMandiMarketIntelligence,
  runCameraDeviceXrayValuation,
  runSmartBuyerMatch,
  runVernacularAiAssistant,
} from "./intelligence.service";
import {
  buildScaleVerdictSpeech,
  buildStorefrontSpeechScript,
  buildVisionScanSpeech,
  voiceLocaleForLanguage,
} from "./vernacular.service";
import {
  ApplianceXraySamplePreset,
  SCALE_OCR_MODEL_VERSION,
  VISION_MODEL_VERSION,
  analyzeImageForensics,
  classifyMaterialPixels,
  generateApplianceXraySamplePng,
  generateMaterialSamplePng,
  generateScalePlatePng,
  hammingDistanceHex64,
  readDigitalScalePixels,
} from "./vision.engine";

export const aiRouter = Router();

const AI_PRIVATE_STORAGE = path.join(WORKSPACE_ROOT, ".storage-private", "ai-scans");

const MAX_SCAN_IMAGE_BYTES = 5 * 1024 * 1024;

const uploadSingleImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_SCAN_IMAGE_BYTES, // 5 MB max upload cap
    files: 1,
  },
});

function extractSubmittedImageBuffer(req: {
  file?: { buffer?: Buffer };
  body?: Record<string, unknown>;
}): { buffer: Buffer | null; tooLarge: boolean } {
  if (req.file?.buffer) {
    return {
      buffer: req.file.buffer,
      tooLarge: req.file.buffer.length > MAX_SCAN_IMAGE_BYTES,
    };
  }
  const rawB64 = req.body?.imageBase64;
  if (typeof rawB64 === "string" && rawB64.trim().length > 0) {
    const cleaned = rawB64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, "").trim();
    const buf = Buffer.from(cleaned, "base64");
    if (buf.length > MAX_SCAN_IMAGE_BYTES) {
      return { buffer: null, tooLarge: true };
    }
    return { buffer: buf.length > 0 ? buf : null, tooLarge: false };
  }
  return { buffer: null, tooLarge: false };
}

function persistPrivateScanImage(buffer: Buffer, mime: string): string {
  fs.mkdirSync(AI_PRIVATE_STORAGE, { recursive: true, mode: 0o700 });
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const fileName = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(AI_PRIVATE_STORAGE, fileName), buffer, { mode: 0o600 });
  return fileName;
}

async function detectImageReplayFraud(
  imageSha256: string,
  perceptualHash64: string
): Promise<{
  replayDetected: boolean;
  replayType: "NONE" | "EXACT_SHA256_REPLAY" | "PERCEPTUAL_DHASH_NEAR_DUPLICATE";
  matchedScanId: string | null;
  minHammingDistance: number | null;
}> {
  const prisma = await getPrisma();
  const exact = await prisma.aIScanRecord.findFirst({
    where: { imageSha256 },
    orderBy: { createdAt: "desc" },
  });
  if (exact) {
    return {
      replayDetected: true,
      replayType: "EXACT_SHA256_REPLAY",
      matchedScanId: exact.id,
      minHammingDistance: 0,
    };
  }

  const recentScans = await prisma.aIScanRecord.findMany({
    where: { perceptualHash: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, perceptualHash: true },
  });

  let bestId: string | null = null;
  let bestDist = 64;
  for (const s of recentScans) {
    if (!s.perceptualHash) continue;
    const d = hammingDistanceHex64(perceptualHash64, s.perceptualHash);
    if (d < bestDist) {
      bestDist = d;
      bestId = s.id;
    }
  }

  // Hamming distance <= 6 out of 64 bits catches JPEG recompression & brightness tweaks!
  if (bestDist <= 6 && bestId) {
    return {
      replayDetected: true,
      replayType: "PERCEPTUAL_DHASH_NEAR_DUPLICATE",
      matchedScanId: bestId,
      minHammingDistance: bestDist,
    };
  }

  return {
    replayDetected: false,
    replayType: "NONE",
    matchedScanId: null,
    minHammingDistance: bestDist < 64 ? bestDist : null,
  };
}

// GET /api/v1/ai/sample-frame — Generates a real PNG camera frame for instant browser & camera simulation
aiRouter.get("/sample-frame", async (req, res) => {
  const kind = String(req.query.kind ?? "scale");
  if (kind === "scale") {
    const rawKg = String(req.query.kg ?? "12.45").replace(/[^0-9.]/g, "").slice(0, 6) || "12.45";
    const styleParam = String(req.query.led ?? "RED").toUpperCase();
    const led =
      styleParam === "GREEN"
        ? "GREEN"
        : styleParam === "LCD"
        ? "LCD"
        : styleParam === "PAPER_SLIP"
        ? "PAPER_SLIP"
        : "RED";
    const png = await generateScalePlatePng(rawKg, led);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
    return;
  }

  const xrayPresets: readonly ApplianceXraySamplePreset[] = [
    "xray-split-ac-copper",
    "xray-split-ac-aluminum",
    "xray-smartphone",
    "xray-laptop",
    "xray-ceiling-fan",
    "xray-washing-machine",
  ];
  if ((xrayPresets as readonly string[]).includes(kind)) {
    const png = await generateApplianceXraySamplePng(kind as ApplianceXraySamplePreset);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
    return;
  }

  const allowedPresets = [
    "copper-clean",
    "copper-burnt-fraud",
    "aluminum-coil",
    "mixed-copper-aluminum",
    "pcb-grade-a",
    "cardboard-wet-fraud",
    "battery-pack",
  ] as const;
  type Preset = (typeof allowedPresets)[number];
  const preset: Preset = (allowedPresets as readonly string[]).includes(kind)
    ? (kind as Preset)
    : "copper-clean";

  const png = await generateMaterialSamplePng(preset);
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(png);
});

// POST /api/v1/ai/vision-verify — Camera AI Material Verification, Anti-Fraud Forensics & Multi-Tier Valuation
aiRouter.post(
  "/vision-verify",
  authenticate,
  requireCapability("ai:scan"),
  uploadSingleImage.single("image"),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();

    const extracted = extractSubmittedImageBuffer(req);
    if (extracted.tooLarge) {
      sendError(res, 413, "IMAGE_TOO_LARGE", "Camera frame exceeds 5 MB upload cap");
      return;
    }
    if (!extracted.buffer) {
      sendError(
        res,
        400,
        "IMAGE_REQUIRED",
        "Upload a camera photo (JPEG, PNG, or WebP) under field 'image' or JSON 'imageBase64'"
      );
      return;
    }

    const verifiedMime = detectVerifiedMimeFromMagicBytes(extracted.buffer);
    if (!verifiedMime || verifiedMime === "application/pdf") {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "AI_SCAN_MALFORMED_FILE_BLOCKED",
        resourceType: "AIScanRecord",
        outcome: "DENIED",
        reason: "Magic-byte signature failed image check on /ai/vision-verify",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        400,
        "INVALID_IMAGE_SIGNATURE",
        "Uploaded file header is not a valid JPEG, PNG, or WebP camera image"
      );
      return;
    }

    const parsedFields = VisionMaterialScanFieldsSchema.safeParse(req.body ?? {});
    if (!parsedFields.success) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Invalid scan metadata parameters",
        parsedFields.error.flatten().fieldErrors
      );
      return;
    }

    const meta = parsedFields.data;
    const forensics = await analyzeImageForensics(extracted.buffer);
    const replay = await detectImageReplayFraud(
      forensics.imageSha256,
      forensics.perceptualHash64
    );
    const classification = await classifyMaterialPixels(extracted.buffer);
    const storageKey = persistPrivateScanImage(extracted.buffer, verifiedMime);

    const fraudFlags: string[] = [...classification.adulterationFlags];
    if (replay.replayDetected) {
      fraudFlags.push(replay.replayType);
    }
    for (const qw of forensics.qualityWarnings) {
      fraudFlags.push(qw);
    }

    const material =
      (await prisma.materialCategory.findUnique({
        where: { slug: classification.materialSlug },
      })) ?? (await prisma.materialCategory.findFirstOrThrow());

    // Fetch live active storefront rate cards across all open tiers (T1..T4)
    const activeRates = await prisma.storefrontRateItem.findMany({
      where: {
        materialId: material.id,
        isActive: true,
        storefront: { isOpen: true },
      },
      include: {
        storefront: {
          include: {
            organization: {
              select: {
                businessName: true,
                tier: true,
                city: true,
                verificationLevel: true,
                platformCode: true,
              },
            },
          },
        },
      },
      orderBy: { dropoffRatePaise: "asc" },
    });

    const tierMatches = activeRates.map((ri) => ({
      storefrontId: ri.storefrontId,
      shopTitle: ri.storefront.shopTitle,
      tier: ri.storefront.organization.tier,
      platformCode: ri.storefront.organization.platformCode,
      verificationLevel: ri.storefront.organization.verificationLevel,
      pickupRatePaise: ri.pickupRatePaise,
      dropoffRatePaise: ri.dropoffRatePaise,
      estimatedPayoutPickupPaise: calculateAmountPaise(
        meta.estimatedGrams,
        ri.pickupRatePaise,
        material.defaultUnit
      ),
      estimatedPayoutDropoffPaise: calculateAmountPaise(
        meta.estimatedGrams,
        ri.dropoffRatePaise,
        material.defaultUnit
      ),
    }));

    const minRate = activeRates[0]?.pickupRatePaise ?? 2000;
    const maxRate =
      activeRates[activeRates.length - 1]?.dropoffRatePaise ?? Math.round(minRate * 1.25);
    const indicativeMinPaise = calculateAmountPaise(
      meta.estimatedGrams,
      minRate,
      material.defaultUnit
    );
    const indicativeMaxPaise = calculateAmountPaise(
      meta.estimatedGrams,
      maxRate,
      material.defaultUnit
    );

    const estimatedKg = (meta.estimatedGrams / 1000).toFixed(2);
    const spokenScripts = buildVisionScanSpeech({
      materialNames: material,
      estimatedKg,
      minInr: paiseToInrString(indicativeMinPaise),
      maxInr: paiseToInrString(indicativeMaxPaise),
      confidencePct: Math.round(classification.confidence * 100),
      fraudFlags,
      hazardWarning: material.isRegulatedHazardous ? material.handlingGuidance : null,
      lang: meta.language,
    });

    const provenancePayload = {
      priceType: "INDICATIVE_ESTIMATE" as const,
      requiresHumanConfirmation: true,
      dataset7Provenance: {
        modelName: "KabadiVision Spectral + Forensics Classifier",
        modelVersion: VISION_MODEL_VERSION,
        evaluatedAt: new Date().toISOString(),
        trainingDomain: "Indian Scrap Streams (Cu/Al Coils, Grade-A PCBs, Kraft Moisture, Charred Wire)",
        uncertaintyReason: classification.uncertaintyReason,
      },
      detectedMaterial: {
        slug: material.slug,
        nameEn: material.nameEn,
        nameHi: material.nameHi,
        namePa: material.namePa,
        nameMr: material.nameMr,
        streamGroup: material.streamGroup,
        isRegulatedHazardous: material.isRegulatedHazardous,
        handlingGuidance: material.handlingGuidance,
        subtypeLabel: classification.materialSubtypeLabel,
        coilMetalVerdict: classification.coilMetalVerdict,
      },
      confidence: classification.confidence,
      estimatedGrams: meta.estimatedGrams,
      indicativeRange: {
        minPaise: indicativeMinPaise,
        maxPaise: indicativeMaxPaise,
        displayInr: `₹${paiseToInrString(indicativeMinPaise)} – ₹${paiseToInrString(indicativeMaxPaise)}`,
      },
      antiFraudForensics: {
        fraudRiskLevel:
          replay.replayDetected || classification.adulterationFlags.length > 0
            ? "HIGH"
            : forensics.qualityWarnings.length > 0
              ? "MEDIUM"
              : "LOW",
        fraudFlags,
        replayCheck: replay,
        imageForensics: forensics,
        spectralMetrics: classification.spectralMetrics,
        onnxInference: classification.onnxInference,
        realPhotoGate: classification.realPhotoGate,
        realPhotoGateDisagrees: classification.realPhotoGateDisagrees,
      },
      liveMultiTierStorefrontMatches: tierMatches,
      vernacularAudioScripts: spokenScripts,
      honestDisclaimer:
        "Indicative camera AI estimate only — requires human confirmation and verified physical weighing before final settlement.",
    };

    const scanRecord = await prisma.aIScanRecord.create({
      data: {
        actorId: actor.id,
        scanType: "MATERIAL_CLASSIFICATION",
        modelVersion: VISION_MODEL_VERSION,
        confidence: classification.confidence,
        requiresHumanConfirm: true,
        imageSha256: forensics.imageSha256,
        perceptualHash: forensics.perceptualHash64,
        mediaStorageKey: storageKey,
        structuredResultJson: JSON.parse(JSON.stringify(provenancePayload)),
        indicativeMinPaise,
        indicativeMaxPaise,
      },
    });

    if (fraudFlags.length > 0) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "AI_FRAUD_OR_ADULTERATION_FLAGGED",
        resourceType: "AIScanRecord",
        resourceId: scanRecord.id,
        outcome: "SUCCESS",
        reason: `Flags: ${fraudFlags.join(", ")}`,
        metadata: {
          materialSlug: material.slug,
          fraudFlags,
          replayMatchedScanId: replay.matchedScanId,
        },
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
    }

    sendSuccess(res, { scanId: scanRecord.id, ...provenancePayload }, 201);
  }
);

// POST /api/v1/ai/scale-ocr — Digital Scale 7-Segment Pixel OCR & Discrepancy / Replay Anti-Fraud Verifier
aiRouter.post(
  "/scale-ocr",
  authenticate,
  requireCapability("ai:scan"),
  uploadSingleImage.single("image"),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();

    const extracted = extractSubmittedImageBuffer(req);
    if (extracted.tooLarge) {
      sendError(res, 413, "IMAGE_TOO_LARGE", "Scale frame exceeds 5 MB upload cap");
      return;
    }
    if (!extracted.buffer) {
      sendError(
        res,
        400,
        "SCALE_IMAGE_REQUIRED",
        "Upload a digital scale photo (JPEG, PNG, or WebP) under field 'image' or JSON 'imageBase64'"
      );
      return;
    }

    const verifiedMime = detectVerifiedMimeFromMagicBytes(extracted.buffer);
    if (!verifiedMime || verifiedMime === "application/pdf") {
      sendError(
        res,
        400,
        "INVALID_IMAGE_SIGNATURE",
        "Uploaded scale file does not match valid JPEG, PNG, or WebP magic bytes"
      );
      return;
    }

    const parsedFields = ScaleOcrVerifyFieldsSchema.safeParse(req.body ?? {});
    if (!parsedFields.success) {
      sendError(
        res,
        400,
        "VALIDATION_FAILED",
        "Invalid scale verification parameters",
        parsedFields.error.flatten().fieldErrors
      );
      return;
    }

    const { declaredGrams, orderId } = parsedFields.data;
    const forensics = await analyzeImageForensics(extracted.buffer);
    const replay = await detectImageReplayFraud(
      forensics.imageSha256,
      forensics.perceptualHash64
    );
    const ocr = await readDigitalScalePixels(extracted.buffer);
    const storageKey = persistPrivateScanImage(extracted.buffer, verifiedMime);

    const toleranceGrams = Math.max(150, Math.round(declaredGrams * 0.03));
    const deltaGrams =
      ocr.scaleReadGrams !== null ? Math.abs(ocr.scaleReadGrams - declaredGrams) : null;

    const ocrDiscrepancyFlag =
      !ocr.readable || (deltaGrams !== null && deltaGrams > toleranceGrams);

    const fraudFlags: string[] = [];
    if (replay.replayDetected) fraudFlags.push(replay.replayType);
    if (!ocr.readable) fraudFlags.push("UNREADABLE_SCALE_DISPLAY");
    if (deltaGrams !== null && deltaGrams > toleranceGrams) {
      fraudFlags.push("SCALE_WEIGHT_MISMATCH");
    }

    const declaredKg = (declaredGrams / 1000).toFixed(2);
    const ocrKg =
      ocr.scaleReadGrams !== null ? (ocr.scaleReadGrams / 1000).toFixed(2) : null;

    const vernacularVerdict = buildScaleVerdictSpeech({
      declaredKg,
      ocrKg,
      discrepancyFlag: ocrDiscrepancyFlag,
      replayFlag: replay.replayDetected,
    });

    const resultPayload = {
      modelVersion: SCALE_OCR_MODEL_VERSION,
      declaredGrams,
      scaleReadGrams: ocr.scaleReadGrams,
      scaleDisplayText: ocr.rawDigitsText,
      displayMode: ocr.displayMode,
      toleranceGrams,
      deltaGrams,
      ocrDiscrepancyFlag,
      replayFraudDetected: replay.replayDetected,
      verdictStatus:
        replay.replayDetected || ocrDiscrepancyFlag
          ? "HOLD_AND_REWEIGH_REQUIRED"
          : "VERIFIED_WITHIN_TOLERANCE",
      confidence: ocr.confidence,
      fraudFlags,
      replayCheck: replay,
      imageForensics: forensics,
      vernacularAudioScripts: vernacularVerdict,
      orderId: orderId ?? null,
    };

    const scanRecord = await prisma.aIScanRecord.create({
      data: {
        actorId: actor.id,
        scanType: "SCALE_OCR_CHECK",
        modelVersion: SCALE_OCR_MODEL_VERSION,
        confidence: ocr.confidence,
        requiresHumanConfirm: true,
        imageSha256: forensics.imageSha256,
        perceptualHash: forensics.perceptualHash64,
        mediaStorageKey: storageKey,
        structuredResultJson: JSON.parse(JSON.stringify(resultPayload)),
      },
    });

    if (ocrDiscrepancyFlag || replay.replayDetected) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "SCALE_OCR_ANOMALY_FLAGGED",
        resourceType: "AIScanRecord",
        resourceId: scanRecord.id,
        outcome: "SUCCESS",
        reason: `Flags: ${fraudFlags.join(", ")} (Declared ${declaredGrams}g vs Read ${ocr.scaleReadGrams ?? "null"}g)`,
        metadata: {
          orderId: orderId ?? null,
          declaredGrams,
          scaleReadGrams: ocr.scaleReadGrams,
          fraudFlags,
        },
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
    }

    sendSuccess(res, { scanId: scanRecord.id, ...resultPayload }, 201);
  }
);

// POST /api/v1/ai/scans/:scanId/confirm — Human-in-the-loop confirmation (Architecture v0.2 Section 6.3)
aiRouter.post("/scans/:scanId/confirm", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const scan = await prisma.aIScanRecord.findUnique({
    where: { id: String(req.params.scanId) },
  });

  if (!scan) {
    sendError(res, 404, "SCAN_NOT_FOUND", "AI scan record not found");
    return;
  }

  if (scan.actorId !== actor.id && actor.role !== "ADMIN") {
    sendError(res, 403, "FORBIDDEN", "You can only confirm your own AI scan records");
    return;
  }

  const updated = await prisma.aIScanRecord.update({
    where: { id: scan.id },
    data: { humanConfirmedAt: new Date() },
  });

  sendSuccess(res, { scan: updated });
});

// GET /api/v1/ai/scans — Retrieve AI Provenance History (Own scans, or all scans for Admin)
aiRouter.get("/scans", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();

  const scans = await prisma.aIScanRecord.findMany({
    where: actor.role === "ADMIN" ? {} : { actorId: actor.id },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  sendSuccess(res, { scans });
});

// POST /api/v1/ai/speech-script — 4-Language Vernacular Spoken Audio Script Builder (EN / HI / PA / MR)
aiRouter.post(
  "/speech-script",
  validateBody(VernacularSpeechScriptRequestSchema),
  async (req, res) => {
    const prisma = await getPrisma();
    const { contextType, language, storefrontId, scanId } = req.body;

    if (contextType === "STOREFRONT_RATES" && storefrontId) {
      const sf = await prisma.storefront.findUnique({
        where: { id: storefrontId },
        include: {
          organization: { select: { tier: true } },
          rateItems: {
            where: { isActive: true },
            include: { material: true },
            orderBy: { pickupRatePaise: "desc" },
          },
        },
      });
      if (!sf) {
        sendError(res, 404, "STOREFRONT_NOT_FOUND", "Storefront not found");
        return;
      }

      const built = buildStorefrontSpeechScript(
        sf.shopTitle,
        sf.organization.tier,
        sf.rateItems.map((ri) => ({
          nameEn: ri.material.nameEn,
          nameHi: ri.material.nameHi,
          namePa: ri.material.namePa,
          nameMr: ri.material.nameMr,
          pickupRateInr: (ri.pickupRatePaise / 100).toFixed(0),
          dropoffRateInr: (ri.dropoffRatePaise / 100).toFixed(0),
          unit: ri.material.defaultUnit,
          isRegulatedHazardous: ri.material.isRegulatedHazardous,
        })),
        language
      );

      sendSuccess(res, {
        language,
        locale: built.locale,
        script: built.script,
      });
      return;
    }

    if (scanId) {
      const scan = await prisma.aIScanRecord.findUnique({ where: { id: scanId } });
      if (!scan) {
        sendError(res, 404, "SCAN_NOT_FOUND", "AI scan record not found");
        return;
      }
      const json = scan.structuredResultJson as Record<string, unknown>;
      const scripts = (json?.vernacularAudioScripts ?? {}) as Record<string, string>;
      sendSuccess(res, {
        language,
        locale: voiceLocaleForLanguage(language),
        script: scripts[language] ?? scripts.EN ?? "Scan complete.",
      });
      return;
    }

    sendError(res, 400, "MISSING_TARGET_ID", "Provide storefrontId or scanId for speech synthesis");
  }
);

// ============================================================================
// SELF-HOSTED AI SUITE v2: CAMERA PHOTO X-RAY CNN, VERNACULAR NLU & MANDI AI
// ============================================================================

const CameraOrTextXraySchema = z
  .object({
    deviceQuery: z.string().trim().min(1).max(160).optional(),
    observedCondition: z
      .enum([
        "POWERS_ON_INTACT",
        "CRACKED_SCREEN_BOOTS",
        "DEAD_BOOT_INTACT_BODY",
        "HEAVILY_DAMAGED_SCRAP",
      ])
      .optional(),
    coilTypeHint: z.enum(["UNKNOWN", "COPPER", "ALUMINUM"]).optional(),
    city: z.string().trim().max(64).optional(),
    imageBase64: z.string().max(7_000_000).optional(),
  })
  .strict();

// POST /api/v1/ai/xray-estimate — Camera Photo 2D-CNN Multi-Task X-Ray + Live Mandi Component Valuation
aiRouter.post(
  "/xray-estimate",
  authenticate,
  aiRateLimiter,
  requireCapability("ai:scan"),
  uploadSingleImage.single("image"),
  async (req, res, next) => {
    try {
      const actor = req.actor!;
      const parsed = CameraOrTextXraySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendError(
          res,
          400,
          "VALIDATION_FAILED",
          "Invalid X-Ray request payload",
          parsed.error.flatten().fieldErrors
        );
        return;
      }

      const extracted = extractSubmittedImageBuffer(req);
      if (extracted.tooLarge) {
        sendError(res, 413, "IMAGE_TOO_LARGE", "Appliance photo exceeds 5 MB upload cap");
        return;
      }

      if (!extracted.buffer && !parsed.data.deviceQuery) {
        sendError(
          res,
          400,
          "IMAGE_OR_QUERY_REQUIRED",
          "Provide a camera photo (`image` / `imageBase64`) or `deviceQuery`"
        );
        return;
      }

      let storageKey: string | null = null;
      if (extracted.buffer) {
        const mime = detectVerifiedMimeFromMagicBytes(extracted.buffer);
        if (!mime || mime === "application/pdf") {
          sendError(
            res,
            400,
            "INVALID_IMAGE_SIGNATURE",
            "Uploaded appliance file header is not a valid JPEG, PNG, or WebP photo"
          );
          return;
        }
        storageKey = persistPrivateScanImage(extracted.buffer, mime);
      }

      const result = await runCameraDeviceXrayValuation({
        actorId: actor.id,
        imageBuffer: extracted.buffer,
        mediaStorageKey: storageKey,
        deviceQuery: parsed.data.deviceQuery,
        observedCondition: parsed.data.observedCondition,
        coilTypeHint: parsed.data.coilTypeHint,
      });

      sendSuccess(res, result, extracted.buffer ? 201 : 200);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/market-intelligence — Neural 7d/14d Mandi Rate Forecasts & Under-Pricing Alerts
aiRouter.get("/market-intelligence", async (req, res, next) => {
  try {
    const city =
      typeof req.query.city === "string" && req.query.city.trim().length > 0
        ? req.query.city.trim().slice(0, 64)
        : undefined;
    const intel = await getMandiMarketIntelligence(city);
    sendSuccess(res, intel);
  } catch (err) {
    next(err);
  }
});

const SmartMatchRequestSchema = z
  .object({
    city: z.string().trim().max(64).optional(),
    pincode: z.string().trim().max(10).optional(),
    fulfillmentMode: z.enum(["BUYER_PICKUP", "SELLER_DROPOFF"]).optional(),
    items: z
      .array(
        z
          .object({
            materialSlug: z.string().trim().min(2).max(80),
            weightGrams: z.number().int().min(100).max(50_000_000),
          })
          .strict()
      )
      .min(1)
      .max(20),
  })
  .strict();

// POST /api/v1/ai/smart-match — Multi-Tier CPCB-Aware Smart Buyer Matching Engine
aiRouter.post(
  "/smart-match",
  validateBody(SmartMatchRequestSchema),
  async (req, res, next) => {
    try {
      const match = await runSmartBuyerMatch(req.body);
      sendSuccess(res, match);
    } catch (err) {
      next(err);
    }
  }
);

const VernacularAssistantSchema = z
  .object({
    message: z.string().trim().min(2).max(1200),
    language: z.enum(["EN", "HI", "PA", "MR"]).optional(),
    autoCreateListing: z.boolean().optional(),
  })
  .strict();

// POST /api/v1/ai/assistant — Multilingual Voice/Chat Kabadi Assistant (HI / PA / MR / EN)
aiRouter.post(
  "/assistant",
  validateBody(VernacularAssistantSchema),
  async (req, res, next) => {
    try {
      let actorId: string | undefined;
      let actorTier: string | undefined;

      const authHeader = req.headers.authorization;
      const bearer =
        authHeader && authHeader.startsWith("Bearer ")
          ? authHeader.slice(7).trim()
          : req.cookies?.kc_access_token;

      if (typeof bearer === "string" && bearer.length > 10) {
        const claims = verifyAccessToken(bearer);
        if (claims) {
          const prisma = await getPrisma();
          const u = await prisma.user.findUnique({
            where: { id: claims.sub },
            select: { id: true, tier: true, accountStatus: true },
          });
          if (u && u.accountStatus === "ACTIVE") {
            actorId = u.id;
            actorTier = u.tier;
          }
        }
      }

      if (req.body.autoCreateListing && !actorId) {
        sendError(
          res,
          401,
          "AUTH_REQUIRED_FOR_BOOKING",
          "Sign in first to create a live broadcast pickup listing from chat"
        );
        return;
      }

      const response = await runVernacularAiAssistant({
        actorId,
        actorTier,
        message: req.body.message,
        language: req.body.language,
        autoCreateListing: req.body.autoCreateListing,
      });

      sendSuccess(res, response);
    } catch (err) {
      next(err);
    }
  }
);
