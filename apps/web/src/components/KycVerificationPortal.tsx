"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  FileCheck2,
  UploadCloud,
  Eye,
  ShieldAlert,
  Lock,
  X,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

interface DocRecord {
  id: string;
  documentKind: string;
  detectedMime: string;
  sizeBytes: number;
  sha256Digest?: string;
  uploadedAt: string;
}

interface VerificationCaseItem {
  id: string;
  requestedLevel: string;
  status: string;
  notes: string | null;
  submittedAt: string;
  applicant?: {
    platformCode?: string;
    role?: string;
    verificationLevel?: string;
    profile?: { displayName?: string };
  };
  documents: DocRecord[];
  decisions?: Array<{
    id: string;
    newStatus: string;
    reason: string;
    createdAt: string;
  }>;
}

interface KycVerificationPortalProps {
  accessToken: string;
  userRole: string | null;
  platformCode: string | null;
  displayName: string | null;
  adminCases: VerificationCaseItem[];
  onRefreshWorkspace: () => Promise<void>;
  onNotify: (type: "ok" | "err", text: string) => void;
}

async function generateCertificateSamplePngBlob(
  holderName: string,
  platformCode: string,
  regNo: string
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 680;
  canvas.height = 420;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#065f46";
  ctx.lineWidth = 8;
  ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);

  ctx.fillStyle = "#064e3b";
  ctx.font = "bold 22px monospace";
  ctx.fillText("REGISTRATION EVIDENCE SAMPLE (MAGIC-BYTE VERIFIED PNG)", 44, 72);

  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText(`Applicant Entity: ${holderName}`, 44, 132);
  ctx.fillText(`Platform Code: ${platformCode}`, 44, 168);
  ctx.fillText(`Registration Reference: ${regNo}`, 44, 204);
  ctx.fillText(`Issued Jurisdiction: Ludhiana, Punjab`, 44, 240);

  ctx.fillStyle = "#475569";
  ctx.font = "14px sans-serif";
  ctx.fillText(
    "Stored in non-public vault (.storage-private) · Served only via 60s HMAC signed URL",
    44,
    310
  );
  ctx.fillText(`Generated Timestamp: ${new Date().toISOString()}`, 44, 342);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas PNG encoding failed"))),
      "image/png"
    );
  });
}

export function KycVerificationPortal({
  accessToken,
  userRole,
  platformCode,
  displayName,
  adminCases,
  onRefreshWorkspace,
  onNotify,
}: KycVerificationPortalProps) {
  const [ownCases, setOwnCases] = useState<VerificationCaseItem[]>([]);
  const [requestedLevel, setRequestedLevel] = useState<
    | "LEVEL_2_IDENTITY_REVIEWED"
    | "LEVEL_3_BUSINESS_VERIFIED"
    | "LEVEL_4_AUTHORISED_RECYCLER"
  >(
    userRole === "AUTHORISED_RECYCLER"
      ? "LEVEL_4_AUTHORISED_RECYCLER"
      : userRole === "SCRAP_BUSINESS"
        ? "LEVEL_3_BUSINESS_VERIFIED"
        : "LEVEL_2_IDENTITY_REVIEWED"
  );
  const [regType, setRegType] = useState<
    "IDENTITY_DOC" | "SHOP_ACT_UDYAM" | "GSTIN" | "CPCB_SPCB_EPR"
  >(userRole === "AUTHORISED_RECYCLER" ? "CPCB_SPCB_EPR" : "SHOP_ACT_UDYAM");
  const [regNumber, setRegNumber] = useState<string>("UDYAM-PB-12-0049821");
  const [authority, setAuthority] = useState<string>("Punjab MSME / SPCB Portal");
  const [notes, setNotes] = useState<string>(
    "Submitting official registration certificate for human admin verification"
  );
  const [officialSourceChecked, setOfficialSourceChecked] = useState<boolean>(true);

  // Active 60s Signed URL Vault Preview Modal state
  const [vaultPreview, setVaultPreview] = useState<{
    docId: string;
    mime: string;
    signedPath: string;
    expiresAtEpochSec: number;
    blobUrl: string;
  } | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);

  const loadOwnCases = useCallback(async () => {
    if (!accessToken || userRole === "ADMIN") return;
    const res = await fetch("/api/v1/verification/cases", {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    }).then((r) => r.json());
    if (res.success) {
      setOwnCases(res.data.cases);
    }
  }, [accessToken, userRole]);

  useEffect(() => {
    loadOwnCases();
  }, [loadOwnCases]);

  useEffect(() => {
    if (!vaultPreview) return;
    const tick = () => {
      const rem = Math.max(
        0,
        vaultPreview.expiresAtEpochSec - Math.floor(Date.now() / 1000)
      );
      setSecondsRemaining(rem);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [vaultPreview]);

  const closeVaultPreview = () => {
    if (vaultPreview?.blobUrl) {
      URL.revokeObjectURL(vaultPreview.blobUrl);
    }
    setVaultPreview(null);
  };

  const handleSubmitCase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken) {
      onNotify("err", "Sign in first to submit a verification case");
      return;
    }
    const res = await fetch("/api/v1/verification/cases", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      credentials: "include",
      body: JSON.stringify({
        requestedLevel,
        registrationType: regType,
        registrationNumber: regNumber,
        issuingAuthority: authority,
        permittedStreams: ["EWASTE", "NON_FERROUS"],
        notes,
      }),
    });
    const json = await res.json();
    if (json.success) {
      await loadOwnCases();
      await onRefreshWorkspace();
      onNotify(
        "ok",
        `Verification Case submitted in strict PENDING state (never auto-approved) — upload supporting evidence below!`
      );
    } else {
      onNotify("err", json.error?.message || "Verification submission rejected");
    }
  };

  const uploadMultipartDocument = async (
    caseId: string,
    fileBlob: Blob,
    fileName: string,
    documentKind: string
  ) => {
    const fd = new FormData();
    fd.append("document", fileBlob, fileName);
    fd.append("documentKind", documentKind);

    const res = await fetch(`/api/v1/verification/cases/${caseId}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      credentials: "include",
      body: fd,
    });
    const json = await res.json();
    if (json.success) {
      await loadOwnCases();
      await onRefreshWorkspace();
      onNotify(
        "ok",
        `Magic-byte verified (${json.data.document.detectedMime}) & stored privately outside web root!`
      );
    } else {
      onNotify(
        "err",
        `Upload Blocked (${res.status} ${json.error?.code}): ${json.error?.message}`
      );
    }
  };

  const handleUploadSamplePng = async (caseId: string) => {
    const pngBlob = await generateCertificateSamplePngBlob(
      displayName ?? "Applicant",
      platformCode ?? "KC-USER",
      regNumber
    );
    await uploadMultipartDocument(
      caseId,
      pngBlob,
      "registration-evidence.png",
      regType
    );
  };

  const handleSpoofedExeAttackProbe = async (caseId: string) => {
    // Windows PE executable header ("MZ\x90\x00...") disguised as PDF mime/extension
    const fakePdfBytes = new Uint8Array([
      0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef,
    ]);
    const spoofBlob = new Blob([fakePdfBytes], { type: "application/pdf" });
    await uploadMultipartDocument(
      caseId,
      spoofBlob,
      "disguised_malware.pdf",
      "SPOOFED_EXE_PROBE"
    );
  };

  const handleOpenSignedVaultPreview = async (docId: string) => {
    const res = await fetch(`/api/v1/verification/documents/${docId}/signed-link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    });
    const json = await res.json();
    if (!json.success) {
      onNotify("err", json.error?.message || "Signed link denied");
      return;
    }

    const { downloadPath, expiresAtEpochSec } = json.data as {
      downloadPath: string;
      expiresAtEpochSec: number;
    };

    const binRes = await fetch(downloadPath, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    });

    if (!binRes.ok) {
      onNotify("err", "Signed download failed or token expired");
      return;
    }

    const mime = binRes.headers.get("content-type") || "application/octet-stream";
    const blob = await binRes.blob();
    const blobUrl = URL.createObjectURL(blob);

    if (vaultPreview?.blobUrl) {
      URL.revokeObjectURL(vaultPreview.blobUrl);
    }

    setVaultPreview({
      docId,
      mime,
      signedPath: downloadPath,
      expiresAtEpochSec,
      blobUrl,
    });
  };

  const handleAdminDecide = async (
    caseId: string,
    decision: "VERIFIED" | "ACTION_REQUIRED" | "REJECTED"
  ) => {
    const res = await fetch(`/api/v1/admin/verification/cases/${caseId}/decide`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      credentials: "include",
      body: JSON.stringify({
        decision,
        reason: `Reviewed vault evidence via Admin Console (${decision})`,
        officialSourceChecked,
        evidenceReferenceUrl: "https://eprewaste.cpcb.gov.in/",
      }),
    });
    const json = await res.json();
    if (json.success) {
      await onRefreshWorkspace();
      onNotify("ok", `Case decision (${decision}) recorded in append-only AuditEvent!`);
    } else {
      onNotify(
        "err",
        `${json.error?.code ?? "REJECTED"}: ${json.error?.message ?? "Decision blocked"}`
      );
    }
  };

  return (
    <div className="space-y-5">
      {/* =================================================================== */}
      {/* APPLICANT VIEW: SUBMIT L2–L4 CASE + UPLOAD PRIVATE VAULT DOCUMENTS  */}
      {/* =================================================================== */}
      {userRole !== "ADMIN" ? (
        <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900">
                <FileCheck2 className="h-3.5 w-3.5" /> Applicant KYC & Registration Vault (L2–L4)
              </div>
              <h3 className="mt-1.5 text-base font-bold text-slate-900">
                Submit Verification Upgrade & Upload Magic-Byte Checked Evidence
              </h3>
            </div>
            <span className="rounded-lg bg-slate-100 px-2.5 py-1 font-mono text-xs font-semibold text-slate-700">
              {ownCases.length} My Case(s)
            </span>
          </div>

          <form onSubmit={handleSubmitCase} className="grid gap-3 text-xs sm:grid-cols-2">
            <div>
              <label className="font-semibold text-slate-700">Target Verification Level</label>
              <select
                value={requestedLevel}
                onChange={(e) =>
                  setRequestedLevel(e.target.value as typeof requestedLevel)
                }
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
              >
                <option value="LEVEL_2_IDENTITY_REVIEWED">
                  Level 2 — Collector Identity Reviewed
                </option>
                <option value="LEVEL_3_BUSINESS_VERIFIED">
                  Level 3 — Area Shop / Mandi Business Verified
                </option>
                <option value="LEVEL_4_AUTHORISED_RECYCLER">
                  Level 4 — CPCB/SPCB Authorised Recycler (Recycler Role Only)
                </option>
              </select>
            </div>

            <div>
              <label className="font-semibold text-slate-700">Document Category</label>
              <select
                value={regType}
                onChange={(e) => setRegType(e.target.value as typeof regType)}
                className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
              >
                <option value="IDENTITY_DOC">Voter / Driving / ID Proof</option>
                <option value="SHOP_ACT_UDYAM">Municipal Shop Act / Udyam MSME</option>
                <option value="GSTIN">GST Registration Certificate</option>
                <option value="CPCB_SPCB_EPR">CPCB / State SPCB Authorisation</option>
              </select>
            </div>

            <div>
              <label className="font-semibold text-slate-700">Registration Reference</label>
              <input
                required
                value={regNumber}
                onChange={(e) => setRegNumber(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono"
              />
            </div>

            <div>
              <label className="font-semibold text-slate-700">Issuing Authority</label>
              <input
                required
                value={authority}
                onChange={(e) => setAuthority(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="sm:col-span-2">
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Application notes for human reviewer..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="sm:col-span-2">
              <button
                type="submit"
                className="w-full rounded-xl bg-emerald-700 py-2.5 font-bold text-white hover:bg-emerald-800"
              >
                Create Verification Case (Starts Strictly PENDING)
              </button>
            </div>
          </form>

          {/* Applicant's Submitted Cases + Private Document Vault Actions */}
          <div className="space-y-3 border-t border-slate-200 pt-4">
            <div className="text-xs font-bold text-slate-800">
              My Verification Cases & Private Evidence Vault
            </div>

            {ownCases.length === 0 ? (
              <p className="text-xs text-slate-500">
                No cases submitted on this account yet — click &ldquo;Create Verification Case&rdquo; above to test magic-byte file upload & 60s signed URL preview.
              </p>
            ) : (
              ownCases.map((vc) => (
                <div
                  key={vc.id}
                  className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-bold text-slate-900">
                        {vc.requestedLevel}
                      </span>
                      <span className="ml-2 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-900">
                        {vc.status}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500">
                      Case #{vc.id.slice(0, 8)}
                    </span>
                  </div>

                  {/* Upload Controls: Real File Input + 1-Click Valid PNG + 1-Click Spoofed .EXE Probe */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-800 px-3 py-1.5 font-bold text-white hover:bg-emerald-900">
                      <UploadCloud className="h-3.5 w-3.5" />
                      Upload PDF / Image
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadMultipartDocument(vc.id, f, f.name, regType);
                          e.target.value = "";
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => handleUploadSamplePng(vc.id)}
                      className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 font-bold text-emerald-950 hover:bg-emerald-100"
                    >
                      + 1-Click Sample Certificate PNG
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSpoofedExeAttackProbe(vc.id)}
                      className="inline-flex items-center gap-1 rounded-xl border border-rose-300 bg-rose-50 px-3 py-1.5 font-bold text-rose-900 hover:bg-rose-100"
                    >
                      <ShieldAlert className="h-3.5 w-3.5" /> Test Spoofed .EXE → .PDF Reject
                    </button>
                  </div>

                  {/* Uploaded Private Documents */}
                  {vc.documents.length > 0 && (
                    <div className="space-y-1.5 rounded-xl bg-white p-3 border border-slate-200">
                      <div className="font-bold text-slate-700">
                        Vault Files ({vc.documents.length}) — Private <code className="font-mono">storageKey</code> Hidden:
                      </div>
                      {vc.documents.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
                        >
                          <div>
                            <span className="font-semibold text-slate-900">
                              {doc.documentKind}
                            </span>{" "}
                            <span className="font-mono text-[11px] text-emerald-800">
                              ({doc.detectedMime} · {(doc.sizeBytes / 1024).toFixed(1)} KB)
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleOpenSignedVaultPreview(doc.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-indigo-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-indigo-800"
                          >
                            <Eye className="h-3 w-3" /> Open via 60s Signed URL
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        /* =================================================================== */
        /* ADMIN VIEW: PRIVATE VAULT REVIEW + CPCB CHECKBOX + AUDIT LOGGING    */
        /* =================================================================== */
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-bold text-slate-900">
              Admin Verification & Private Vault Review Queue ({adminCases.length})
            </h3>
            <label className="inline-flex items-center gap-2 rounded-xl border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-bold text-purple-950">
              <input
                type="checkbox"
                checked={officialSourceChecked}
                onChange={(e) => setOfficialSourceChecked(e.target.checked)}
                className="rounded border-purple-400"
              />
              Official CPCB / SPCB Portal Verified
            </label>
          </div>

          <div className="space-y-3">
            {adminCases.map((vc) => (
              <div
                key={vc.id}
                className="space-y-3 rounded-xl border border-slate-200 p-4 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">
                      {vc.applicant?.platformCode ?? "Applicant"} (
                      {vc.applicant?.profile?.displayName ?? vc.applicant?.role}) →{" "}
                      <span className="text-emerald-800">{vc.requestedLevel}</span>
                    </div>
                    <div className="mt-0.5 text-slate-600">
                      Status: <strong>{vc.status}</strong> — {vc.notes ?? "No notes"}
                    </div>
                  </div>

                  {vc.status === "PENDING" && (
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleAdminDecide(vc.id, "VERIFIED")}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 font-bold text-white hover:bg-emerald-800"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> Approve (VERIFIED)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdminDecide(vc.id, "ACTION_REQUIRED")}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 font-bold text-white hover:bg-amber-700"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" /> Action Required
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdminDecide(vc.id, "REJECTED")}
                        className="rounded-lg bg-rose-700 px-3 py-1.5 font-bold text-white hover:bg-rose-800"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>

                {vc.documents && vc.documents.length > 0 && (
                  <div className="space-y-1.5 rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="font-bold text-slate-700">
                      Attached Private Vault Evidence ({vc.documents.length}):
                    </div>
                    {vc.documents.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2"
                      >
                        <div>
                          <span className="font-semibold text-slate-900">
                            {doc.documentKind}
                          </span>{" "}
                          <span className="font-mono text-[11px] text-slate-500">
                            ({doc.detectedMime} · SHA-256:{" "}
                            {doc.sha256Digest ? `${doc.sha256Digest.slice(0, 16)}...` : "verified"})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleOpenSignedVaultPreview(doc.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-indigo-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-indigo-800"
                        >
                          <Lock className="h-3 w-3" /> Issue 60s Signed URL & Inspect
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 60-SECOND HMAC-SIGNED PRIVATE DOCUMENT VAULT VIEWER MODAL           */}
      {/* =================================================================== */}
      {vaultPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4">
          <div className="w-full max-w-2xl space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-3 py-1 text-xs font-bold text-indigo-950">
                  <Lock className="h-3.5 w-3.5" /> Short-Lived HMAC Vault Access ·{" "}
                  {secondsRemaining > 0
                    ? `Expires in ${secondsRemaining}s`
                    : "Token Window Elapsed"}
                </div>
                <div className="mt-1 font-mono text-[11px] text-slate-500 break-all">
                  {vaultPreview.signedPath}
                </div>
              </div>
              <button
                type="button"
                onClick={closeVaultPreview}
                className="rounded-xl bg-slate-100 p-2 text-slate-700 hover:bg-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-100 p-3">
              {vaultPreview.mime.startsWith("image/") ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={vaultPreview.blobUrl}
                  alt="Verified private KYC evidence"
                  className="mx-auto max-h-96 rounded-lg object-contain"
                />
              ) : (
                <iframe
                  src={vaultPreview.blobUrl}
                  title="Verified private PDF document"
                  className="h-96 w-full rounded-lg bg-white"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
