"use client";

// Recycler dashboard: the end of the chain.
//
// A recycler is terminal -- material is processed here, not sold onward. So this
// page does NOT offer "sell upward" the way a shop does; it shows what is in the
// yard and what has been dismantled. Offering a sale button that the API would
// always refuse is exactly the kind of dead control the brief forbids.
import React, { useCallback, useEffect, useState } from "react";
import { api, kilograms } from "../../../lib/api";
import { Empty, Failure, Loading, Panel } from "../../../components/DashboardShell";

interface Bin {
  id: string;
  material: { nameEn: string; slug: string };
  availableGrams: number;
  reservedGrams?: number;
  updatedAt?: string;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  items: Array<{ estimatedGrams: number; material: { nameEn: string } }>;
}

export function RecyclerWorkspace() {
  const [bins, setBins] = useState<Bin[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [binsResult, ordersResult] = await Promise.all([
      api<{ bins: Bin[] }>("/api/v1/inventory/bins"),
      api<{ orders: Order[] }>("/api/v1/orders"),
    ]);
    if (binsResult.ok) setBins(binsResult.data.bins);
    else {
      setBins([]);
      setError(binsResult.message);
    }
    if (ordersResult.ok) setOrders(ordersResult.data.orders);
    else setOrders([]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalGrams = (bins ?? []).reduce((sum, bin) => sum + bin.availableGrams, 0);

  return (
    <>
      <Panel
        title="In your yard"
        description="Material you have bought in, by material. This is the end of the chain — it is processed here, not resold."
        action={
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            Refresh
          </button>
        }
      >
        {error && <Failure>{error}</Failure>}
        {bins === null && !error && <Loading />}
        {bins !== null && bins.length === 0 && (
          <Empty>Your yard is empty. Stock appears when a mandi sells to you.</Empty>
        )}
        {bins !== null && bins.length > 0 && (
          <>
            <p className="mb-3 text-sm text-slate-600">
              Total held: <span className="font-medium">{kilograms(totalGrams)}</span>
            </p>
            <ul className="divide-y divide-slate-100">
              {bins.map((bin) => (
                <li key={bin.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-sm">{bin.material?.nameEn ?? bin.material?.slug}</span>
                  <span className="text-sm font-medium">{kilograms(bin.availableGrams)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>

      <Panel title="Received from mandis" description="Bulk purchases that have moved to your yard.">
        {orders === null && <Loading />}
        {orders !== null && orders.length === 0 && (
          <Empty>Nothing received yet.</Empty>
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
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                  {order.status.replace(/_/g, " ").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
