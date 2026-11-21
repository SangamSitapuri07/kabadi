"use client";

// Shop dashboard: "I buy from collectors and sell up to the mandi".
//
// A shop's work is its rate card and the orders it owes. Both are here, and nothing
// that belongs to another tier is -- which is the whole point of splitting the old
// shared page.
import React, { useCallback, useEffect, useState } from "react";
import { api, kilograms, rupees } from "../../../lib/api";
import { useSession } from "../../../lib/session";
import { Empty, Failure, Loading, Panel } from "../../../components/DashboardShell";

interface RateItem {
  id: string;
  materialSlug?: string;
  pickupRatePaise: number;
  dropoffRatePaise: number;
  minWeightGrams: number;
  purityGrade?: string;
  material?: { slug: string; nameEn: string };
}

interface Storefront {
  id: string;
  slug: string;
  shopTitle: string;
  isOpen: boolean;
  rateItems: RateItem[];
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  items: Array<{ estimatedGrams: number; material: { nameEn: string } }>;
  weighingRecords: Array<{ actualGrams: number | null }>;
  paymentRecords: Array<{ amountPaise: number | string }>;
}

interface Material {
  slug: string;
  nameEn: string;
}

export function ShopWorkspace({ tierName }: { tierName: string }) {
  const { state } = useSession();
  const slug = state.status === "authenticated" ? state.session.user.organization?.storefront?.slug : undefined;

  const [storefront, setStorefront] = useState<Storefront | null>(null);
  // Distinct from "not loaded yet": without this, an account that simply has no
  // storefront shows "Loading your storefront…" forever.
  const [storefrontLoaded, setStorefrontLoaded] = useState(false);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const [materialSlug, setMaterialSlug] = useState("");
  const [pickupRate, setPickupRate] = useState("");
  const [dropoffRate, setDropoffRate] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [storefrontResult, ordersResult, materialsResult] = await Promise.all([
      api<{ storefronts: Storefront[] }>("/api/v1/storefronts"),
      api<{ orders: Order[] }>("/api/v1/orders"),
      api<{ categories: Material[] }>("/api/v1/materials"),
    ]);

    if (storefrontResult.ok) {
      // The listing is public, so find our own by slug rather than trusting order.
      const own = storefrontResult.data.storefronts.find((item) => item.slug === slug) ?? null;
      setStorefront(own);
      setStorefrontLoaded(true);
    } else {
      setError(storefrontResult.message);
      setStorefrontLoaded(true);
    }

    if (ordersResult.ok) setOrders(ordersResult.data.orders);
    else setOrders([]);

    if (materialsResult.ok) {
      setMaterials(materialsResult.data.categories);
      setMaterialSlug((current) => current || materialsResult.data.categories[0]?.slug || "");
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveRate(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    // Rates are entered in rupees and stored in paise; the conversion happens once,
    // here, and never by string concatenation.
    const pickupPaise = Math.round(Number(pickupRate) * 100);
    const dropoffPaise = Math.round(Number(dropoffRate) * 100);
    const result = await api<{ rate: RateItem }>("/api/v1/storefronts/my/rates", {
      method: "POST",
      json: {
        materialSlug,
        pickupRatePaise: Number.isFinite(pickupPaise) ? pickupPaise : 0,
        dropoffRatePaise: Number.isFinite(dropoffPaise) ? dropoffPaise : 0,
        minWeightGrams: 1000,
        purityGrade: "CLEAN_SORTED",
      },
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPickupRate("");
    setDropoffRate("");
    setNotice("Rate published. Customers and collectors now see this price.");
    await load();
  }

  return (
    <>
      <Panel
        title="Your rate card"
        description="The prices you pay. This is the first thing a collector compares."
      >
        {!storefrontLoaded && <Loading label="Loading your storefront…" />}
        {storefrontLoaded && storefront === null && (
          <Empty>
            No storefront is attached to this account yet, so there is no rate card to
            publish. A platform administrator creates the storefront during verification.
          </Empty>
        )}
        {storefront !== null && (
          <p className="mb-3 text-sm text-slate-600">
            <span className="font-medium">{storefront.shopTitle}</span> ·{" "}
            {storefront.isOpen ? "open" : "closed"} · {storefront.rateItems.length} published rate
            {storefront.rateItems.length === 1 ? "" : "s"}
          </p>
        )}
        {storefront !== null && storefront.rateItems.length === 0 && (
          <Empty>No rates published yet. Add your first below.</Empty>
        )}
        {storefront !== null && storefront.rateItems.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {storefront.rateItems.map((rate) => (
              <li key={rate.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-sm">
                  {rate.material?.nameEn ?? rate.materialSlug ?? "Material"}
                  {rate.purityGrade ? ` · ${rate.purityGrade.toLowerCase().replace(/_/g, " ")}` : ""}
                </span>
                <span className="text-sm text-slate-600">
                  pickup {rupees(rate.pickupRatePaise)} · drop-off {rupees(rate.dropoffRatePaise)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <form className="mt-5 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-4" onSubmit={saveRate}>
          <label className="block text-sm sm:col-span-2">
            <span className="font-medium text-slate-700">Material</span>
            <select
              value={materialSlug}
              onChange={(event) => setMaterialSlug(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              {materials.map((material) => (
                <option key={material.slug} value={material.slug}>
                  {material.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Pickup rate (₹/kg)</span>
            <input
              inputMode="decimal"
              value={pickupRate}
              onChange={(event) => setPickupRate(event.target.value.replace(/[^0-9.]/g, ""))}
              required
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Drop-off rate (₹/kg)</span>
            <input
              inputMode="decimal"
              value={dropoffRate}
              onChange={(event) => setDropoffRate(event.target.value.replace(/[^0-9.]/g, ""))}
              required
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <div className="sm:col-span-4">
            <button
              type="submit"
              disabled={saving || !materialSlug}
              className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
            >
              {saving ? "Publishing…" : "Publish rate"}
            </button>
          </div>
        </form>
        {notice && (
          <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {notice}
          </p>
        )}
        {error && <div className="mt-3"><Failure>{error}</Failure></div>}
      </Panel>

      <Panel
        title="Buying and selling"
        description={`Orders you owe to the tier above you (${tierName}), and scrap coming in.`}
      >
        {orders === null && <Loading />}
        {orders !== null && orders.length === 0 && (
          <Empty>No orders yet. They appear when material moves through your shop.</Empty>
        )}
        {orders !== null && orders.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{order.orderNumber}</p>
                  <p className="text-xs text-slate-500">
                    {order.items
                      .map((item) => `${item.material.nameEn} ${kilograms(item.estimatedGrams)}`)
                      .join(", ")}
                  </p>
                </div>
                <div className="text-right">
                  <p className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                    {order.status.replace(/_/g, " ").toLowerCase()}
                  </p>
                  {order.paymentRecords[0] && (
                    <p className="mt-1 text-xs font-medium text-emerald-700">
                      {rupees(order.paymentRecords[0].amountPaise)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
