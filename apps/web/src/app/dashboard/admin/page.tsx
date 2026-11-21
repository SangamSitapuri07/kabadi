"use client";

import React from "react";
import { DashboardShell } from "../../../components/DashboardShell";
import { AdminWorkspace } from "./workspace";

export default function AdminDashboard() {
  return (
    <DashboardShell
      title="Platform administration"
      subtitle="Verification decisions, the audit trail, and platform-wide counts."
      allow={{ roles: ["ADMIN"] }}
    >
      <AdminWorkspace />
    </DashboardShell>
  );
}
