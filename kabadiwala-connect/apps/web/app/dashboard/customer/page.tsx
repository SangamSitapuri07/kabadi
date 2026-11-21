'use client';
// Customer: post scrap, watch its pickup status.
//
// Deliberately narrow. A customer does not price material, does not see other
// people's pickups, and does not read the catalogue as a seller -- so none of
// those panels are mounted here.
import Link from 'next/link';
import { DashboardShell, Panel } from '../shell';
import { TestPickups } from '../../test-pickups';

export default function CustomerDashboard() {
  return (
    <DashboardShell
      title="Your scrap"
      subtitle="Request a pickup and follow it until a collector arrives."
      allow={['customer']}
    >
      {() => (
        <>
          <Panel
            title="Request a pickup"
            description="Post what you have and a collector nearby can claim it."
          >
            <TestPickups />
          </Panel>
        </>
      )}
    </DashboardShell>
  );
}
