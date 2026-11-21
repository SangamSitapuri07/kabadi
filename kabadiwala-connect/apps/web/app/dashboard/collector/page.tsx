'use client';

// Collector: claim open pickups, then sell what you collected up the chain.
//
// A collector is both a worker and a seller, so this page carries two panels --
// but only ever the two that belong to this job. The tier is fixed for a
// collector; it is not something the page gets to choose.
import { DashboardShell, Panel } from '../shell';
import { CollectorQueue } from '../../collector-queue';
import { LotBoard } from '../../lot-board';

export default function CollectorDashboard() {
  return (
    <DashboardShell
      title="Your rounds"
      subtitle="Claim open pickups, then sell what you collected to a shop."
      allow={['collector']}
    >
      {() => (
        <>
          <Panel
            title="Open pickups"
            description="Claim a request to collect it. Claims you hold are listed with it."
          >
            <CollectorQueue disabled={false} />
          </Panel>
          <Panel
            title="Material you hold"
            description="Sell collected material to an area shop."
          >
            <LotBoard tier="collector" disabled={false} />
          </Panel>
        </>
      )}
    </DashboardShell>
  );
}
