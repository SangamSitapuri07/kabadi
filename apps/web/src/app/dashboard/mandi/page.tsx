"use client";

// The mandi is not a role. It is SCRAP_BUSINESS at TIER_3_WHOLESALE_AGGREGATOR
// (packages/shared/src/index.ts:25). It gets its own route because the brief asks
// for it and because a mandi does different work from an area shop -- but the
// account, the capabilities and the API are shared, so this page reuses the same
// workspace with a different heading rather than duplicating the logic.
import React from "react";
import { DashboardShell } from "../../../components/DashboardShell";
import { ShopWorkspace } from "../shop/workspace";

export default function MandiDashboard() {
  return (
    <DashboardShell
      title="Wholesale mandi"
      subtitle="You buy from area shops in bulk, and sell up to an authorised recycler."
      allow={{ roles: ["SCRAP_BUSINESS"], tiers: ["TIER_3_WHOLESALE_AGGREGATOR"] }}
    >
      <ShopWorkspace tierName="the authorised recycler" />
    </DashboardShell>
  );
}
