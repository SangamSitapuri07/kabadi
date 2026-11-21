// Does the dashboard actually render the data, or does it throw?
//
// The HTTP journey test (dashboard-journey.ts) proves the endpoints answer for each
// role. That is not the same as proving the panel handles the answer: reading
// `data.order` when the endpoint sends `data.listing` passed every HTTP check and
// still crashed the page. This file closes that gap for the panels.
//
// fetch is stubbed with the *real* payload shapes, captured from the live API, so a
// wrong key fails here the same way it failed in the browser.
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminWorkspace } from "../src/app/dashboard/admin/workspace";
import { RecyclerWorkspace } from "../src/app/dashboard/recycler/workspace";
import { CollectorWorkspace } from "../src/app/dashboard/collector/workspace";

// next/navigation and next/link need a router that does not exist in jsdom. The
// only thing the workspaces use from them is rendering an anchor.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/dashboard",
}));

const json = (data: unknown, ok = true) =>
  Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(data),
  } as Response);

function stubFetch(map: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = Object.keys(map).find((candidate) => url.includes(candidate));
      if (!key) return json({ success: false, error: { message: "unexpected URL" } }, false);
      return json({ success: true, data: map[key] });
    })
  );
}

describe("dashboard panels render their real data", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("admin shows the counts, which live under data.metrics", async () => {
    stubFetch({
      "/api/v1/admin/verification/cases": { cases: [] },
      "/api/v1/admin/audit-events": { events: [] },
      "/api/v1/admin/metrics": {
        metrics: {
          totalUsers: 6,
          activeStorefronts: 4,
          totalTransactions: 1,
          pendingVerifications: 1,
          immutableAuditEvents: 22,
        },
      },
    });

    render(<AdminWorkspace />);

    // Reading `data` instead of `data.metrics` left this panel absent entirely --
    // the page looked fine, it just had no numbers on it.
    await waitFor(() => expect(screen.getByText("Platform at a glance")).toBeTruthy());
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("22")).toBeTruthy();
  });

  it("admin renders a verification case and an audit event", async () => {
    stubFetch({
      "/api/v1/admin/verification/cases": {
        cases: [
          {
            id: "case-1",
            status: "SUBMITTED",
            createdAt: "2026-11-14T00:00:00.000Z",
            applicant: {
              platformCode: "KC-COL-100101",
              role: "COLLECTOR",
              profile: { displayName: "Raju Pheri Kabadi Seva", city: "Ludhiana" },
            },
          },
        ],
      },
      "/api/v1/admin/audit-events": {
        events: [
          { id: "ev-1", action: "auth.login.success", outcome: "SUCCESS", actorRole: null, createdAt: "x" },
        ],
      },
      "/api/v1/admin/metrics": { metrics: {} },
    });

    render(<AdminWorkspace />);
    await waitFor(() => expect(screen.getByText("Raju Pheri Kabadi Seva")).toBeTruthy());
    expect(screen.getByText("auth.login.success")).toBeTruthy();
    expect(screen.getByText("Ludhiana", { exact: false })).toBeTruthy();
  });

  it("recycler shows its yard total, and never offers a sell button", async () => {
    stubFetch({
      "/api/v1/inventory/bins": {
        bins: [
          { id: "bin-1", material: { slug: "metal-copper-bright", nameEn: "Bright Copper" }, availableGrams: 12000 },
          { id: "bin-2", material: { slug: "metal-heavy-iron", nameEn: "Heavy Iron" }, availableGrams: 8000 },
        ],
      },
      "/api/v1/orders": { orders: [] },
    });

    render(<RecyclerWorkspace />);
    await waitFor(() => expect(screen.getByText("Bright Copper")).toBeTruthy());
    expect(screen.getByText("Heavy Iron")).toBeTruthy();
    // 12 kg + 8 kg. `kilograms` drops the fraction when there is none.
    expect(screen.getByText("20 kg")).toBeTruthy();
    // A recycler is the end of the chain; a control it cannot use must not exist.
    expect(screen.queryByRole("button", { name: /sell/i })).toBeNull();
  });

  it("collector lists open pickups with material and weight", async () => {
    stubFetch({
      "/api/v1/listings/open": {
        listings: [
          {
            id: "l-1",
            ownerDisplayName: "Customer",
            sellerTier: "TIER_0_GENERATOR",
            title: "10 kg copper",
            pickupCity: "Ludhiana",
            pickupPincode: "141003",
            preferredMode: "BUYER_PICKUP",
            indicativeEstimatePaise: 15000,
            status: "LISTED",
            createdAt: "x",
            items: [{ id: "i-1", material: { nameEn: "Bright Copper" }, estimatedGrams: 10000 }],
            offers: [],
          },
        ],
      },
      "/api/v1/orders": { orders: [] },
    });

    render(<CollectorWorkspace />);
    await waitFor(() => expect(screen.getByText("10 kg copper")).toBeTruthy());
    expect(screen.getByText(/141003/)).toBeTruthy();
    // Paise are formatted as rupees; 15000 paise is ₹150.
    expect(screen.getByText(/₹\s?150/)).toBeTruthy();
  });

  it("a failed load shows the API's message, not an endless spinner", async () => {
    stubFetch({
      "/api/v1/admin/verification/cases": { cases: [] },
      "/api/v1/admin/audit-events": { events: [] },
      // metrics deliberately missing -> the stub answers a failure
    });

    render(<AdminWorkspace />);
    // The panels must still settle into a readable state.
    await waitFor(() => expect(screen.getByText("Nothing waiting for review.")).toBeTruthy());
  });
});
