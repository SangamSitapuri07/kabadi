"use client";

import React, { useEffect, useState } from "react";
import { Printer, X, Smartphone, ShieldCheck, Check, Copy } from "lucide-react";

interface SlipResponse {
  orderId: string;
  orderNumber: string;
  status: string;
  fulfillmentMode: string;
  createdAt: string;
  completedAt: string | null;
  qrTraceToken: string;
  publicTraceUrl: string;
  seller: {
    platformCode: string;
    displayName: string;
    tier: string;
  };
  buyer: {
    platformCode: string;
    displayName: string;
    tier: string;
    verificationLevel: string;
  };
  lineItems: Array<{
    id: string;
    nameEn: string;
    nameHi: string;
    namePa: string;
    nameMr: string;
    isRegulatedHazardous: boolean;
    lockedRatePaise: number;
    estimatedGrams: number;
    actualGrams: number | null;
    subtotalPaise: number;
  }>;
  totals: {
    grossAmountPaise: number;
    grossFormattedInr: string;
    khataAdvanceOffsetPaise: number;
    khataOffsetFormattedInr: string;
    netPayablePaise: number;
    netPayableExactInr: string;
  };
  upi: {
    payeeVpa: string;
    upiIntentUri: string | null;
    upiQrSvg: string | null;
  };
  traceQrSvg: string;
  handoverHashSha256: string | null;
  receiptDigestSha256: string;
  statutoryDisclaimer: string;
}

interface SettlementSlipModalProps {
  orderId: string | null;
  accessToken: string;
  lang: "EN" | "HI" | "PA" | "MR";
  onClose: () => void;
}

export function SettlementSlipModal({
  orderId,
  accessToken,
  lang,
  onClose,
}: SettlementSlipModalProps) {
  const [slip, setSlip] = useState<SlipResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedUpi, setCopiedUpi] = useState<boolean>(false);

  useEffect(() => {
    if (!orderId || !accessToken) return;
    setSlip(null);
    setError(null);
    fetch(`/api/v1/orders/${encodeURIComponent(orderId)}/settlement-slip`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.success) {
          setSlip(json.data.slip);
        } else {
          setError(json.error?.message || "Unable to load settlement slip");
        }
      })
      .catch(() => setError("Network error loading settlement slip"));
  }, [orderId, accessToken]);

  if (!orderId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/75 p-4 print:static print:bg-white print:p-0">
      <div className="w-full max-w-2xl rounded-3xl bg-white p-6 shadow-2xl print:max-w-none print:rounded-none print:shadow-none">
        <div className="flex items-center justify-between border-b border-slate-200 pb-3 print:hidden">
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-emerald-700" />
            <h3 className="text-base font-extrabold text-slate-900">
              Dynamic NPCI UPI Pay QR & 80mm Bilingual Thermal Handover Slip
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-3.5 py-1.5 text-xs font-bold text-white hover:bg-emerald-900"
            >
              <Printer className="h-3.5 w-3.5" /> Print 80mm Slip
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-slate-100 p-2 text-slate-700 hover:bg-slate-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error ? (
          <div className="py-8 text-center text-sm font-bold text-rose-700">{error}</div>
        ) : !slip ? (
          <div className="py-8 text-center text-xs text-slate-500">
            Generating integer-paise UPI QR & cryptographic SHA-256 receipt...
          </div>
        ) : (
          <div className="mt-4 space-y-4 text-xs">
            {/* Thermal Receipt Header */}
            <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/70 p-5 font-mono">
              <div className="text-center">
                <div className="text-sm font-extrabold tracking-wide text-slate-950">
                  ♻️ KABADIWALA CONNECT — WEIGHMENT & PAYOUT SLIP
                </div>
                <div className="text-[11px] text-slate-600">
                  तौल एवं भुगतान पर्ची · ਤੋਲ ਅਤੇ ਭੁਗਤਾਨ ਪਰਚੀ · वजन आणि पावती
                </div>
                <div className="mt-1 font-bold text-emerald-800">
                  Order: {slip.orderNumber} · Status: {slip.status}
                </div>
              </div>

              <div className="mt-3 grid gap-2 border-y border-dashed border-slate-300 py-2.5 text-[11px] sm:grid-cols-2">
                <div>
                  <span className="text-slate-500">SELLER:</span>{" "}
                  <strong>{slip.seller.displayName}</strong> ({slip.seller.platformCode})
                </div>
                <div>
                  <span className="text-slate-500">BUYER:</span>{" "}
                  <strong>{slip.buyer.displayName}</strong> ({slip.buyer.platformCode})
                </div>
              </div>

              {/* Line Items */}
              <div className="divide-y divide-dashed divide-slate-200 py-2">
                {slip.lineItems.map((li) => {
                  const vernacularName =
                    lang === "PA"
                      ? li.namePa
                      : lang === "MR"
                        ? li.nameMr || li.nameHi
                        : li.nameHi;
                  const grams = li.actualGrams ?? li.estimatedGrams;
                  return (
                    <div
                      key={li.id}
                      className="flex items-center justify-between py-1.5"
                    >
                      <div>
                        <div className="font-bold text-slate-900">
                          {li.nameEn} ({vernacularName})
                        </div>
                        <div className="text-[11px] text-slate-600">
                          {(grams / 1000).toFixed(2)} kg × ₹
                          {(li.lockedRatePaise / 100).toFixed(2)}/kg
                        </div>
                      </div>
                      <div className="font-bold text-slate-900">
                        ₹{(li.subtotalPaise / 100).toFixed(2)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Exact Integer-Paise Settlement Breakdown */}
              <div className="space-y-1 border-t border-dashed border-slate-300 pt-2.5">
                <div className="flex justify-between">
                  <span>Gross Weighed Value:</span>
                  <span>₹{slip.totals.grossFormattedInr}</span>
                </div>
                {slip.totals.khataAdvanceOffsetPaise > 0 && (
                  <div className="flex justify-between text-amber-800">
                    <span>Less: Morning Peshgi Khata Advance Offset:</span>
                    <span>- ₹{slip.totals.khataOffsetFormattedInr}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-slate-300 pt-1.5 text-sm font-extrabold text-emerald-900">
                  <span>NET PAYABLE (CASH / UPI):</span>
                  <span>₹{slip.totals.netPayableExactInr}</span>
                </div>
              </div>

              {/* Side-by-Side Real Scannable UPI Intent QR + Lineage Trace QR */}
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col items-center rounded-xl border border-emerald-200 bg-white p-3 text-center">
                  <div className="font-sans text-xs font-extrabold text-emerald-950">
                    Scan with GPay / PhonePe / Paytm
                  </div>
                  <div className="text-[10px] text-slate-500">
                    VPA: {slip.upi.payeeVpa} · Exact ₹{slip.totals.netPayableExactInr}
                  </div>
                  {slip.upi.upiQrSvg ? (
                    <div
                      className="mt-2"
                      dangerouslySetInnerHTML={{ __html: slip.upi.upiQrSvg }}
                    />
                  ) : (
                    <div className="my-6 rounded-lg bg-emerald-50 p-3 text-emerald-900">
                      100% settled via Khata Peshgi Offset (₹0.00 net payable)
                    </div>
                  )}
                  {slip.upi.upiIntentUri && (
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(slip.upi.upiIntentUri!);
                        setCopiedUpi(true);
                        setTimeout(() => setCopiedUpi(false), 1800);
                      }}
                      className="mt-2 inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-sans text-[10px] font-bold text-emerald-900 print:hidden"
                    >
                      {copiedUpi ? (
                        <>
                          <Check className="h-3 w-3" /> Copied upi:// URI
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" /> Copy upi://pay Intent
                        </>
                      )}
                    </button>
                  )}
                </div>

                <div className="flex flex-col items-center rounded-xl border border-indigo-200 bg-white p-3 text-center">
                  <div className="font-sans text-xs font-extrabold text-indigo-950">
                    Chain-of-Custody Bale QR
                  </div>
                  <div className="text-[10px] text-slate-500">{slip.qrTraceToken}</div>
                  <div
                    className="mt-2"
                    dangerouslySetInnerHTML={{ __html: slip.traceQrSvg }}
                  />
                  <span className="mt-2 inline-flex items-center gap-1 font-sans text-[10px] font-semibold text-indigo-800">
                    <ShieldCheck className="h-3 w-3" /> Verified Multi-Tier Lineage
                  </span>
                </div>
              </div>

              <div className="mt-3 break-all rounded-lg bg-slate-900 px-3 py-2 text-[10px] text-emerald-300">
                Receipt SHA-256 Digest: {slip.receiptDigestSha256}
              </div>

              <div className="mt-2 text-center font-sans text-[10px] text-slate-500">
                {slip.statutoryDisclaimer}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
