"use client";

// Sign-in, and the front door.
//
// The previous version auto-signed-in as one hardcoded collector on mount, kept
// the token in React state, and had no way to restore a session. Every visitor was
// therefore the same person, which is why every role looked identical. Accounts
// are still listed here for convenience -- they are seeded development identities,
// clearly labelled -- but choosing one is a real login and the result is a real
// session that survives a reload.
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Lock, Sprout } from "lucide-react";
import { dashboardPathFor, useSession, type SessionUser } from "../lib/session";

// Seeded development identities (see apps/api/prisma/seed.ts). Not secrets: they
// only exist in a local database, and the API refuses them in production because
// registration is the only way to make an account there.
const DEMO_ACCOUNTS = [
  { label: "Customer", detail: "Sells scrap", email: "customer@kabadiwala.local", pass: "KabadiPass123" },
  { label: "Collector", detail: "Collects locally", email: "collector@kabadiwala.local", pass: "KabadiPass123" },
  { label: "Area shop", detail: "Buys from collectors", email: "shop@kabadiwala.local", pass: "KabadiPass123" },
  { label: "Wholesale mandi", detail: "Buys from shops", email: "wholesale@kabadiwala.local", pass: "KabadiPass123" },
  { label: "Recycler", detail: "End of the chain", email: "recycler@kabadiwala.local", pass: "KabadiPass123" },
  { label: "Admin", detail: "Platform staff", email: "admin@kabadiwala.local", pass: "AdminPass123" },
];

type Phase = "idle" | "submitting" | "error";

export default function Home() {
  const router = useRouter();
  const { state, reload } = useSession();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  // Already signed in? Go where that account belongs. This replaces the old
  // behaviour of forgetting the session on every navigation.
  useEffect(() => {
    if (state.status === "authenticated") {
      router.replace(dashboardPathFor(state.session.user));
    }
  }, [state, router]);

  async function signIn(loginIdentifier: string, loginPassword: string) {
    setPhase("submitting");
    setMessage("");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: loginIdentifier, password: loginPassword }),
      });
      const body: unknown = await response.json().catch(() => null);
      const envelope = body as
        | { success?: boolean; data?: { user?: SessionUser }; error?: { message?: string } }
        | null;

      if (!response.ok || !envelope?.success || !envelope.data?.user) {
        // The API's own message is shown when it has one, because "invalid
        // credentials" and "account suspended" mean different things to the user.
        setPhase("error");
        setMessage(envelope?.error?.message ?? "Those details were not accepted.");
        return;
      }
      // The tokens are in httpOnly cookies, so the only thing left to do is ask
      // the API who we now are and route accordingly.
      await reload();
      router.push(dashboardPathFor(envelope.data.user));
    } catch {
      setPhase("error");
      setMessage("Sign-in could not be reached. Check that the API is running.");
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <div className="flex items-center gap-2 text-emerald-800">
        <Sprout className="h-5 w-5" />
        <span className="text-sm font-semibold">Kabadiwala Connect</span>
      </div>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        Give your scrap a <span className="text-emerald-700">new beginning.</span>
      </h1>
      <p className="mt-2 max-w-xl text-slate-600">
        Connect with local collectors, area shops, wholesale mandis and authorised
        recyclers. Every role gets its own dashboard.
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold">Sign in</h2>
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void signIn(identifier, password);
            }}
          >
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Phone or email</span>
              <input
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                required
                autoComplete="username"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-emerald-500"
              />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-emerald-500"
              />
            </label>
            <button
              type="submit"
              disabled={phase === "submitting"}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
            >
              {phase === "submitting" ? "Signing in…" : "Sign in"}
              {phase !== "submitting" && <ArrowRight className="h-4 w-4" />}
            </button>
          </form>
          {message && (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
          <p className="mt-4 text-xs text-slate-500">
            New here?{" "}
            <Link href="/sign-up" className="font-medium text-emerald-700 underline">
              Create an account
            </Link>
          </p>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-slate-400" />
            <h2 className="text-base font-semibold">Development accounts</h2>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            These exist only in a seeded local database. Each one opens a different
            dashboard.
          </p>
          <ul className="mt-4 divide-y divide-slate-100">
            {DEMO_ACCOUNTS.map((account) => (
              <li key={account.email} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="text-sm font-medium">{account.label}</p>
                  <p className="text-xs text-slate-500">{account.detail}</p>
                </div>
                <button
                  type="button"
                  disabled={phase === "submitting"}
                  onClick={() => {
                    setIdentifier(account.email);
                    setPassword(account.pass);
                    void signIn(account.email, account.pass);
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 disabled:opacity-60"
                >
                  Sign in
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
