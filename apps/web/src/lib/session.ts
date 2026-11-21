"use client";

// The one place the browser learns who it is.
//
// Before this, the single page signed in as a hardcoded collector on mount, held
// the access token only in React state, and had no way to survive a reload or a
// route change. That is why every role saw the same thing: they were all the same
// account.
//
// The access token is in an httpOnly cookie, which the browser cannot read. So the
// session is recovered by asking the API (`GET /auth/me`), and re-established by
// silent refresh (`POST /auth/refresh`, which rotates the refresh token) when the
// access token has expired. Neither path returns a token to this module -- the
// cookie is the transport, and nothing here ever puts a credential in memory or in
// localStorage where an XSS would find it.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Capability, SupplyChainTier, UserRole } from "@kabadi/shared";

export interface SessionUser {
  id: string;
  phone: string;
  email: string | null;
  role: UserRole;
  tier: SupplyChainTier;
  accountStatus: string;
  verificationLevel: string;
  platformCode: string;
  platformIdDisclaimer: string;
  profile?: {
    displayName: string;
    preferredLanguage: string;
    city: string;
    pincode: string;
    addressLine?: string | null;
  } | null;
  organization?: {
    id: string;
    businessName: string;
    platformCode: string;
    tier: string;
    verificationLevel: string;
    serviceRadiusKm: number;
    storefront?: {
      id: string;
      slug: string;
      shopTitle: string;
      isOpen: boolean;
    } | null;
  } | null;
}

export interface Session {
  user: SessionUser;
  // Display hint only. Every API route checks its own grant, so a dashboard must
  // never treat a capability as an authorization decision.
  capabilities: Capability[];
}

export type SessionState =
  | { status: "loading" }
  | { status: "authenticated"; session: Session }
  // Nobody is signed in. Distinct from "unknown" so a route can redirect rather
  // than flashing a sign-in form at someone who is merely still loading.
  | { status: "anonymous" }
  | { status: "unavailable"; reason: string };

type ApiEnvelope<T> = { success: true; data: T } | { success: false; error?: { code?: string } };

async function readEnvelope<T>(response: Response): Promise<T | null> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const envelope = body as ApiEnvelope<T>;
  if (envelope.success !== true) return null;
  return envelope.data;
}

async function fetchMe(): Promise<Session | null | "unauthorized"> {
  const response = await fetch("/api/v1/auth/me", {
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (!response.ok) throw new Error(`session check failed (${response.status})`);
  const data = await readEnvelope<Session>(response);
  if (!data || !data.user) return null;
  return data;
}

// One silent refresh attempt. The refresh token rotates on every use and replays
// are treated as theft by the API, so this must never be called twice in parallel:
// `inFlight` collapses concurrent callers onto a single request.
async function refreshOnce(): Promise<boolean> {
  const response = await fetch("/api/v1/auth/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return response.ok;
}

let inFlight: Promise<void> | null = null;

export function useSession(): {
  state: SessionState;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  can: (capability: Capability) => boolean;
} {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      let session = await fetchMe();
      if (session === "unauthorized") {
        // The access token expires long before the refresh token. A 401 here is
        // usually "expired", not "signed out", so try one refresh before deciding.
        if (!inFlight) {
          inFlight = refreshOnce()
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
              inFlight = null;
            });
        }
        await inFlight;
        session = await fetchMe();
      }
      if (!mounted.current) return;
      if (session === "unauthorized" || session === null) {
        setState({ status: "anonymous" });
        return;
      }
      setState({ status: "authenticated", session });
    } catch (error) {
      if (!mounted.current) return;
      setState({
        status: "unavailable",
        reason: error instanceof Error ? error.message : "session check failed",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally {
      // Whatever the server said, the page must stop believing it has a session.
      if (mounted.current) setState({ status: "anonymous" });
    }
  }, []);

  const can = useCallback(
    (capability: Capability) =>
      state.status === "authenticated" && state.session.capabilities.includes(capability),
    [state]
  );

  // `reload` is stable and the state object is memoised so a dashboard's effect
  // dependencies do not churn on every render.
  const value = useMemo(
    () => ({ state, reload: load, signOut, can }),
    [state, load, signOut, can]
  );
  return value;
}

// Where a given account belongs. This is convenience, not authorization: the API
// decides what a role may actually do, and a hand-typed URL still lands on a page
// whose every request is refused.
//
// The mandi is NOT a role -- it is SCRAP_BUSINESS at TIER_3_WHOLESALE_AGGREGATOR
// (`packages/shared/src/index.ts:25`). Building a `/mandi` route off the brief's
// role list would have created a destination no account can be granted.
export function dashboardPathFor(user: SessionUser): string {
  switch (user.role) {
    case "CUSTOMER":
      return "/dashboard/customer";
    case "COLLECTOR":
      return "/dashboard/collector";
    case "SCRAP_BUSINESS":
      return user.tier === "TIER_3_WHOLESALE_AGGREGATOR"
        ? "/dashboard/mandi"
        : "/dashboard/shop";
    case "AUTHORISED_RECYCLER":
      return "/dashboard/recycler";
    case "ADMIN":
      return "/dashboard/admin";
    default:
      return "/dashboard";
  }
}

export function displayName(user: SessionUser): string {
  return (
    user.profile?.displayName ||
    user.organization?.businessName ||
    user.email ||
    user.phone
  );
}
