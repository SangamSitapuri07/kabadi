"use client";

// Registration. The role is chosen here, before the account exists, because that
// is the moment the person can actually answer it -- and because an account with no
// role has no dashboard to land on.
//
// ADMIN is deliberately absent from PUBLIC_REGISTRATION_ROLES (the API refuses it
// too): an operator account is not something a public form may create.
import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Sprout } from "lucide-react";
import { dashboardPathFor, useSession, type SessionUser } from "../../lib/session";

const ROLE_CHOICES = [
  { value: "CUSTOMER", label: "Customer — I have scrap to sell" },
  { value: "COLLECTOR", label: "Collector — I collect from customers" },
  { value: "SCRAP_BUSINESS", label: "Scrap business — shop or wholesale mandi" },
  { value: "AUTHORISED_RECYCLER", label: "Recycler — I buy from mandis in bulk" },
] as const;

export default function SignUp() {
  const router = useRouter();
  const { reload } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    phone: "",
    email: "",
    password: "",
    displayName: "",
    role: "CUSTOMER" as (typeof ROLE_CHOICES)[number]["value"],
    businessTier: "TIER_2_AREA_SHOP",
    businessName: "",
    city: "Ludhiana",
    pincode: "141001",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setMessage("");
    const payload: Record<string, unknown> = {
      phone: form.phone,
      password: form.password,
      displayName: form.displayName,
      role: form.role,
      city: form.city,
      pincode: form.pincode,
      preferredLanguage: "EN",
    };
    if (form.email.trim()) payload.email = form.email.trim();
    // Only a business has a tier, and only these two tiers may be self-selected.
    if (form.role === "SCRAP_BUSINESS") {
      payload.businessTier = form.businessTier;
      payload.businessName = form.businessName || form.displayName;
    }

    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json().catch(() => null);
      const envelope = body as
        | { success?: boolean; data?: { user?: SessionUser }; error?: { message?: string } }
        | null;
      if (!response.ok || !envelope?.success || !envelope.data?.user) {
        setSubmitting(false);
        // The API's validation message names the field that failed; repeating it is
        // more useful than a generic sentence.
        setMessage(envelope?.error?.message ?? "Registration was not accepted.");
        return;
      }
      await reload();
      router.push(dashboardPathFor(envelope.data.user));
    } catch {
      setSubmitting(false);
      setMessage("Registration could not be reached. Check that the API is running.");
    }
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-800">
        <Sprout className="h-5 w-5" /> Kabadiwala Connect
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Create an account</h1>
      <p className="mt-1 text-sm text-slate-600">
        Choose what you are. Your dashboard is built around that.
      </p>

      <form className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" onSubmit={submit}>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">I am a</span>
          <select
            value={form.role}
            onChange={(event) => set("role", event.target.value as typeof form.role)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            {ROLE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        {form.role === "SCRAP_BUSINESS" && (
          <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Which kind of business</span>
              <select
                value={form.businessTier}
                onChange={(event) => set("businessTier", event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="TIER_2_AREA_SHOP">Area shop — I buy from collectors</option>
                <option value="TIER_3_WHOLESALE_AGGREGATOR">Wholesale mandi — I buy from shops</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Business name</span>
              <input
                value={form.businessName}
                onChange={(event) => set("businessName", event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
        )}

        <label className="block text-sm">
          <span className="font-medium text-slate-700">Name</span>
          <input
            required
            minLength={2}
            maxLength={100}
            value={form.displayName}
            onChange={(event) => set("displayName", event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Mobile number</span>
          <input
            required
            inputMode="tel"
            placeholder="9876543210"
            value={form.phone}
            onChange={(event) => set("phone", event.target.value.replace(/[^0-9+]/g, ""))}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Email (optional)</span>
          <input
            type="email"
            value={form.email}
            onChange={(event) => set("email", event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(event) => set("password", event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
          <span className="mt-1 block text-xs text-slate-500">
            At least 8 characters, with an uppercase letter, a lowercase letter and a number.
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium text-slate-700">City</span>
            <input
              required
              value={form.city}
              onChange={(event) => set("city", event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">PIN code</span>
            <input
              required
              inputMode="numeric"
              maxLength={6}
              value={form.pincode}
              onChange={(event) => set("pincode", event.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Create account"}
        </button>
      </form>

      {message && (
        <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {message}
        </p>
      )}
      <p className="mt-4 text-sm text-slate-600">
        Already have an account?{" "}
        <Link href="/" className="font-medium text-emerald-700 underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
