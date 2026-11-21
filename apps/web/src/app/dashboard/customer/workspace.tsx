"use client";

import React, { useCallback, useEffect, useState } from "react";
import { api, kilograms, rupees } from "../../../lib/api";
import { Empty, Failure, Loading, Panel } from "../../../components/DashboardShell";

interface Material {
  slug: string;
  nameEn: string;
  defaultUnit: string;
}

interface OrderItem {
  id: string;
  material: { slug: string; nameEn: string };
  estimatedGrams: number;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  storefront: { shopTitle: string; slug: string } | null;
  items: OrderItem[];
  weighingRecords: Array<{ actualGrams: number | null }>;
  paymentRecords: Array<{ amountPaise: number | string; method: string }>;
}

export function CustomerWorkspace() {
  const [materials, setMaterials] = useState<Material[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  const [slug, setSlug] = useState("");
  const [kilos, setKilos] = useState("5");
  const [pincode, setPincode] = useState("");
  const [address, setAddress] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [materialsResult, ordersResult] = await Promise.all([
      api<{ categories: Material[] }>("/api/v1/materials"),
      api<{ orders: Order[] }>("/api/v1/orders"),
    ]);
    if (materialsResult.ok) {
      setMaterials(materialsResult.data.categories);
      setSlug((current) => current || materialsResult.data.categories[0]?.slug || "");
    } else {
      setMaterials([]);
      setError(materialsResult.message);
    }
    if (ordersResult.ok) setOrders(ordersResult.data.orders);
    else setOrders([]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setNotice("");
    setError("");
    const grams = Math.max(500, Math.round(Number(kilos) * 1000));
    // The endpoint answers with `listing`, not `order` -- it creates a listing that
    // buyers bid on, and an order only exists once an offer is accepted. Reading the
    // wrong key here crashed the page the moment the first request succeeded.
    const result = await api<{ listing: { id: string; title: string } }>("/api/v1/listings", {
      method: "POST",
      json: {
        title: `Pickup request — ${kilos} kg`,
        pickupPincode: pincode || "141001",
        pickupAddressPrivate: address || "Address revealed to the buyer after acceptance",
        preferredMode: "BUYER_PICKUP",
        items: [{ materialSlug: slug, estimatedGrams: grams }],
      },
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setNotice(
      `"${result.data.listing.title}" is listed. Collectors and shops nearby can now send you an offer.`
    );
    await load();
  }

  return (
    <>
      <Panel
        title="Post scrap for pickup"
        description="Tell us what you have. Buyers nearby see the material and the estimated weight — never your exact address."
      >
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Material</span>
            <select
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            >
              {(materials ?? []).map((material) => (
                <option key={material.slug} value={material.slug}>
                  {material.nameEn}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Approximate weight (kg)</span>
            <input
              inputMode="decimal"
              value={kilos}
              onChange={(event) => setKilos(event.target.value.replace(/[^0-9.]/g, ""))}
              required
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Pickup pincode</span>
            <input
              inputMode="numeric"
              maxLength={6}
              value={pincode}
              onChange={(event) => setPincode(event.target.value.replace(/\D/g, ""))}
              placeholder="141001"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">Pickup address</span>
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Kept private until a buyer is accepted"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={submitting || !slug}
              className="rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
            >
              {submitting ? "Posting…" : "Post pickup request"}
            </button>
            {materials !== null && materials.length === 0 && (
              <p className="mt-2 text-sm text-amber-700">
                No materials are loaded yet. Run the seed script to populate the catalog.
              </p>
            )}
          </div>
        </form>
        {notice && (
          <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            {notice}
          </p>
        )}
      </Panel>

      <Panel title="Your requests" description="Everything you have posted, newest first.">
        {error && <Failure>{error}</Failure>}
        {orders === null && !error && <Loading />}
        {orders !== null && orders.length === 0 && (
          <Empty>You have not posted any scrap yet.</Empty>
        )}
        {orders !== null && orders.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {orders.map((order) => {
              const weighed = order.weighingRecords[0]?.actualGrams ?? null;
              const paid = order.paymentRecords[0]?.amountPaise;
              return (
                <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="text-sm font-medium">
                      {order.items.map((item) => item.material.nameEn).join(", ") || "Scrap"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {order.orderNumber} · {order.storefront?.shopTitle ?? "Open to nearby buyers"} ·{" "}
                      {order.items.map((item) => kilograms(item.estimatedGrams)).join(", ")}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                      {order.status.replace(/_/g, " ").toLowerCase()}
                    </p>
                    {weighed !== null && (
                      <p className="mt-1 text-xs text-slate-500">Weighed {kilograms(weighed)}</p>
                    )}
                    {paid !== undefined && (
                      <p className="text-xs font-medium text-emerald-700">{rupees(paid)}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </>
  );
}
