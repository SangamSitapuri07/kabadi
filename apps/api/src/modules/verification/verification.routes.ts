import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { SubmitVerificationCaseSchema } from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import {
  createShortLivedSignedDownloadToken,
  detectVerifiedMimeFromMagicBytes,
  sha256Hex,
  verifyShortLivedSignedDownloadToken,
} from "../../lib/security";
import {
  authenticate,
  requireCapability,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";

import { WORKSPACE_ROOT } from "../../lib/paths";

export const verificationRouter = Router();

const PRIVATE_STORAGE_ROOT = path.join(
  WORKSPACE_ROOT,
  ".storage-private",
  "kyc-documents"
);

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB max upload cap (Section 8.7)
    files: 1,
  },
});

// POST /api/v1/verification/cases — Submit Verification Application (Never Auto-Approved!)
verificationRouter.post(
  "/cases",
  authenticate,
  requireCapability("verification:submit"),
  validateBody(SubmitVerificationCaseSchema),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const body = req.body;

    // Only AUTHORISED_RECYCLER accounts can apply for LEVEL_4_AUTHORISED_RECYCLER
    if (
      body.requestedLevel === "LEVEL_4_AUTHORISED_RECYCLER" &&
      actor.role !== "AUTHORISED_RECYCLER"
    ) {
      sendError(
        res,
        403,
        "INELIGIBLE_ROLE_FOR_RECYCLER_VERIFICATION",
        "Only Authorised Recycler accounts may request Level 4 recycler verification"
      );
      return;
    }

    const org = await prisma.organization.findUnique({
      where: { ownerUserId: actor.id },
    });

    if (
      body.requestedLevel === "LEVEL_4_AUTHORISED_RECYCLER" &&
      org &&
      body.registrationNumber
    ) {
      await prisma.recyclerRegistration.upsert({
        where: { organizationId: org.id },
        update: {
          authorityName: body.issuingAuthority ?? "CPCB / State SPCB",
          registrationNumber: body.registrationNumber,
          permittedStreams: body.permittedStreams ?? ["EWASTE"],
          cpcbPortalChecked: false,
        },
        create: {
          organizationId: org.id,
          authorityName: body.issuingAuthority ?? "CPCB / State SPCB",
          registrationNumber: body.registrationNumber,
          permittedStreams: body.permittedStreams ?? ["EWASTE"],
          cpcbPortalChecked: false,
        },
      });
    } else if (
      body.requestedLevel === "LEVEL_3_BUSINESS_VERIFIED" &&
      org &&
      body.registrationNumber
    ) {
      await prisma.businessRegistration.upsert({
        where: { organizationId: org.id },
        update: {
          registrationType: body.registrationType ?? "SHOP_ACT_UDYAM",
          registrationNumber: body.registrationNumber,
          issuingAuthority: body.issuingAuthority ?? "Municipal / MSME Authority",
        },
        create: {
          organizationId: org.id,
          registrationType: body.registrationType ?? "SHOP_ACT_UDYAM",
          registrationNumber: body.registrationNumber,
          issuingAuthority: body.issuingAuthority ?? "Municipal / MSME Authority",
        },
      });
    }

    const createdCase = await prisma.verificationCase.create({
      data: {
        applicantId: actor.id,
        requestedLevel: body.requestedLevel,
        status: "PENDING", // Strictly PENDING until reviewed by an Admin!
        notes: body.notes ?? null,
      },
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "VERIFICATION_CASE_SUBMITTED",
      resourceType: "VerificationCase",
      resourceId: createdCase.id,
      outcome: "SUCCESS",
      metadata: { requestedLevel: body.requestedLevel },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { verificationCase: createdCase }, 201);
  }
);

// GET /api/v1/verification/cases — Own cases only (Admin uses /admin/verification/cases)
verificationRouter.get("/cases", authenticate, async (req, res) => {
  const prisma = await getPrisma();
  const cases = await prisma.verificationCase.findMany({
    where: { applicantId: req.actor!.id },
    include: {
      documents: {
        select: {
          id: true,
          documentKind: true,
          detectedMime: true,
          sizeBytes: true,
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

// GET /api/v1/verification/cases/:caseId — Enforces Object-Level Ownership (BOLA Defense)
verificationRouter.get("/cases/:caseId", authenticate, async (req, res) => {
  const prisma = await getPrisma();
  const actor = req.actor!;
  const vCase = await prisma.verificationCase.findUnique({
    where: { id: String(req.params.caseId) },
    include: {
      documents: {
        select: {
          id: true,
          documentKind: true,
          detectedMime: true,
          sizeBytes: true,
          uploadedAt: true,
        },
      },
      decisions: true,
    },
  });

  if (!vCase) {
    sendError(res, 404, "CASE_NOT_FOUND", "Verification case not found");
    return;
  }

  if (vCase.applicantId !== actor.id && actor.role !== "ADMIN") {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "BOLA_VERIFICATION_CASE_DENIED",
      resourceType: "VerificationCase",
      resourceId: vCase.id,
      outcome: "DENIED",
      reason: "Attempted unauthorized read of another user's KYC verification case",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(res, 403, "FORBIDDEN", "Not authorised to view this verification case");
    return;
  }

  sendSuccess(res, { verificationCase: vCase });
});

// POST /api/v1/verification/cases/:caseId/documents — Magic-Byte Checked Private Upload
verificationRouter.post(
  "/cases/:caseId/documents",
  authenticate,
  uploadMemory.single("document"),
  async (req, res) => {
    const actor = req.actor!;
    const prisma = await getPrisma();
    const caseId = String(req.params.caseId);

    const vCase = await prisma.verificationCase.findUnique({
      where: { id: caseId },
    });

    if (!vCase) {
      sendError(res, 404, "CASE_NOT_FOUND", "Verification case not found");
      return;
    }

    if (vCase.applicantId !== actor.id) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "BOLA_KYC_UPLOAD_DENIED",
        resourceType: "VerificationCase",
        resourceId: caseId,
        outcome: "DENIED",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(res, 403, "FORBIDDEN", "Cannot upload documents to another user's case");
      return;
    }

    if (!req.file || !req.file.buffer) {
      sendError(res, 400, "MISSING_FILE", "A verification document file is required");
      return;
    }

    // Validate actual binary magic bytes — never trust filename or browser MIME header!
    const verifiedMime = detectVerifiedMimeFromMagicBytes(req.file.buffer);
    if (!verifiedMime) {
      await recordAuditEvent({
        actorId: actor.id,
        actorRole: actor.role,
        action: "MALICIOUS_OR_UNSUPPORTED_UPLOAD_REJECTED",
        resourceType: "VerificationDocument",
        resourceId: caseId,
        outcome: "DENIED",
        reason: "Uploaded file binary signature failed magic-byte inspection",
        metadata: {
          claimedMime: req.file.mimetype,
          sizeBytes: req.file.size,
        },
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendError(
        res,
        400,
        "UNSUPPORTED_FILE_CONTENT",
        "Only genuine JPEG, PNG, WebP images or PDF files are accepted"
      );
      return;
    }

    fs.mkdirSync(PRIVATE_STORAGE_ROOT, { recursive: true });
    // Server-generated random storage key outside public web directories
    const randomKey = `${crypto.randomUUID()}.bin`;
    const fullDiskPath = path.join(PRIVATE_STORAGE_ROOT, randomKey);
    fs.writeFileSync(fullDiskPath, req.file.buffer, { mode: 0o600 });

    const docKind =
      typeof req.body?.documentKind === "string"
        ? req.body.documentKind.slice(0, 40)
        : "VERIFICATION_EVIDENCE";

    const doc = await prisma.verificationDocument.create({
      data: {
        caseId: vCase.id,
        documentKind: docKind,
        storageKey: randomKey,
        detectedMime: verifiedMime,
        sizeBytes: req.file.size,
        sha256Digest: sha256Hex(req.file.buffer),
      },
      select: {
        id: true,
        caseId: true,
        documentKind: true,
        detectedMime: true,
        sizeBytes: true,
        sha256Digest: true,
        uploadedAt: true,
      },
    });

    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "KYC_DOCUMENT_UPLOADED",
      resourceType: "VerificationDocument",
      resourceId: doc.id,
      outcome: "SUCCESS",
      metadata: { detectedMime: verifiedMime, sizeBytes: doc.sizeBytes },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, { document: doc }, 201);
  }
);

// POST /api/v1/verification/documents/:docId/signed-link — Short-Lived 60s Signed Access Link
verificationRouter.post("/documents/:docId/signed-link", authenticate, async (req, res) => {
  const actor = req.actor!;
  const prisma = await getPrisma();
  const doc = await prisma.verificationDocument.findUnique({
    where: { id: String(req.params.docId) },
    include: { verificationCase: true },
  });

  if (!doc) {
    sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
    return;
  }

  if (doc.verificationCase.applicantId !== actor.id && actor.role !== "ADMIN") {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "PRIVATE_KYC_DOC_ACCESS_DENIED",
      resourceType: "VerificationDocument",
      resourceId: doc.id,
      outcome: "DENIED",
      reason: "Unauthorized attempt to request private verification document URL",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    sendError(res, 403, "FORBIDDEN", "Not authorised to access this private document");
    return;
  }

  const { token, expiresAtEpochSec } = createShortLivedSignedDownloadToken({
    documentId: doc.id,
    recipientUserId: actor.id,
    ttlSeconds: 60, // Short-lived 60-second signed link (Section 8.7)
  });

  if (actor.role === "ADMIN") {
    await recordAuditEvent({
      actorId: actor.id,
      actorRole: actor.role,
      action: "ADMIN_ISSUED_PRIVATE_DOC_SIGNED_LINK",
      resourceType: "VerificationDocument",
      resourceId: doc.id,
      outcome: "SUCCESS",
      metadata: { applicantId: doc.verificationCase.applicantId },
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
  }

  sendSuccess(res, {
    downloadPath: `/api/v1/verification/documents/${doc.id}/download?sig=${encodeURIComponent(
      token
    )}`,
    expiresAtEpochSec,
  });
});

// GET /api/v1/verification/documents/:docId/download?sig=...
verificationRouter.get("/documents/:docId/download", authenticate, async (req, res) => {
  const actor = req.actor!;
  const sig = typeof req.query.sig === "string" ? req.query.sig : "";

  const prisma = await getPrisma();
  const doc = await prisma.verificationDocument.findUnique({
    where: { id: String(req.params.docId) },
  });

  if (!doc) {
    sendError(res, 404, "DOCUMENT_NOT_FOUND", "Document not found");
    return;
  }

  const validSig = verifyShortLivedSignedDownloadToken({
    token: sig,
    documentId: doc.id,
    recipientUserId: actor.id,
  });

  if (!validSig) {
    sendError(
      res,
      403,
      "SIGNED_LINK_EXPIRED_OR_INVALID",
      "Signed download link is invalid, expired, or bound to another account"
    );
    return;
  }

  const fullDiskPath = path.join(PRIVATE_STORAGE_ROOT, path.basename(doc.storageKey));
  if (!fs.existsSync(fullDiskPath)) {
    sendError(res, 404, "FILE_MISSING", "Stored object unavailable");
    return;
  }

  res.setHeader("Content-Type", doc.detectedMime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.send(fs.readFileSync(fullDiskPath));
});
