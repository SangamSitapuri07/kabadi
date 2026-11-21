"use client";

// Sign-in, and the front door.
//
// The previous version auto-signed-in as one hardcoded collector on mount and kept
// the token in React state, so every visitor was the same person. This one performs
// a real login and the API's httpOnly cookie is the session; a reload keeps it.
//
// There is deliberately no list of seeded accounts on this page. That block was a
// development harness, and it published working passwords in the UI.
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Sprout } from "lucide-react";
import { GoogleButton } from "../components/GoogleButton";
import { dashboardPathFor, useSession, type SessionUser } from "../lib/session";

type Phase = "idle" | "submitting" | "error";

// The chain a user lands in, shown so the sign-in page explains the product rather
// than only collecting a password.
const CHAIN = [
  { name: "Customer", detail: "Lists scrap, gets offers, watches the weight and the settlement." },
  { name: "Collector", detail: "Finds pickups nearby, collects, sells on to an area shop." },
  { name: "Area shop", detail: "Publishes rates, buys from collectors, sells to the mandi." },
  { name: "Wholesale mandi", detail: "Buys in bulk from shops, bales and sells to recyclers." },
  { name: "Recycler", detail: "Takes material at the end of the chain and processes it." },
];

export default function Home() {
  const router = useRouter();
  const { state, reload } = useSession();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");

  // Already signed in? Go where that account belongs.
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
        // The API's own message is shown when it has one, because "wrong password"
        // and "account suspended" mean different things to the person reading it.
        setPhase("error");
        setMessage(envelope?.error?.message ?? "Those details were not accepted.");
        return;
      }
      // The tokens are in httpOnly cookies, so the only thing left is to ask the API
      // who we now are and route accordingly.
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

      <div className="mt-8 grid gap-10 md:grid-cols-2 md:items-start">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Give your scrap a <span className="text-emerald-700">new beginning.</span>
          </h1>
          <p className="mt-3 text-slate-600">
            One chain, five kinds of account, and a dashboard for each. Nobody sees
            another role&apos;s tools.
          </p>

          <ol className="mt-8 space-y-4">
            {CHAIN.map((step, index) => (
              <li key={step.name} className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-xs font-semibold text-emerald-800">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-medium">{step.name}</p>
                  <p className="text-sm text-slate-600">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

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

          {/* Renders nothing at all when the API has no Google credentials, so the
              page never offers a button that can only fail. */}
          <GoogleButton intent="signin" />
          <p className="mt-4 text-xs text-slate-500">
            New here?{" "}
            <Link href="/sign-up" className="font-medium text-emerald-700 underline">
              Create an account
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
