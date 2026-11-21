'use client';

// The frame every role's dashboard sits in.
//
// Until now there was ONE signed-in view (`google-sign-in.tsx`) that rendered every
// panel for everybody: a customer saw the lot board, a shop saw the customer setup
// form. People said it directly -- "3 alag alag user login kr rha hu par har jagah
// same hi options dikh rahe h" -- and they were describing this file, not a
// permissions bug.
//
// The split is by *work*, not by hiding things: a customer posts scrap, a collector
// claims pickups, a shop prices material, an admin decides disputes. Each dashboard
// below mounts only the panels for that job.
//
// This is presentation. The API still refuses what an account may not do: hiding a
// button was never the security boundary and is not one here.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ROLES, ROLE_LABEL, dashboardPathFor, type Role } from './paths';

export { ROLES, dashboardPathFor, type Role };

export type SessionStatus = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

export interface SessionInfo {
  status: SessionStatus;
  roles: Role[] | null;
  displayName: string | null;
}

interface DashboardShellProps {
  title: string;
  subtitle: string;
  /** Who may stand on this page. Typing another role's URL is refused here. */
  allow: readonly Role[];
  children: (session: { roles: Role[] }) => React.ReactNode;
}

export function DashboardShell({ title, subtitle, allow, children }: DashboardShellProps) {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionInfo>({
    status: 'checking',
    roles: null,
    displayName: null,
  });

  useEffect(() => {
    let active = true;
    fetch('/api/v1/auth/dashboard-session', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { roles?: Role[]; displayName?: string | null; signedIn?: boolean } | null) => {
        if (!active) return;
        if (!body?.signedIn) {
          setSession({ status: 'signed-out', roles: null, displayName: null });
          return;
        }
        setSession({
          status: 'signed-in',
          roles: body.roles ?? [],
          displayName: body.displayName ?? null,
        });
      })
      .catch(() => {
        if (active) setSession({ status: 'unavailable', roles: null, displayName: null });
      });
    return () => {
      active = false;
    };
  }, []);

  if (session.status === 'checking') {
    return (
      <main className="dash">
        <p className="auth-status">Checking your account…</p>
      </main>
    );
  }

  if (session.status === 'unavailable') {
    return (
      <main className="dash">
        <h1>Your session could not be read</h1>
        <p>The API did not answer, so this page will not guess who you are.</p>
        <Link href="/">Back to sign in</Link>
      </main>
    );
  }

  if (session.status === 'signed-out') {
    return (
      <main className="dash">
        <h1>You are signed out</h1>
        <p>Sign in to open your dashboard.</p>
        <Link href="/">Go to sign in</Link>
      </main>
    );
  }

  const roles = session.roles ?? [];
  const permitted = roles.some((role) => allow.includes(role));

  if (!permitted) {
    // Not an error page: this account is valid, it is simply on someone else's
    // dashboard. Send it to its own rather than showing panels that would all fail.
    const home = dashboardPathFor(roles);
    return (
      <main className="dash">
        <h1>This is not your dashboard</h1>
        <p>
          {title} is for a different kind of account. You are signed in as{' '}
          <strong>{roles.map((role) => ROLE_LABEL[role]).join(', ') || 'an account with no role'}</strong>.
        </p>
        {home !== pathname && <Link href={home}>Go to my dashboard</Link>}
        <Link href="/">Back to sign in</Link>
      </main>
    );
  }

  return (
    <main className="dash">
      <header className="dash-head">
        <div>
          <p className="brand">
            <span aria-hidden="true">♻</span> Kabadiwala Connect
          </p>
          <h1>{title}</h1>
          <p className="description">{subtitle}</p>
        </div>
        <div className="dash-who">
          {session.displayName && <p>{session.displayName}</p>}
          <p className="roles">{roles.map((role) => ROLE_LABEL[role]).join(' · ')}</p>
          <nav>
            {roles.includes('customer') && <Link href="/dashboard/customer">Customer</Link>}
            {roles.includes('collector') && <Link href="/dashboard/collector">Collector</Link>}
            {roles.includes('shop') && <Link href="/dashboard/shop">Shop</Link>}
            {roles.includes('mandi') && <Link href="/dashboard/mandi">Mandi</Link>}
            {roles.includes('recycler') && <Link href="/dashboard/recycler">Recycler</Link>}
            {roles.includes('admin') && <Link href="/dashboard/admin">Admin</Link>}
          </nav>
        </div>
      </header>
      <div className="dash-body">{children({ roles })}</div>
    </main>
  );
}

/** A shared card, so six dashboards do not grow six card styles. */
export function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {description && <p className="description">{description}</p>}
      <div className="panel-body">{children}</div>
    </section>
  );
}
