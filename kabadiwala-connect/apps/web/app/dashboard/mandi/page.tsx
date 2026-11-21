'use client';

// Wholesale mandi: buy from shops, aggregate, sell up to a recycler.
//
// The same lot board as a shop, one tier higher. That difference lives in the
// API (`sellingTier`), which is why the panel looks identical and the work does
// not: a mandi buys from shops and sells to recyclers.
import { DashboardShell, Panel } from '../shell';
import { LotBoard } from '../../lot-board';
import { CatalogViewer } from '../../catalog-viewer';

export default function MandiDashboard() {
  return (
    <DashboardShell
      title="Your mandi"
      subtitle="Aggregate from shops, then sell up to a recycler."
      allow={['mandi']}
    >
      {() => (
        <>
          <Panel title="Material you hold" description="Sell aggregated material up to a recycler.">
            <LotBoard tier="mandi" disabled={false} />
          </Panel>
          <Panel title="Catalogue" description="What each material is worth right now.">
            <CatalogViewer />
          </Panel>
        </>
      )}
    </DashboardShell>
  );
}
