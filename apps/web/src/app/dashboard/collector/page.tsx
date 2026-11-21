"use client";

import React from "react";
import { DashboardShell } from "../../../components/DashboardShell";
import { CollectorWorkspace } from "./workspace";

export default function CollectorDashboard() {
  return (
    <DashboardShell
      title="Collector"
      subtitle="You pick up scrap from customers and sell it on to an area shop."
      allow={{ roles: ["COLLECTOR"] }}
    >
      <CollectorWorkspace />
    </DashboardShell>
  );
}
