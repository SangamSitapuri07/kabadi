"use client";

import React from "react";
import { DashboardShell } from "../../../components/DashboardShell";
import { RecyclerWorkspace } from "./workspace";

export default function RecyclerDashboard() {
  return (
    <DashboardShell
      title="Authorised recycler"
      subtitle="You buy from mandis in bulk and process the material. You are the end of the chain."
      allow={{ roles: ["AUTHORISED_RECYCLER"] }}
    >
      <RecyclerWorkspace />
    </DashboardShell>
  );
}
