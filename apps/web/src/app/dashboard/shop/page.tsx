"use client";

import React from "react";
import { DashboardShell } from "../../../components/DashboardShell";
import { ShopWorkspace } from "./workspace";

export default function ShopDashboard() {
  return (
    <DashboardShell
      title="Area shop"
      subtitle="You buy from collectors at your published rates, and sell up to the wholesale mandi."
      allow={{ roles: ["SCRAP_BUSINESS"], tiers: ["TIER_2_AREA_SHOP"] }}
    >
      <ShopWorkspace tierName="the wholesale mandi" />
    </DashboardShell>
  );
}
