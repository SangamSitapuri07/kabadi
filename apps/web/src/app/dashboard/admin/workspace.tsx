"use client";

// Admin: verification queue, audit trail and platform metrics.
//
// This is the one role that should see platform-wide data, and the only one whose
// panels read across accounts. Every request here is refused for a non-admin by the
// router-level guard on the API (`admin.routes.ts:19`), so the page does not need to
// be the thing that stops it -- but it still does not mount for other roles.
import React, { useCallback, useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Empty, Failure, Loading, Panel } from "../../../components/DashboardShell";

interface VerificationCase {
  id: string;
  status: string;
  createdAt: string;
  applicant?: {
    platformCode: string;
    role: string;
    profile?: { displayName: string; city: string } | null;
  } | null;
}

interface AuditEvent {
  id: string;
  action: string;
  outcome: string;
  actorRole: string | null;
  createdAt: string;
}

export function AdminWorkspace() {
  const [cases, setCases] = useState<VerificationCase[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [metrics, setMetrics] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [casesResult, eventsResult, metricsResult] = await Promise.all([
      api<{ cases: VerificationCase[] }>("/api/v1/admin/verification/cases"),
      api<{ events: AuditEvent[] }>("/api/v1/admin/audit-events?limit=25"),
      // The endpoint wraps its counts: data.metrics, not data. Reading data directly
      // meant this panel never rendered -- it failed the ok-check silently.
      api<{ metrics: Record<string, number> }>("/api/v1/admin/metrics"),
    ]);
    if (casesResult.ok) setCases(casesResult.data.cases);
    else {
      setCases([]);
      setError(casesResult.message);
    }
    if (eventsResult.ok) setEvents(eventsResult.data.events);
    else setEvents([]);
    if (metricsResult.ok) setMetrics(metricsResult.data.metrics);
    else setMetrics(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {error && <Failure>{error}</Failure>}

      {metrics && (
        <Panel title="Platform at a glance" description="Counts across every account.">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Object.entries(metrics)
              .slice(0, 8)
              .map(([key, value]) => (
                <div key={key} className="rounded-lg bg-slate-50 p-3">
                  <dt className="text-xs uppercase tracking-wide text-slate-500">
                    {key.replace(/([A-Z])/g, " $1").toLowerCase()}
                  </dt>
                  <dd className="mt-1 text-xl font-semibold">{value}</dd>
                </div>
              ))}
          </dl>
        </Panel>
      )}

      <Panel title="Verification queue" description="Accounts waiting for a KYC decision.">
        {cases === null && <Loading />}
        {cases !== null && cases.length === 0 && <Empty>Nothing waiting for review.</Empty>}
        {cases !== null && cases.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {cases.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-sm font-medium">
                    {item.applicant?.profile?.displayName ?? item.applicant?.platformCode ?? "Applicant"}
                  </p>
                  <p className="text-xs text-slate-500">
                    {item.applicant?.role.replace(/_/g, " ").toLowerCase()}
                    {item.applicant?.profile?.city ? ` · ${item.applicant.profile.city}` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                  {item.status.replace(/_/g, " ").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recent audit events" description="Append-only. Nothing here can be edited or deleted.">
        {events === null && <Loading />}
        {events !== null && events.length === 0 && <Empty>No events recorded yet.</Empty>}
        {events !== null && events.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-mono text-xs text-slate-700">{event.action}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    event.outcome === "SUCCESS"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-rose-100 text-rose-800"
                  }`}
                >
                  {event.outcome.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
