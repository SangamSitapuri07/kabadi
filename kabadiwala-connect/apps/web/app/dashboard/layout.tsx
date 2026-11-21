// Every dashboard reads the session per request, so nothing under /dashboard may
// be prerendered. `export const dynamic` inside a `'use client'` page is ignored
// by Next -- the route segment config has to live in a server component, and this
// layout is the nearest one above all six pages.
//
// Without it the build emitted static HTML for each dashboard: correct on the
// first request, then the same signed-out shell is handed to everybody until the
// client-side fetch corrects it, which is a visible flash of the wrong account.
export const dynamic = 'force-dynamic';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
