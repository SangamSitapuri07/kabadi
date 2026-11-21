"use client";

// Customer dashboard: "I have scrap to sell".
//
// Only what a customer can actually do lands here. The old page showed this role
// the bidding board, the AI X-ray studio, the admin operations hub and the security
// console as well -- five tabs of things the API would refuse.
import React from "react";
import { DashboardShell } from "../../../components/DashboardShell";
import { CustomerWorkspace } from "./workspace";

export default function CustomerDashboard() {
  return (
    <DashboardShell
      title="Sell your scrap"
      subtitle="Post what you have, see nearby buyers, and track what was collected."
      allow={{ roles: ["CUSTOMER"] }}
    >
      <CustomerWorkspace />
    </DashboardShell>
  );
}
