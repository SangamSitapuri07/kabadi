"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  WifiOff,
  Wifi,
  TrendingUp,
  Scale,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
  Repeat,
  Database,
} from "lucide-react";
import {
  PersistedOfflineOp,
  clearOfflineOpsInIdb,
  putOfflineOpInIdb,
  readAllOfflineOpsFromIdb,
} from "../lib/offlineIndexedDb";

interface OrderBrief {
  id: string;
  orderNumber: string;
  status: string;
  agreedTotalPaise: number;
  finalSettlementPaise: number | null;
}

interface PricePoint {
  id: string;
  tier: string;
  medianRatePaise: number;
  recordedAt: string;
  material: {
    slug: string;
    nameEn: string;
    nameHi: string;
    namePa: string;
    nameMr: string;
  };
}

interface ArbitrageSpread {
  slug: string;
  nameEn: string;
  minPickupPaise: number;
  maxDropoffPaise: number;
  fullChainSpreadPaisePerKg: number;
}

interface DisputeItem {
  id: string;
  reasonCategory: string;
  description: string;
  status: string;
  resolutionNotes: string | null;
  createdAt: string;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    agreedTotalPaise: number;
    finalSettlementPaise: number | null;
  };
  raisedBy: {
    platformCode: string;
    profile?: { displayName: string } | null;
  };
}

interface OperationsHubProps {
  accessToken: string;
  userRole: string | null;
  orders: OrderBrief[];
  onRefreshWorkspace: () => Promise<void>;
  onNotify: (type: "ok" | "err", text: string) => void;
}

const TIER_COLORS: Record<string, string> = {
  TIER_1_LOCAL_COLLECTOR: "#059669",
  TIER_2_AREA_SHOP: "#0d9488",
  TIER_3_WHOLESALE_AGGREGATOR: "#4f46e5",
  TIER_4_AUTHORISED_RECYCLER: "#9333ea",
};

export function OperationsHub({
  accessToken,
  userRole,
  orders,
  onRefreshWorkspace,
  onNotify,
}: OperationsHubProps) {
  // 1. Price History & Inter-Tier Arbitrage State
  const [selectedMaterialSlug, setSelectedMaterialSlug] =
    useState<string>("metal-copper-bright");
  const [historyPoints, setHistoryPoints] = useState<PricePoint[]>([]);
  const [spreads, setSpreads] = useState<ArbitrageSpread[]>([]);

  // 2. IndexedDB-Persisted Offline Sync Queue State
  const [isSimulatedOffline, setIsSimulatedOffline] = useState<boolean>(true);
  const [storageEngine, setStorageEngine] = useState<"IndexedDB" | "localStorage">(
    "IndexedDB"
  );
  const [localQueue, setLocalQueue] = useState<PersistedOfflineOp[]>([]);
  const [lastSyncedBatch, setLastSyncedBatch] = useState<PersistedOfflineOp[] | null>(
    null
  );
  const [lastSyncReport, setLastSyncReport] = useState<{
    newlyAppliedCount: number;
    idempotentSkippedCount: number;
    rejectedCount: number;
  } | null>(null);

  // 3. Disputes & Arbitration State
  const [disputes, setDisputes] = useState<DisputeItem[]>([]);
  const [disputeOrderId, setDisputeOrderId] = useState<string>("");
  const [disputeCategory, setDisputeCategory] = useState<
    "WEIGHT_DISCREPANCY" | "PRICE_CHANGE" | "PAYMENT_PENDING" | "GRADE_DISPUTE"
  >("WEIGHT_DISCREPANCY");
  const [disputeDesc, setDisputeDesc] = useState<string>(
    "Digital scale showed 2.4 kg higher weight than manually written slip"
  );
  const [adminAdjustedInr, setAdminAdjustedInr] = useState<Record<string, string>>({});

  const hydrateFromIndexedDb = useCallback(
    async (announce = false) => {
      const { items, engine } = await readAllOfflineOpsFromIdb();
      setStorageEngine(engine);
      setLocalQueue(items);
      if (announce) {
        onNotify(
          "ok",
          `Hydrated ${items.length} pending offline operation(s) directly from browser ${engine} (kabadiwala_offline_db → pending_sync_ops)!`
        );
      }
      return items;
    },
    [onNotify]
  );

  const flushBatch = useCallback(
    async (opsToSend: PersistedOfflineOp[], isReplay = false) => {
      if (!accessToken || opsToSend.length === 0) return;
      const res = await fetch("/api/v1/sync/batch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        credentials: "include",
        body: JSON.stringify({
          deviceLabel: isReplay
            ? "Simulated Dropped-ACK Retry Client"
            : `Field Offline Web Queue (${storageEngine})`,
          operations: opsToSend.map((o) => ({
            idempotencyKey: o.idempotencyKey,
            clientEntityId: o.clientEntityId,
            operationType: o.operationType,
            payload: o.payload,
          })),
        }),
      });
      const json = await res.json();
      if (json.success) {
        setLastSyncReport(json.data.summary);
        if (!isReplay) {
          setLastSyncedBatch(opsToSend);
          await clearOfflineOpsInIdb();
          setLocalQueue([]);
        }
        await onRefreshWorkspace();
        onNotify(
          "ok",
          `Sync Batch Result — Applied: ${json.data.summary.newlyAppliedCount} · Idempotent Duplicate Skipped: ${json.data.summary.idempotentSkippedCount}`
        );
      } else {
        onNotify("err", json.error?.message || "Sync batch failed");
      }
    },
    [accessToken, onNotify, onRefreshWorkspace, storageEngine]
  );

  useEffect(() => {
    hydrateFromIndexedDb(false);
  }, [hydrateFromIndexedDb]);

  // Auto-flush IndexedDB queue if browser transitions from offline -> online
  useEffect(() => {
    const onBrowserOnline = async () => {
      setIsSimulatedOffline(false);
      const pending = await readAllOfflineOpsFromIdb();
      if (pending.items.length > 0 && accessToken) {
        await flushBatch(pending.items, false);
      }
    };
    window.addEventListener("online", onBrowserOnline);
    return () => window.removeEventListener("online", onBrowserOnline);
  }, [accessToken, flushBatch]);

  const loadMarketAndDisputes = useCallback(async () => {
    const pRes = await fetch(
      `/api/v1/materials/price-history?materialSlug=${encodeURIComponent(
        selectedMaterialSlug
      )}`
    ).then((r) => r.json());
    if (pRes.success) {
      setHistoryPoints(pRes.data.history);
      setSpreads(pRes.data.tierArbitrageSpreads);
    }

    if (accessToken) {
      const dRes = await fetch("/api/v1/disputes", {
        headers: { Authorization: `Bearer ${accessToken}` },
        credentials: "include",
      }).then((r) => r.json());
      if (dRes.success) {
        setDisputes(dRes.data.disputes);
      }
    }
  }, [accessToken, selectedMaterialSlug]);

  useEffect(() => {
    loadMarketAndDisputes();
  }, [loadMarketAndDisputes]);

  useEffect(() => {
    const firstActive = orders.find(
      (o) => o.status !== "CANCELLED" && o.status !== "DISPUTED"
    );
    if (firstActive && !disputeOrderId) {
      setDisputeOrderId(firstActive.id);
    }
  }, [orders, disputeOrderId]);

  const enqueueOfflineItem = async (kind: "lot" | "khata" | "dismantle") => {
    const uid = `${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const queuedAtIso = new Date().toISOString();
    let item: PersistedOfflineOp;
    if (kind === "lot") {
      item = {
        idempotencyKey: `web-offline-lot-${uid}`,
        clientEntityId: `draft-${uid}`,
        operationType: "DRAFT_LISTING_CREATE",
        label: "Offline Scrap Lot: 18 kg Heavy Iron (PIN 141003)",
        queuedAtIso,
        payload: {
          title: `Offline Shed Collection #${uid.slice(-4)}: 18 kg Heavy Iron`,
          pickupPincode: "141003",
          pickupAddressPrivate: "Focal Point Phase IV Shed, Ludhiana",
          preferredMode: "SELLER_DROPOFF",
          items: [{ materialSlug: "metal-heavy-iron", estimatedGrams: 18000 }],
        },
      };
    } else if (kind === "khata") {
      item = {
        idempotencyKey: `web-offline-khata-${uid}`,
        clientEntityId: `khata-${uid}`,
        operationType: "KHATA_ADVANCE_RECORD",
        label: "Offline Morning Peshgi Advance: ₹400 → KC-COL-100101",
        queuedAtIso,
        payload: {
          borrowerPlatformCode: "KC-COL-100101",
          amountPaise: 40000,
          entryType: "CASH_ADVANCE_GIVEN",
          notes: "Offline field pheri cash advance",
        },
      };
    } else {
      item = {
        idempotencyKey: `web-offline-dismantle-${uid}`,
        clientEntityId: `dismantle-${uid}`,
        operationType: "DISMANTLING_LOG",
        label: "Offline Motor Split: 12 kg Motor → 2.2 kg Copper + 9.2 kg Iron",
        queuedAtIso,
        payload: {
          inputDescription: "Offline 1x Cooler Exhaust Motor Split",
          inputGrams: 12000,
          residueGrams: 600,
          outputs: [
            { materialSlug: "metal-copper-bright", outputGrams: 2200 },
            { materialSlug: "metal-heavy-iron", outputGrams: 9200 },
          ],
        },
      };
    }

    await putOfflineOpInIdb(item);
    await hydrateFromIndexedDb(false);
    onNotify(
      "ok",
      `Persisted offline op (${item.idempotencyKey}) in browser ${storageEngine} — survives full tab refresh!`
    );
  };

  const handleRaiseDispute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disputeOrderId || !accessToken) return;
    const res = await fetch(`/api/v1/orders/${disputeOrderId}/disputes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      credentials: "include",
      body: JSON.stringify({
        reasonCategory: disputeCategory,
        description: disputeDesc,
      }),
    });
    const json = await res.json();
    if (json.success) {
      await loadMarketAndDisputes();
      await onRefreshWorkspace();
      onNotify(
        "ok",
        "Dispute opened — order status frozen as DISPUTED (blocks unilateral settlement)!"
      );
    } else {
      onNotify("err", json.error?.message || "Could not open dispute");
    }
  };

  const handleAdminArbitrate = async (
    disputeId: string,
    decision: "UNDER_REVIEW" | "RESOLVED_ADJUSTED" | "RESOLVED_CANCELLED" | "REJECTED"
  ) => {
    const customInr = Number(adminAdjustedInr[disputeId] || "0");
    const res = await fetch(`/api/v1/admin/disputes/${disputeId}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      credentials: "include",
      body: JSON.stringify({
        decision,
        resolutionNotes: `Admin arbitration outcome (${decision}) verified against scale & handover records`,
        ...(customInr > 0
          ? { adjustedSettlementPaise: Math.round(customInr * 100) }
          : {}),
      }),
    });
    const json = await res.json();
    if (json.success) {
      await loadMarketAndDisputes();
      await onRefreshWorkspace();
      onNotify("ok", `Dispute resolved (${decision}) & participants notified!`);
    } else {
      onNotify("err", json.error?.message || "Admin arbitration failed");
    }
  };

  // Group history points by tier for SVG polyline rendering
  const tiersGrouped = new Map<string, PricePoint[]>();
  for (const pt of historyPoints) {
    const arr = tiersGrouped.get(pt.tier) ?? [];
    arr.push(pt);
    tiersGrouped.set(pt.tier, arr);
  }
  const allRates = historyPoints.map((p) => p.medianRatePaise);
  const minVal = allRates.length > 0 ? Math.min(...allRates) * 0.92 : 0;
  const maxVal = allRates.length > 0 ? Math.max(...allRates) * 1.06 : 10000;

  return (
    <div className="space-y-6">
      {/* =================================================================== */}
      {/* 1. MULTI-TIER PRICE HISTORY TRENDS & INTER-TIER ARBITRAGE ANALYTICS */}
      {/* =================================================================== */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900">
              <TrendingUp className="h-3.5 w-3.5" /> 6-Week Multi-Tier Market Price Trends & Spreads
            </div>
            <h2 className="mt-1.5 text-lg font-bold text-slate-900">
              Tier-1 Collector → Tier-2 Shop → Tier-3 Mandi → Tier-4 Recycler Price Ladder
            </h2>
          </div>

          <div className="flex flex-wrap gap-1.5 text-xs">
            {[
              { slug: "metal-copper-bright", label: "Copper (Tamba)" },
              { slug: "ewaste-pcb-grade-a", label: "Grade-A PCB" },
              { slug: "metal-aluminium-utensil", label: "Aluminium" },
              { slug: "paper-cardboard", label: "Cardboard" },
              { slug: "metal-heavy-iron", label: "Heavy Iron" },
            ].map((m) => (
              <button
                key={m.slug}
                type="button"
                onClick={() => setSelectedMaterialSlug(m.slug)}
                className={`rounded-xl px-3 py-1.5 font-bold transition ${
                  selectedMaterialSlug === m.slug
                    ? "bg-emerald-800 text-white"
                    : "border border-slate-200 bg-slate-50 text-slate-700 hover:bg-emerald-50"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Responsive SVG Line Chart */}
        <div className="mt-5 grid gap-6 lg:grid-cols-12">
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 lg:col-span-8">
            <svg viewBox="0 0 620 220" className="h-52 w-full overflow-visible">
              {[0, 0.5, 1].map((t, idx) => {
                const y = 20 + t * 170;
                const valInr = ((maxVal - t * (maxVal - minVal)) / 100).toFixed(0);
                return (
                  <g key={idx}>
                    <line
                      x1={55}
                      y1={y}
                      x2={595}
                      y2={y}
                      stroke="#cbd5e1"
                      strokeDasharray="4 4"
                    />
                    <text x={8} y={y + 4} fontSize="11" fill="#475569" fontWeight="600">
                      ₹{valInr}
                    </text>
                  </g>
                );
              })}

              {Array.from(tiersGrouped.entries()).map(([tier, pts]) => {
                const stroke = TIER_COLORS[tier] ?? "#0f766e";
                const coords = pts.map((p, idx) => {
                  const x =
                    pts.length === 1
                      ? 320
                      : 65 + (idx / (pts.length - 1)) * 520;
                  const y =
                    190 -
                    ((p.medianRatePaise - minVal) / Math.max(1, maxVal - minVal)) *
                      170;
                  return { x, y, val: p.medianRatePaise };
                });

                return (
                  <g key={tier}>
                    <polyline
                      fill="none"
                      stroke={stroke}
                      strokeWidth="3.5"
                      points={coords.map((c) => `${c.x},${c.y}`).join(" ")}
                    />
                    {coords.map((c, i) => (
                      <circle key={i} cx={c.x} cy={c.y} r="4.5" fill={stroke} />
                    ))}
                  </g>
                );
              })}
            </svg>

            <div className="mt-2 flex flex-wrap gap-4 text-xs font-semibold">
              {Array.from(tiersGrouped.entries()).map(([tier, pts]) => {
                const latest = pts[pts.length - 1];
                return (
                  <div key={tier} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-3 w-3 rounded-full"
                      style={{ backgroundColor: TIER_COLORS[tier] ?? "#0f766e" }}
                    />
                    <span>
                      {tier}:{" "}
                      <strong>
                        ₹{((latest?.medianRatePaise ?? 0) / 100).toFixed(2)}/kg
                      </strong>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2.5 lg:col-span-4">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-500">
              Live Full-Chain Inter-Tier Spreads
            </div>
            {spreads.slice(0, 5).map((sp) => (
              <div
                key={sp.slug}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3 text-xs"
              >
                <div>
                  <div className="font-bold text-slate-900">{sp.nameEn}</div>
                  <div className="text-[11px] text-slate-500">
                    ₹{(sp.minPickupPaise / 100).toFixed(0)} → ₹
                    {(sp.maxDropoffPaise / 100).toFixed(0)}/kg
                  </div>
                </div>
                <span className="rounded-lg bg-emerald-100 px-2.5 py-1 font-extrabold text-emerald-900">
                  +₹{(sp.fullChainSpreadPaisePerKg / 100).toFixed(0)}/kg
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 2. OFFLINE FIELD SYNC SIMULATOR + 3. DISPUTE & ARBITRATION CONSOLE  */}
      {/* =================================================================== */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* IndexedDB-Backed Offline Field Sync Engine */}
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
                isSimulatedOffline
                  ? "bg-amber-100 text-amber-950"
                  : "bg-emerald-100 text-emerald-900"
              }`}
            >
              {isSimulatedOffline ? (
                <>
                  <WifiOff className="h-3.5 w-3.5" /> OFFLINE FIELD QUEUE MODE
                </>
              ) : (
                <>
                  <Wifi className="h-3.5 w-3.5" /> ONLINE — READY TO SYNC
                </>
              )}
            </span>

            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-1 text-[11px] font-bold text-indigo-900 ring-1 ring-indigo-200">
              <Database className="h-3 w-3" /> {storageEngine} Persisted ({localQueue.length})
            </span>
          </div>

          <h3 className="text-base font-bold text-slate-900">
            IndexedDB Offline Queue (<code className="font-mono">/api/v1/sync/batch</code>)
          </h3>
          <p className="text-xs text-slate-600">
            Persists queued collections, morning <em>peshgi</em> advances, and motor splits in browser{" "}
            <code className="font-mono">IndexedDB</code> (<code className="font-mono">pending_sync_ops</code>) across page reloads—flushing atomically with <code className="font-mono">(actorId, idempotencyKey)</code> deduplication.
          </p>

          <div className="grid grid-cols-1 gap-2 text-xs">
            <button
              type="button"
              onClick={() => enqueueOfflineItem("lot")}
              className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-left font-semibold hover:bg-emerald-50"
            >
              + Queue Offline Collection Draft (18 kg Heavy Iron)
            </button>
            <button
              type="button"
              onClick={() => enqueueOfflineItem("khata")}
              className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-left font-semibold hover:bg-emerald-50"
            >
              + Queue Offline Peshgi Advance (₹400 → KC-COL-100101)
            </button>
            <button
              type="button"
              onClick={() => enqueueOfflineItem("dismantle")}
              className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-left font-semibold hover:bg-emerald-50"
            >
              + Queue Offline Motor Dismantling Split
            </button>
          </div>

          <div className="flex flex-wrap gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => hydrateFromIndexedDb(true)}
              className="flex-1 rounded-lg border border-indigo-200 bg-indigo-50/70 px-2.5 py-1.5 font-bold text-indigo-900 hover:bg-indigo-100"
            >
              Re-Hydrate Queue from {storageEngine}
            </button>
            <button
              type="button"
              onClick={() => setIsSimulatedOffline((v) => !v)}
              className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-bold text-slate-700 hover:bg-slate-100"
            >
              Toggle Connectivity
            </button>
          </div>

          {localQueue.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-xs">
              <div className="font-bold text-amber-950">
                Persisted in {storageEngine} ({localQueue.length} items):
              </div>
              <ul className="mt-1 space-y-1 text-[11px] text-amber-900">
                {localQueue.map((q) => (
                  <li key={q.idempotencyKey}>• {q.label}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  setIsSimulatedOffline(false);
                  flushBatch(localQueue, false);
                }}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-700 py-2 font-bold text-white hover:bg-emerald-800"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Reconnect, Sync & Clear {storageEngine}
              </button>
            </div>
          )}

          {lastSyncedBatch && (
            <button
              type="button"
              onClick={() => flushBatch(lastSyncedBatch, true)}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-purple-300 bg-purple-50 py-2 text-xs font-bold text-purple-950 hover:bg-purple-100"
            >
              <Repeat className="h-3.5 w-3.5" /> Re-Send Same Batch (Prove Zero Duplicate Creation!)
            </button>
          )}

          {lastSyncReport && (
            <div className="rounded-xl bg-slate-900 p-3 font-mono text-xs text-emerald-300">
              Applied: {lastSyncReport.newlyAppliedCount} · Idempotent Skipped:{" "}
              {lastSyncReport.idempotentSkippedCount} · Rejected:{" "}
              {lastSyncReport.rejectedCount}
            </div>
          )}
        </div>

        {/* Dispute & Admin Arbitration Console */}
        <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Scale className="h-5 w-5 text-rose-700" />
              <h3 className="text-base font-bold text-slate-900">
                Transaction Disputes, Escrow Freeze & Admin Arbitration
              </h3>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-700">
              {disputes.length} Cases
            </span>
          </div>

          {userRole !== "ADMIN" && orders.length > 0 && (
            <form
              onSubmit={handleRaiseDispute}
              className="grid gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs sm:grid-cols-2"
            >
              <div>
                <label className="font-semibold text-slate-700">Target Order</label>
                <select
                  value={disputeOrderId}
                  onChange={(e) => setDisputeOrderId(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2"
                >
                  {orders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.orderNumber} ({o.status})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="font-semibold text-slate-700">Dispute Category</label>
                <select
                  value={disputeCategory}
                  onChange={(e) =>
                    setDisputeCategory(e.target.value as typeof disputeCategory)
                  }
                  className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-2.5 py-2"
                >
                  <option value="WEIGHT_DISCREPANCY">Scale Weight Discrepancy</option>
                  <option value="GRADE_DISPUTE">Purity / Grade Dispute</option>
                  <option value="PRICE_CHANGE">Rate Lock Mismatch</option>
                  <option value="PAYMENT_PENDING">Settlement Payout Pending</option>
                </select>
              </div>

              <div className="sm:col-span-2">
                <input
                  required
                  value={disputeDesc}
                  onChange={(e) => setDisputeDesc(e.target.value)}
                  placeholder="Describe weight or purity issue..."
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                />
              </div>

              <div className="sm:col-span-2">
                <button
                  type="submit"
                  className="w-full rounded-xl bg-rose-700 py-2 font-bold text-white hover:bg-rose-800"
                >
                  Open Dispute & Freeze Order Settlement
                </button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {disputes.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">
                No disputes opened on this account — raise one above or switch to Security Admin to view all platform disputes.
              </p>
            ) : (
              disputes.map((d) => (
                <div
                  key={d.id}
                  className="rounded-xl border border-slate-200 p-4 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {d.status === "RESOLVED" ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      ) : (
                        <ShieldAlert className="h-4 w-4 text-rose-600" />
                      )}
                      <span className="font-mono font-bold text-slate-900">
                        {d.order.orderNumber}
                      </span>
                      <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-900">
                        {d.reasonCategory}
                      </span>
                    </div>
                    <span className="font-bold text-slate-700">
                      Dispute: {d.status} · Order: {d.order.status}
                    </span>
                  </div>

                  <p className="mt-1.5 text-slate-600">{d.description}</p>
                  {d.resolutionNotes && (
                    <div className="mt-2 rounded-lg bg-emerald-50 p-2 text-emerald-900">
                      <strong>Admin Resolution:</strong> {d.resolutionNotes}
                    </div>
                  )}

                  {userRole === "ADMIN" && d.status !== "RESOLVED" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2.5">
                      <input
                        type="number"
                        placeholder="Adjusted Payout ₹ (optional)"
                        value={adminAdjustedInr[d.id] ?? ""}
                        onChange={(e) =>
                          setAdminAdjustedInr((prev) => ({
                            ...prev,
                            [d.id]: e.target.value,
                          }))
                        }
                        className="rounded-lg border border-slate-300 px-2.5 py-1.5"
                      />
                      <button
                        type="button"
                        onClick={() => handleAdminArbitrate(d.id, "RESOLVED_ADJUSTED")}
                        className="rounded-lg bg-emerald-700 px-3 py-1.5 font-bold text-white hover:bg-emerald-800"
                      >
                        Approve & Settle
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdminArbitrate(d.id, "UNDER_REVIEW")}
                        className="rounded-lg bg-amber-600 px-3 py-1.5 font-bold text-white hover:bg-amber-700"
                      >
                        Place ON_HOLD
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdminArbitrate(d.id, "RESOLVED_CANCELLED")}
                        className="rounded-lg bg-slate-700 px-3 py-1.5 font-bold text-white hover:bg-slate-800"
                      >
                        Cancel Order
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
