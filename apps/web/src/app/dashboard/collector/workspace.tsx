"use client";

// Collector dashboard: "I pick up from customers and sell to shops".
//
// The collector sees the open board — public listings nobody has bought yet — and
// their own assigned work. This is the role the old page was permanently signed in
// as, which is why it looked like the only role that existed.
import React, { useCallback, useEffect, useState } from "react";
import { api, kilograms, rupees } from "../../../lib/api";
import { Empty, Failure, Loading, Panel } from "../../../components/DashboardShell";

interface OpenListing {
  id: string;
  title: string;
  pickupPincode: string;
  createdAt: string;
  items?: Array<{ estimatedGrams: number; material?: { nameEn: string } }>;
  indicativeEstimatePaise?: number | string;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  storefront: { shopTitle: string } | null;
  items: Array<{ estimatedGrams: number; material: { nameEn: string } }>;
}

export function CollectorWorkspace() {
  const [listings, setListings] = useState<OpenListing[] | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [openResult, ordersResult] = await Promise.all([
      api<{ listings: OpenListing[] }>("/api/v1/listings/open"),
      api<{ orders: Order[] }>("/api/v1/orders"),
    ]);
    if (openResult.ok) setListings(openResult.data.listings);
    else {
      setListings([]);
      setError(openResult.message);
    }
    if (ordersResult.ok) setOrders(ordersResult.data.orders);
    else setOrders([]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Panel
        title="Open pickups nearby"
        description="Scrap posted by customers that no buyer has taken yet."
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
        {listings === null && !error && <Loading />}
        {listings !== null && listings.length === 0 && (
          <Empty>No open pickups right now. Customer requests appear here.</Empty>
        )}
        {listings !== null && listings.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {listings.map((listing) => (
              <li key={listing.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{listing.title}</p>
                  <p className="text-xs text-slate-500">
                    {listing.pickupPincode}
                    {listing.items?.length
                      ? ` · ${listing.items
                          .map((item) => `${item.material?.nameEn ?? "scrap"} ${kilograms(item.estimatedGrams)}`)
                          .join(", ")}`
                      : ""}
                  </p>
                </div>
                {listing.indicativeEstimatePaise !== undefined && (
                  <p className="text-sm font-medium text-slate-700">
                    ~{rupees(listing.indicativeEstimatePaise)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Your work" description="Pickups assigned to you and their progress.">
        {orders === null && <Loading />}
        {orders !== null && orders.length === 0 && (
          <Empty>You have not accepted any pickup yet.</Empty>
        )}
        {orders !== null && orders.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">{order.orderNumber}</p>
                  <p className="text-xs text-slate-500">
                    {order.items.map((item) => item.material.nameEn).join(", ")} · to{" "}
                    {order.storefront?.shopTitle ?? "a shop"}
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
