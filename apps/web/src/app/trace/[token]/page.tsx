"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  GitBranch,
  CheckCircle2,
  ShieldAlert,
  Scale,
  Printer,
} from "lucide-react";
import { QrMatrixCard } from "../../../components/QrMatrixCard";

interface TraceNode {
  orderNumber: string;
  qrTraceToken: string;
  status: string;
  sellerPlatformCode: string;
  sellerTier: string;
  buyerPlatformCode: string;
  buyerBusinessName: string;
  buyerTier: string;
  buyerVerificationLevel: string;
  verifiedAuthorisedRecyclerFacility?: {
    authorityName: string;
    registrationNumber: string;
    cpcbPortalChecked: boolean;
  } | null;
  materials: Array<{
    materialSlug: string;
    materialName: string;
    isRegulatedHazardous: boolean;
    estimatedGrams: number;
    verifiedActualGrams: number | null;
  }>;
  handoverMilestones: Array<{
    handoverPincode: string;
    evidenceHashSha256: string;
    buyerConfirmedAt: string | null;
  }>;
  createdAt: string;
  completedAt: string | null;
  upstreamChildLots: Array<{
    attributedGrams: number;
    sourceTransaction: TraceNode;
  }>;
}

function LineageCard({ node, depth = 0 }: { node: TraceNode; depth?: number }) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${
        depth === 0
          ? "border-emerald-300 bg-white"
          : "border-slate-200 bg-slate-50/90 ml-4 sm:ml-8"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-extrabold text-slate-900">
            {node.orderNumber}
          </span>
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-900">
            {node.status}
          </span>
          <span className="text-xs font-semibold text-slate-600">
            {node.sellerTier} ({node.sellerPlatformCode}) → {node.buyerTier} (
            {node.buyerBusinessName})
          </span>
        </div>
        <span className="rounded-md bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-800">
          Buyer Status: {node.buyerVerificationLevel}
        </span>
      </div>

      {node.verifiedAuthorisedRecyclerFacility && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-xl bg-purple-100 px-3 py-1.5 text-xs font-bold text-purple-950">
          <CheckCircle2 className="h-4 w-4 text-purple-700" />
          Verified Facility: {node.verifiedAuthorisedRecyclerFacility.authorityName} (
          {node.verifiedAuthorisedRecyclerFacility.registrationNumber})
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {node.materials.map((m, idx) => (
          <div
            key={idx}
            className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
          >
            <div>
              <span className="font-semibold text-slate-900">{m.materialName}</span>
              {m.isRegulatedHazardous && (
                <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                  Regulated Stream
                </span>
              )}
            </div>
            <div className="text-right">
              <span className="inline-flex items-center gap-1 font-bold text-emerald-800">
                <Scale className="h-3.5 w-3.5" />
                {m.verifiedActualGrams !== null
                  ? `${(m.verifiedActualGrams / 1000).toFixed(2)} kg Weighed`
                  : `${(m.estimatedGrams / 1000).toFixed(2)} kg Est.`}
              </span>
            </div>
          </div>
        ))}
      </div>

      {node.handoverMilestones[0] && (
        <div className="mt-3 rounded-xl bg-slate-900 px-3.5 py-2 font-mono text-[11px] text-emerald-300">
          Handover Evidence SHA-256: {node.handoverMilestones[0].evidenceHashSha256.slice(0, 36)}
          ... (PIN {node.handoverMilestones[0].handoverPincode})
        </div>
      )}

      {node.upstreamChildLots.length > 0 && (
        <div className="mt-4 space-y-3 border-l-2 border-emerald-400 pl-3">
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-800">
            <GitBranch className="h-4 w-4" />
            Aggregated From Upstream Verified Child Lots ({node.upstreamChildLots.length})
          </div>
          {node.upstreamChildLots.map((child, idx) => (
            <div key={idx} className="space-y-1">
              <div className="text-[11px] font-semibold text-slate-500">
                Attributed Weight Into Batch: {(child.attributedGrams / 1000).toFixed(2)} kg
              </div>
              <LineageCard node={child.sourceTransaction} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PublicTraceabilityPage({
  params,
}: {
  params: { token: string };
}) {
  const [trace, setTrace] = useState<TraceNode | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [traceUrl, setTraceUrl] = useState<string>("");

  useEffect(() => {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "https://kabadiwala.local";
    setTraceUrl(`${origin}/trace/${encodeURIComponent(params.token)}`);

    fetch(`/api/v1/public/trace/${encodeURIComponent(params.token)}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setTrace(json.data.traceRecord);
          setNotice(json.data.statutoryNotice);
        } else {
          setError(json.error?.message || "Traceability token not found");
        }
      })
      .catch(() => setError("Unable to load traceability lineage"));
  }, [params.token]);

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-8 print:bg-white print:py-2">
      <div className="mx-auto max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-bold text-emerald-800 hover:underline"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Kabadiwala Connect
          </Link>

          {trace && (
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-3.5 py-2 text-xs font-bold text-white shadow hover:bg-emerald-900"
            >
              <Printer className="h-3.5 w-3.5" /> Print Bale Chain-of-Custody QR Tag
            </button>
          )}
        </div>

        <div className="rounded-2xl bg-gradient-to-r from-emerald-950 to-teal-900 p-6 text-white shadow print:bg-emerald-950">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="max-w-xl">
              <div className="text-xs font-bold uppercase tracking-wider text-emerald-300">
                Multi-Tier Chain-of-Custody & Batch Lineage Explorer
              </div>
              <h1 className="mt-1 font-mono text-xl font-extrabold">{params.token}</h1>
              <p className="mt-1.5 text-xs text-emerald-100">
                Tracks verified weighing and handover milestones across Generator → Collector → Area Shop → Wholesale Hub → Authorised Recycler while keeping personal addresses private.
              </p>
            </div>

            {traceUrl && (
              <div className="shrink-0">
                <QrMatrixCard
                  value={traceUrl}
                  size={136}
                  title="Bale Lineage Tag"
                  subtitle="Scan at Recycler Gate"
                  onPrint={() => window.print()}
                />
              </div>
            )}
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl border border-rose-200 bg-white p-8 text-center text-sm font-semibold text-rose-700">
            {error}
          </div>
        ) : !trace ? (
          <div className="rounded-2xl bg-white p-8 text-center text-sm text-slate-500">
            Loading multi-tier lineage graph...
          </div>
        ) : (
          <>
            <LineageCard node={trace} depth={0} />

            <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-xs text-amber-950">
              <ShieldAlert className="h-5 w-5 shrink-0 text-amber-700" />
              <div>
                <strong>Honest Traceability Notice:</strong> {notice}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
