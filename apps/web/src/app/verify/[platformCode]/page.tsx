"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  ShieldCheck,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Building2,
  Printer,
  QrCode,
} from "lucide-react";
import { QrMatrixCard } from "../../../components/QrMatrixCard";

interface PublicCardData {
  platformCode: string;
  displayName: string;
  operatingCity: string | null;
  role: string;
  supplyChainTier: string;
  accountStatus: string;
  verificationLevel: string;
  issuedAt: string;
  recyclerAuthorisationSummary?: {
    authorityName: string;
    registrationNumber: string;
    permittedStreams: string[];
    cpcbPortalChecked: boolean;
  } | null;
  legalNotice: string;
}

export default function PublicVerifyCardPage({
  params,
}: {
  params: { platformCode: string };
}) {
  const [card, setCard] = useState<PublicCardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verifyUrl, setVerifyUrl] = useState<string>("");

  useEffect(() => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://kabadiwala.local";
    setVerifyUrl(`${origin}/verify/${encodeURIComponent(params.platformCode)}`);

    fetch(`/api/v1/public/verify/${encodeURIComponent(params.platformCode)}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setCard(json.data.publicCard);
        } else {
          setError(json.error?.message || "Platform ID not found");
        }
      })
      .catch(() => setError("Unable to reach verification service"));
  }, [params.platformCode]);

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10 print:bg-white print:py-2">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-bold text-emerald-800 hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Kabadiwala Connect
          </Link>

          {card && (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-3.5 py-2 text-xs font-bold text-white shadow hover:bg-emerald-900"
            >
              <Printer className="h-3.5 w-3.5" /> Print Shop / Rickshaw QR ID Sticker
            </button>
          )}
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-white p-8 text-center shadow">
            <AlertTriangle className="mx-auto h-10 w-10 text-rose-600" />
            <h1 className="mt-3 text-lg font-bold text-slate-900">
              Unrecognised Platform ID
            </h1>
            <p className="mt-1 text-xs text-slate-600">{error}</p>
          </div>
        ) : !card ? (
          <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500 shadow">
            Checking live verification registry...
          </div>
        ) : (
          <div className="overflow-hidden rounded-3xl border-2 border-emerald-900/20 bg-white shadow-xl print:shadow-none">
            <div className="bg-gradient-to-br from-emerald-950 via-emerald-900 to-teal-900 p-7 text-white print:bg-emerald-950">
              <div className="flex flex-wrap items-start justify-between gap-6">
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/20 px-3 py-1 text-xs font-bold text-emerald-200 ring-1 ring-emerald-300/30">
                      <ShieldCheck className="h-4 w-4" /> Public Verification Badge
                    </span>
                    <span className="font-mono text-sm font-extrabold text-amber-300">
                      {card.platformCode}
                    </span>
                  </div>

                  <div>
                    <h1 className="text-2xl font-extrabold">{card.displayName}</h1>
                    <p className="mt-1 text-xs text-emerald-200">
                      Operating City: {card.operatingCity ?? "India"} · Role: {card.role}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-1">
                    <span className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3 py-1.5 text-xs font-bold">
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                      Account: {card.accountStatus}
                    </span>
                    <span className="rounded-xl bg-amber-400/20 px-3 py-1.5 text-xs font-bold text-amber-200">
                      {card.verificationLevel}
                    </span>
                    <span className="rounded-xl bg-white/10 px-3 py-1.5 text-xs font-medium text-emerald-100">
                      {card.supplyChainTier}
                    </span>
                  </div>
                </div>

                {/* Real Smartphone-Camera-Scannable ISO 18004 QR Matrix */}
                {verifyUrl && (
                  <div className="shrink-0">
                    <QrMatrixCard
                      value={verifyUrl}
                      size={148}
                      title="Scan to Verify Live"
                      subtitle="कबाड़ीवाला पहचान जाँचें"
                      onPrint={() => window.print()}
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4 p-6 text-xs">
              <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-2.5 text-emerald-950">
                <div className="flex items-center gap-2 font-bold">
                  <QrCode className="h-4 w-4 text-emerald-800" />
                  <span>Shop Gate / Tricycle Sticker URL:</span>
                </div>
                <code className="font-mono text-[11px] font-semibold break-all">
                  {verifyUrl}
                </code>
              </div>

              {card.recyclerAuthorisationSummary && (
                <div className="rounded-2xl border border-purple-200 bg-purple-50/70 p-4">
                  <div className="flex items-center gap-2 font-bold text-purple-950">
                    <Building2 className="h-4 w-4" />
                    Checked Official Recycler Registration Summary
                  </div>
                  <div className="mt-2 space-y-1 text-purple-900">
                    <div>
                      <strong>Authority:</strong>{" "}
                      {card.recyclerAuthorisationSummary.authorityName}
                    </div>
                    <div>
                      <strong>Registration Ref:</strong>{" "}
                      <span className="font-mono">
                        {card.recyclerAuthorisationSummary.registrationNumber}
                      </span>
                    </div>
                    <div>
                      <strong>Permitted Streams:</strong>{" "}
                      {card.recyclerAuthorisationSummary.permittedStreams.join(", ")}
                    </div>
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-slate-600">
                <div className="font-bold text-slate-800">
                  Privacy & Data Minimisation Guarantee
                </div>
                <p className="mt-1">
                  Personal phone numbers, email addresses, private residential locations, and uploaded KYC files are strictly excluded from public QR verification endpoints.
                </p>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
                <strong>Important Disclaimer:</strong> {card.legalNotice}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
