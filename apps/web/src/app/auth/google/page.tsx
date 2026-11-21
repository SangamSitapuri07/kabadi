"use client";

// The screen between "Google said yes" and "you have an account".
//
// Nothing has been created when this page loads, and no session exists yet. The
// person is asked what they meant: sign in to the account that already uses this
// email, create a new one, or go back. The API holds the verified profile behind a
// short-lived handle; this page never sees the Google subject or a session token
// until a choice is made.
import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Sprout } from "lucide-react";
import { dashboardPathFor, useSession, type SessionUser } from "../../../lib/session";

interface Pending {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  hasExistingAccount: boolean;
  existingAccountRole: string | null;
  intent: string;
  roleHint: string;
}

const ROLE_CHOICES = [
  { value: "CUSTOMER", label: "Customer — I have scrap to sell", hint: "List scrap, receive offers" },
  { value: "COLLECTOR", label: "Collector — I collect from customers", hint: "Find pickups nearby" },
  { value: "SCRAP_BUSINESS", label: "Scrap business — shop or wholesale mandi", hint: "Publish rates, buy in bulk" },
  { value: "AUTHORISED_RECYCLER", label: "Recycler — I buy from mandis", hint: "Process material at the end of the chain" },
] as const;

const ROLE_LABEL: Record<string, string> = {
  CUSTOMER: "Customer",
  COLLECTOR: "Collector",
  SCRAP_BUSINESS: "Scrap business",
  AUTHORISED_RECYCLER: "Recycler",
  ADMIN: "Administrator",
};

type Step = "loading" | "choose" | "signup" | "expired" | "error";

export default function GoogleChooser() {
  const router = useRouter();
  const { reload } = useSession();
  const [step, setStep] = useState<Step>("loading");
  const [pending, setPending] = useState<Pending | null>(null);
  const [handle, setHandle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const [role, setRole] = useState<string>("CUSTOMER");
  const [phone, setPhone] = useState("");
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    // The handle arrives in the fragment, so it never reached the server and is not
    // in any access log or Referer header. Read it here and clear it from the URL so
    // it does not survive a reload into a used state.
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const fromFragment = fragment.get("h") ?? new URLSearchParams(window.location.search).get("h");
    if (!fromFragment) {
      setStep("error");
      setMessage("This page was opened without a sign-in attempt.");
      return;
    }
    setHandle(fromFragment);
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);

    fetch(`/api/v1/auth/google/pending?h=${encodeURIComponent(fromFragment)}`, {
      credentials: "include",
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { success?: boolean; data?: Pending; error?: { message?: string } }
          | null;
        if (response.status === 410) {
          setStep("expired");
          return;
        }
        if (!response.ok || !body?.success || !body.data) {
          setStep("error");
          setMessage(body?.error?.message ?? "This sign-in attempt could not be read.");
          return;
        }
        setPending(body.data);
        setDisplayName(body.data.name ?? "");
        if (body.data.roleHint && ROLE_CHOICES.some((choice) => choice.value === body.data!.roleHint)) {
          setRole(body.data.roleHint);
        }
        setStep("choose");
      })
      .catch(() => {
        setStep("error");
        setMessage("The API could not be reached.");
      });
  }, []);

  const complete = useCallback(
    async (choice: "signin" | "signup" | "link") => {
      setBusy(true);
      setMessage("");
      try {
        const response = await fetch("/api/v1/auth/google/complete", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            handle,
            choice,
            ...(choice === "signup" ? { role, phone, displayName } : {}),
          }),
        });
        const body = (await response.json().catch(() => null)) as
          | { success?: boolean; data?: { user?: SessionUser; redirectTo?: string }; error?: { message?: string } }
          | null;

        if (!response.ok || !body?.success || !body.data?.user) {
          setBusy(false);
          setMessage(body?.error?.message ?? "That did not work. Please try again.");
          return;
        }
        await reload();
        router.push(body.data.redirectTo ?? dashboardPathFor(body.data.user));
      } catch {
        setBusy(false);
        setMessage("The API could not be reached.");
      }
    },
    [handle, role, phone, displayName, reload, router]
  );

  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800">
        <Sprout className="h-5 w-5" /> Kabadiwala Connect
      </Link>

      {step === "loading" && <p className="mt-8 text-sm text-slate-500">Checking with Google…</p>}

      {step === "expired" && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
          <h1 className="text-lg font-semibold">This took too long</h1>
          <p className="mt-2 text-sm text-slate-600">
            A sign-in attempt expires after ten minutes, so it cannot be reused later.
          </p>
          <Link
            href="/"
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            <ArrowLeft className="h-4 w-4" /> Start again
          </Link>
        </div>
      )}

      {step === "error" && (
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 p-6">
          <h1 className="text-lg font-semibold text-rose-900">Sign-in could not continue</h1>
          <p className="mt-2 text-sm text-rose-800">{message}</p>
          <Link href="/" className="mt-5 inline-block text-sm font-medium text-rose-900 underline">
            Back to sign in
          </Link>
        </div>
      )}

      {step === "choose" && pending && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight">
            {pending.name ? `Hello, ${pending.name.split(" ")[0]}` : "You are signed in to Google"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {pending.email ?? "No email was shared"}
            {pending.email && !pending.emailVerified && (
              <span className="ml-1 text-amber-700">(not verified by Google)</span>
            )}
          </p>

          <p className="mt-5 text-sm font-medium text-slate-800">
            How do you want to continue?
          </p>

          <div className="mt-3 space-y-2">
            {pending.hasExistingAccount && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void complete("link")}
                className="w-full rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-left hover:bg-emerald-100 disabled:opacity-60"
              >
                <p className="text-sm font-medium text-emerald-900">
                  Sign in to my existing {ROLE_LABEL[pending.existingAccountRole ?? ""] ?? ""} account
                </p>
                <p className="text-xs text-emerald-800">
                  An account already uses this email. Signing in will also remember this Google
                  account for next time.
                </p>
              </button>
            )}

            <button
              type="button"
              disabled={busy}
              onClick={() => setStep("signup")}
              className="w-full rounded-lg border border-slate-300 px-4 py-3 text-left hover:bg-slate-50 disabled:opacity-60"
            >
              <p className="text-sm font-medium">Create a new account</p>
              <p className="text-xs text-slate-600">
                You will pick what kind of account it is, and add a mobile number.
              </p>
            </button>
          </div>

          {message && (
            <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {message}
            </p>
          )}
          <p className="mt-4 text-xs text-slate-500">Nothing has been created yet.</p>
        </div>
      )}

      {step === "signup" && (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
          <p className="mt-1 text-sm text-slate-600">
            Signed in to Google as <span className="font-medium">{pending?.email ?? "—"}</span>
          </p>

          <div className="mt-5 space-y-4">
            <fieldset>
              <legend className="text-sm font-medium text-slate-700">What are you?</legend>
              <div className="mt-2 space-y-2">
                {ROLE_CHOICES.map((choice) => (
                  <label
                    key={choice.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 ${
                      role === choice.value
                        ? "border-emerald-500 bg-emerald-50"
                        : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="radio"
                      name="role"
                      value={choice.value}
                      checked={role === choice.value}
                      onChange={() => setRole(choice.value)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-medium">{choice.label}</span>
                      <span className="block text-xs text-slate-600">{choice.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="block text-sm">
              <span className="font-medium text-slate-700">
                Mobile number <span className="text-rose-600">*</span>
              </span>
              <input
                inputMode="tel"
                value={phone}
                onChange={(event) => {
                  // Keep a leading + and digits only; drop the spaces people type.
                  const digits = event.target.value.replace(/[^0-9+]/g, "");
                  setPhone(digits.startsWith("+") ? `+${digits.slice(1).replace(/\+/g, "")}` : digits.replace(/\+/g, ""));
                }}
                placeholder="9876543210"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
              <span className="mt-1 block text-xs text-slate-500">
                Required: this is the number a collector or shop will ring. It is also how you
                sign in without Google. With or without +91.
              </span>
            </label>

            <label className="block text-sm">
              <span className="font-medium text-slate-700">Display name</span>
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || !phone.trim()}
                onClick={() => void complete("signup")}
                className="flex-1 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
              >
                {busy ? "Creating…" : "Create account"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep("choose")}
                className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium hover:bg-slate-50"
              >
                Back
              </button>
            </div>

            {message && (
              <p role="alert" className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {message}
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
