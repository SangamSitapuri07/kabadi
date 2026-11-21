'use client';
// Area shop: buy from collectors, sell up to a wholesale mandi.
//
// A shop is a chain position, not an admin. It prices its own material and
// nothing else, so this page has no dispute or payout tools.
import { DashboardShell, Panel } from '../shell';
import { LotBoard } from '../../lot-board';
import { CatalogViewer } from '../../catalog-viewer';

export default function ShopDashboard() {
  return (
    <DashboardShell
      title="Your shop"
      subtitle="Buy from collectors, sort it, and sell up to a wholesale mandi."
      allow={['shop']}
    >
      {() => (
        <>
          <Panel title="Material you hold" description="Sell sorted material up to a mandi.">
            <LotBoard tier="shop" disabled={false} />
          </Panel>
          <Panel title="Catalogue" description="What each material is worth right now.">
            <CatalogViewer />
          </Panel>
        </>
      )}
    </DashboardShell>
  );
}
