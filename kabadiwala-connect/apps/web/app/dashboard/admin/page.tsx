'use client';

// Administrator: the only dashboard with cross-account authority.
//
// Disputes and payouts are decisions about *other* people's money and material,
// so they live here and nowhere else. Catalogue editing is the third job: the
// prices every other tier trades against.
import { DashboardShell, Panel } from '../shell';
import { DisputeAdmin } from '../../dispute-admin';
import { PayoutAdmin } from '../../payout-admin';
import { CatalogAdmin } from '../../catalog-admin';
import { NotificationInbox } from '../../notification-inbox';

export default function AdminDashboard() {
  return (
    <DashboardShell
      title="Platform administration"
      subtitle="Disputes, payouts, and the prices everyone trades against."
      allow={['admin']}
    >
      {() => (
        <>
          <Panel
            title="Disputes"
            description="A disputed pickup blocks its payout until it is decided."
          >
            <DisputeAdmin disabled={false} />
          </Panel>
          <Panel title="Payouts" description="Release payment once a pickup is complete.">
            <PayoutAdmin disabled={false} />
          </Panel>
          <Panel title="Catalogue" description="Add or reprice the materials collectors sort into.">
            <CatalogAdmin categoryId={null} />
          </Panel>
          <Panel title="Notifications" description="Platform-wide activity.">
            <NotificationInbox disabled={false} />
          </Panel>
        </>
      )}
    </DashboardShell>
  );
}
