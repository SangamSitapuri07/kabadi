"use client";

// `/dashboard` is the fallback destination `dashboardPathFor` returns when a role
// is not one of the five it knows. Without this page that fallback is a 404, and
// without the redirect it is a dead end. It redirects to the real dashboard rather
// than rendering anything of its own -- there is no "generic dashboard", which was
// precisely the defect this work is fixing.
import React, { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dashboardPathFor, useSession } from "../../lib/session";

export default function DashboardIndex() {
  const router = useRouter();
  const { state } = useSession();

  useEffect(() => {
    if (state.status !== "authenticated") return;
    const target = dashboardPathFor(state.session.user);
    // Guard the loop: if this role's home is /dashboard itself, stay put.
    if (target !== "/dashboard") router.replace(target);
  }, [state, router]);

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
        <Link
          href="/"
          className="mt-4 inline-block rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Go to sign in
        </Link>
      </main>
    );
  }

  if (state.status === "unavailable") {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-xl font-semibold">Your session could not be read</h1>
        <p className="mt-2 text-sm text-slate-600">The API did not answer. ({state.reason})</p>
      </main>
    );
  }

  // An authenticated account whose role maps here: nothing to open.
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">No dashboard for this account</h1>
      <p className="mt-2 text-sm text-slate-600">
        This account&apos;s role has no workspace yet. An administrator can correct the
        role from the platform console.
      </p>
      <p className="mt-4 font-mono text-xs text-slate-400">{state.session.user.platformCode}</p>
    </main>
  );
}
