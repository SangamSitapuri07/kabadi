'use client';

// Recycler: the top of the chain. Buys from mandis and processes.
//
// There is no tier above a recycler, so there is no Sell panel -- the lot board
// still shows what was received, because a recycler needs to see its intake.
import { DashboardShell, Panel } from '../shell';
import { LotBoard } from '../../lot-board';
import { CatalogViewer } from '../../catalog-viewer';

export default function RecyclerDashboard() {
  return (
    <DashboardShell
      title="Your plant"
      subtitle="Receive material from mandis and process it."
      allow={['recycler']}
    >
      {() => (
        <>
          <Panel
            title="Material received"
            description="Everything currently held at your plant, with its custody history."
          >
            <LotBoard tier="recycler" disabled={false} />
          </Panel>
          <Panel title="Catalogue" description="What each material is worth right now.">
            <CatalogViewer />
          </Panel>
        </>
      )}
    </DashboardShell>
  );
}
