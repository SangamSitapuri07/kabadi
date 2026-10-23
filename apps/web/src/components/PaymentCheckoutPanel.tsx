"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  CreditCard,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Lock,
  FlaskConical,
} from "lucide-react";

/**
 * Real payment checkout panel.
 *
 * - `mock` provider  → local simulator (creates a real intent, real state machine)
 * - `razorpay`       → loads checkout.razorpay.com and verifies the signature
 *                      server-side before anything is marked paid.
 *
 * The amount is NEVER sent by this component. It is derived server-side from the
 * order, so a tampered browser cannot change what is charged.
 */

interface PaymentConfig {
  provider: "mock" | "razorpay";
  currency: string;
  publicKeyId: string | null;
  keyIdEnvironment: "TEST" | "LIVE" | "MOCK";
  liveMoneyEnabled: boolean;
  simulationAllowed: boolean;
  disclaimer: string;
}

interface PaymentIntentView {
  id: string;
  intentNumber: string;
  providerOrderId: string;
  amountPaise: number;
  amountFormatted: string;
  currency: string;
  status: string;
  publicKeyId: string | null;
  checkoutMode: "MOCK_SIMULATOR" | "RAZORPAY_CHECKOUT";
  keyIdEnvironment: "TEST" | "LIVE" | "MOCK";
  paidAt: string | null;
  payments: Array<{
    providerPaymentId: string;
    status: string;
    method: string | null;
    amountPaise: number;
  }>;
  refundedPaise: number;
  refundablePaise: number;
}

interface OrderPaymentSummary {
  intents: PaymentIntentView[];
  paidPaise: number;
  payablePaise: number;
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
  prefill?: { name?: string; contact?: string };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => { open: () => void };
  }
}

function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-kabadi="razorpay-checkout"]'
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(Boolean(window.Razorpay)));
      existing.addEventListener("error", () => resolve(false));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.dataset.kabadi = "razorpay-checkout";
    script.onload = () => resolve(Boolean(window.Razorpay));
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

function paiseToInr(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const frac = Math.abs(paise) % 100;
  const grouped = whole.toLocaleString("en-IN");
  return `₹${grouped}.${String(frac).padStart(2, "0")}`;
}

export function PaymentCheckoutPanel({
  orderId,
  accessToken,
  amountPaise,
  lang = "EN",
}: {
  orderId: string;
  accessToken: string;
  amountPaise: number;
  lang?: "EN" | "HI" | "PA" | "MR";
}) {
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [summary, setSummary] = useState<OrderPaymentSummary | null>(null);
  const [busy, setBusy] = useState<null | "create" | "pay" | "refresh">(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const authHeaders = useCallback(
    () => ({ Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }),
    [accessToken]
  );

  const loadSummary = useCallback(async () => {
    const res = await fetch(`/api/v1/payments/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: "include",
    });
    const json = await res.json();
    if (json.success) setSummary(json.data);
  }, [orderId, accessToken]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/payments/config")
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled && json.success) setConfig(json.data);
      })
      .catch(() => undefined);
    loadSummary().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadSummary]);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    []
  );

  const latestIntent = summary?.intents?.[0] ?? null;
  const isPaid = latestIntent?.status === "PAID";
  const outstandingPaise = summary?.payablePaise ?? amountPaise;

  const startPolling = useCallback(
    (intentId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        try {
          const res = await fetch(`/api/v1/payments/intents/${encodeURIComponent(intentId)}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            credentials: "include",
          });
          const json = await res.json();
          if (json.success) {
            if (json.data.status === "PAID") {
              setMessage(
                lang === "HI"
                  ? "भुगतान सत्यापित हो गया"
                  : lang === "PA"
                    ? "ਭੁਗਤਾਨ ਦੀ ਪੁਸ਼ਟੀ ਹੋ ਗਈ"
                    : lang === "MR"
                      ? "पेमेंट सत्यापित झाले"
                      : "Payment verified by the gateway"
              );
              if (pollRef.current) clearInterval(pollRef.current);
              await loadSummary();
            }
          }
        } catch {
          // keep polling silently
        }
        if (attempts >= 20 && pollRef.current) clearInterval(pollRef.current);
      }, 3000);
    },
    [accessToken, lang, loadSummary]
  );

  const createIntent = useCallback(async (): Promise<PaymentIntentView | null> => {
    setBusy("create");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/payments/intents", {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
        body: JSON.stringify({ orderId }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message ?? "Could not start checkout");
        return null;
      }
      await loadSummary();
      return json.data as PaymentIntentView;
    } finally {
      setBusy(null);
    }
  }, [authHeaders, loadSummary, orderId]);

  const verifyOnServer = useCallback(
    async (
      intentId: string,
      payload: {
        razorpay_order_id: string;
        razorpay_payment_id: string;
        razorpay_signature: string;
      }
    ) => {
      const res = await fetch(
        `/api/v1/payments/intents/${encodeURIComponent(intentId)}/verify`,
        {
          method: "POST",
          headers: authHeaders(),
          credentials: "include",
          body: JSON.stringify(payload),
        }
      );
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message ?? "Payment verification failed");
        return false;
      }
      setMessage(
        json.data.status === "ALREADY_PAID" ? "Payment already confirmed" : "Payment successful"
      );
      await loadSummary();
      return true;
    },
    [authHeaders, loadSummary]
  );

  const simulate = useCallback(async () => {
    const intent = latestIntent ?? (await createIntent());
    if (!intent) return;
    setBusy("pay");
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/payments/intents/${encodeURIComponent(intent.id)}/simulate`,
        { method: "POST", headers: authHeaders(), credentials: "include" }
      );
      const json = await res.json();
      if (!json.success) {
        setError(json.error?.message ?? "Simulation failed");
        return;
      }
      setMessage(
        json.data.status === "ALREADY_PAID" ? "Already paid" : "Simulated payment captured"
      );
      await loadSummary();
    } finally {
      setBusy(null);
    }
  }, [authHeaders, createIntent, latestIntent, loadSummary]);

  const payWithRazorpay = useCallback(async () => {
    const intent = latestIntent ?? (await createIntent());
    if (!intent) return;
    setBusy("pay");
    setError(null);
    try {
      const loaded = await loadRazorpayScript();
      if (!loaded || !window.Razorpay) {
        setError("Could not load Razorpay Checkout. Check your network and try again.");
        return;
      }
      const checkout = new window.Razorpay({
        key: intent.publicKeyId ?? config?.publicKeyId ?? "",
        amount: intent.amountPaise,
        currency: intent.currency,
        name: "Kabadiwala Connect",
        description: `Order ${orderId.slice(0, 8)} · ${intent.intentNumber}`,
        order_id: intent.providerOrderId,
        theme: { color: "#047857" },
        handler: async (response) => {
          const ok = await verifyOnServer(intent.id, response);
          if (!ok) startPolling(intent.id);
        },
        modal: { ondismiss: () => startPolling(intent.id) },
      });
      checkout.open();
    } finally {
      setBusy(null);
    }
  }, [config?.publicKeyId, createIntent, latestIntent, orderId, startPolling, verifyOnServer]);

  if (!orderId || !accessToken) return null;

  const providerBadge = config?.provider === "razorpay" ? "RAZORPAY" : "LOCAL SIMULATOR";

  return (
    <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/50 p-4 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-700" />
          <span className="text-xs font-extrabold text-slate-900">Secure Payment</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              config?.liveMoneyEnabled
                ? "bg-emerald-700 text-white"
                : "bg-amber-200 text-amber-900"
            }`}
          >
            {providerBadge}
          </span>
          {config?.keyIdEnvironment === "TEST" && (
            <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-800">
              TEST MODE
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setBusy("refresh");
            loadSummary()
              .catch(() => undefined)
              .finally(() => setBusy(null));
          }}
          className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1 text-[10px] font-bold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
        >
          {busy === "refresh" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl bg-white p-3 ring-1 ring-emerald-100">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Amount due
          </div>
          <div className="text-lg font-extrabold text-slate-900">
            {paiseToInr(outstandingPaise)}
          </div>
          <div className="text-[10px] text-slate-500">
            Server-computed · cannot be edited at checkout
          </div>
        </div>
        <div className="rounded-xl bg-white p-3 ring-1 ring-emerald-100">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Status
          </div>
          <div className="flex items-center gap-1 text-sm font-extrabold">
            {isPaid ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-emerald-700" />
                <span className="text-emerald-800">Paid</span>
              </>
            ) : latestIntent ? (
              <span className="text-amber-700">{latestIntent.status}</span>
            ) : (
              <span className="text-slate-500">Not started</span>
            )}
          </div>
          {latestIntent && (
            <div className="text-[10px] text-slate-500">
              {latestIntent.intentNumber}
              {latestIntent.payments[0]?.method
                ? ` · ${latestIntent.payments[0].method.toUpperCase()}`
                : ""}
            </div>
          )}
        </div>
      </div>

      {isPaid && latestIntent && (
        <div className="mt-2 text-[10px] font-semibold text-emerald-800">
          Ref: {latestIntent.payments[0]?.providerPaymentId ?? "—"} · refundable{" "}
          {paiseToInr(latestIntent.refundablePaise)}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!isPaid && config?.provider === "razorpay" && (
          <button
            type="button"
            disabled={busy !== null || outstandingPaise <= 0}
            onClick={payWithRazorpay}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-900 disabled:opacity-50"
          >
            {busy === "pay" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CreditCard className="h-3.5 w-3.5" />
            )}
            Pay {paiseToInr(outstandingPaise)} with UPI / Card
          </button>
        )}

        {!isPaid && config?.provider === "mock" && (
          <>
            <button
              type="button"
              disabled={busy !== null || outstandingPaise <= 0}
              onClick={simulate}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-800 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-900 disabled:opacity-50"
            >
              {busy === "pay" || busy === "create" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FlaskConical className="h-3.5 w-3.5" />
              )}
              Simulate payment {paiseToInr(outstandingPaise)}
            </button>
            <span className="text-[10px] font-semibold text-amber-800">
              No real money — runs the full verified state machine locally
            </span>
          </>
        )}

        {outstandingPaise <= 0 && !isPaid && (
          <span className="text-[10px] font-semibold text-slate-600">
            Nothing to pay on this order yet.
          </span>
        )}
      </div>

      {message && (
        <div className="mt-2 flex items-center gap-1 text-[11px] font-bold text-emerald-800">
          <CheckCircle2 className="h-3.5 w-3.5" /> {message}
        </div>
      )}
      {error && (
        <div className="mt-2 flex items-start gap-1 text-[11px] font-bold text-rose-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      <div className="mt-2 flex items-center gap-1 text-[10px] text-slate-500">
        <Lock className="h-3 w-3" />
        {config?.disclaimer ??
          "Amounts are fixed server-side; every payment is signature-verified before it is marked paid."}
      </div>
    </div>
  );
}
