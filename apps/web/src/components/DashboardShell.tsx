"use client";

// The frame every role's dashboard sits in.
//
// This exists because the old UI put six tabs on one page and showed all of them
// to everybody. The frame now decides nothing: the page that mounts inside it
// renders only the panels that role can actually use, and the API still refuses
// anything the account is not entitled to.
import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, RefreshCw, ShieldAlert, Sprout } from "lucide-react";
import type { SupplyChainTier } from "@kabadi/shared";
import {
  displayName,
  dashboardPathFor,
  useSession,
  type Session,
} from "../lib/session";

const ROLE_LABEL: Record<Session["user"]["role"], string> = {
  CUSTOMER: "Customer",
  COLLECTOR: "Collector",
  SCRAP_BUSINESS: "Scrap business",
  AUTHORISED_RECYCLER: "Recycler",
  ADMIN: "Administrator",
};

function tierLabel(session: Session): string {
  const { role, tier } = session.user;
  if (role === "ADMIN") return "Platform staff";
  // A business's tier decides which side of the chain it is on, so it is named
  // rather than printed in enum casing.
  const byTier: Record<string, string> = {
    TIER_0_GENERATOR: "Sells scrap",
    TIER_1_LOCAL_COLLECTOR: "Collects locally",
    TIER_2_AREA_SHOP: "Area shop",
    TIER_3_WHOLESALE_AGGREGATOR: "Wholesale mandi",
    TIER_4_AUTHORISED_RECYCLER: "Authorised recycler",
    PLATFORM_STAFF: "Platform staff",
  };
  return byTier[tier] ?? ROLE_LABEL[role];
}

// Which accounts may stand on a given dashboard route. Typing another role's URL is
// not an escalation -- every request inside still gets refused by the API -- but
// showing a customer an admin page made entirely of 403 panels is a dead screen,
// and the brief says a dashboard shows only what its role can use.
type Allow = { roles?: Session["user"]["role"][]; tiers?: SupplyChainTier[] };

function isAllowed(session: Session, allow?: Allow): boolean {
  if (!allow) return true;
  if (allow.roles && !allow.roles.includes(session.user.role)) return false;
  if (allow.tiers && !allow.tiers.includes(session.user.tier)) return false;
  return true;
}

export function DashboardShell({
  title,
  subtitle,
  allow,
  children,
}: {
  title: string;
  subtitle: string;
  allow?: Allow;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { state, reload, signOut } = useSession();

  // While the session is being read, show the frame with a placeholder rather
  // than bouncing to /sign-in. Redirecting on "loading" is how a refresh turns
  // into an accidental sign-out.
  if (state.status === "loading") {
    return (
      <main className="mx-auto max-w-6xl px-4 py-16">
        <p className="text-sm text-slate-500">Checking your session…</p>
      </main>
    );
  }

  if (state.status === "anonymous") {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-xl font-semibold">You are signed out</h1>
        <p className="mt-2 text-sm text-slate-600">
          Sign in to open your dashboard.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Go to sign in
        </Link>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <div className="flex items-center gap-2 text-rose-700">
          <ShieldAlert className="h-5 w-5" />
          <h1 className="text-xl font-semibold">Your session could not be read</h1>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          The API did not answer, so this page will not guess who you are.{" "}
          <span className="text-slate-400">({state.reason})</span>
        </p>
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-6 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
      </main>
    );
  }

  const { session } = state;
  const home = dashboardPathFor(session.user);

  // A signed-in account on the wrong dashboard is sent to its own, not shown here
  // and not signed out. `/dashboard` is the fallback `dashboardPathFor` returns for
  // an unrecognised role, so bouncing there would loop; it renders a plain message.
  if (!isAllowed(session, allow) && home !== "/dashboard") {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-xl font-semibold">This is not your dashboard</h1>
        <p className="mt-2 text-sm text-slate-600">
          {title} is for a different kind of account. You are signed in as{" "}
          <span className="font-medium">{ROLE_LABEL[session.user.role]}</span>.
        </p>
        <Link
          href={home}
          className="mt-6 inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Go to my dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <Link
            href={home}
            className="inline-flex items-center gap-2 text-sm font-medium text-emerald-800"
          >
            <Sprout className="h-4 w-4" /> Kabadiwala Connect
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-medium">{displayName(session.user)}</p>
          <p className="text-xs text-slate-500">
            {ROLE_LABEL[session.user.role]} · {tierLabel(session)}
          </p>
          <p className="mt-1 font-mono text-xs text-slate-400">
            {session.user.platformCode}
          </p>
          <button
            type="button"
            onClick={async () => {
              await signOut();
              router.push("/");
            }}
            className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50"
          >
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </header>
      <div className="mt-6 space-y-6">{children}</div>
    </main>
  );
}

// A shared card so six dashboards do not grow six different card styles.
export function Panel({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && (
            <p className="mt-1 text-sm text-slate-600">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// Empty and error states are shared because they kept being forgotten.
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="text-sm text-slate-500">{label}</p>;
}

export function Failure({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
    >
      {children}
    </p>
  );
}

// Money and weight formatting lives in one place. Raw paise must never reach a
// screen, and the shared package already owns the conversion.
export function FormatPaise({ paise }: { paise: number }) {
  return <>{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(paise / 100)}</>;
}
