"use client";

// The Google button, or nothing.
//
// It asks the API whether Google is configured before drawing itself. There are
// three possible states and only one of them shows a button:
//   - not configured      -> render nothing; a disabled button is a dead end
//   - misconfigured       -> render the reason, because an operator needs to see it
//   - configured          -> render a real link to /auth/google/start
//
// A full-page navigation (an <a href>), not fetch: the flow is a top-level redirect
// to Google and back, and doing that in fetch would land the cookies on the wrong
// request.
import React, { useEffect, useState } from "react";

type Providers = {
  google: boolean;
  googleMisconfigured: boolean;
};

export function GoogleButton({
  intent,
  role,
  redirectTo,
}: {
  intent: "signin" | "signup";
  role?: string;
  redirectTo?: string;
}) {
  const [providers, setProviders] = useState<Providers | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/v1/auth/providers", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: Providers } | null) => {
        if (!active) return;
        setProviders(body?.data ?? { google: false, googleMisconfigured: false });
      })
      .catch(() => {
        // The API being unreachable is not a reason to show a broken button.
        if (active) setProviders({ google: false, googleMisconfigured: false });
      });
    return () => {
      active = false;
    };
  }, []);

  if (!providers) return null;

  if (providers.googleMisconfigured) {
    return (
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Google sign-in is half configured on this server. Set both GOOGLE_CLIENT_ID and
        GOOGLE_CLIENT_SECRET, or neither.
      </p>
    );
  }

  if (!providers.google) return null;

  const params = new URLSearchParams({ intent });
  if (role) params.set("role", role);
  if (redirectTo) params.set("redirectTo", redirectTo);

  return (
    <div className="mt-5">
      <div className="relative">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t border-slate-200" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-white px-2 text-xs uppercase tracking-wide text-slate-400">or</span>
        </div>
      </div>
      <a
        href={`/api/v1/auth/google/start?${params.toString()}`}
        className="mt-4 flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        <GoogleMark />
        Continue with Google
      </a>
    </div>
  );
}

// The mark is drawn inline rather than fetched: one request fewer on a page whose
// whole job is to be fast on a slow connection.
function GoogleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.86c2.26-2.09 3.56-5.17 3.56-8.87Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28a7.2 7.2 0 0 1 0-4.56V6.63H1.29a11.99 11.99 0 0 0 0 10.74l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.63l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
