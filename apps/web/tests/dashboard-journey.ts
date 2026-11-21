// End-to-end proof that each role's dashboard actually renders with real data.
//
// This is the counterpart to the API-only test: that one proves the endpoints answer
// for each role, this one proves the browser-facing pages do something with them.
//
// It needs both servers running (npm run dev:api and npm run dev:web). It is NOT
// part of `vitest run` by default because it depends on two live processes; run it
// explicitly:
//
//   npx tsx apps/web/tests/dashboard-journey.ts
//
// Playwright itself could not be installed in the build sandbox (the browser CDN is
// not reachable), so this drives the same HTTP the browser would: sign in through
// the web server's own /api/v1 proxy, carry the resulting cookies, then fetch each
// dashboard route. It proves routing, the session round-trip and the proxy wiring.
// It cannot prove client-side hydration -- that still needs a real browser, and the
// gap is recorded in docs/PROGRESS.md rather than papered over.
const WEB = process.env.WEB_BASE_URL ?? "http://127.0.0.1:3000";

interface Account {
  role: string;
  identifier: string;
  password: string;
  path: string;
  expectHeading: string;
}

const ACCOUNTS: Account[] = [
  {
    role: "CUSTOMER",
    identifier: "customer@kabadiwala.local",
    password: "KabadiPass123",
    path: "/dashboard/customer",
    expectHeading: "Customer",
  },
  {
    role: "COLLECTOR",
    identifier: "collector@kabadiwala.local",
    password: "KabadiPass123",
    path: "/dashboard/collector",
    expectHeading: "Collector",
  },
  {
    role: "SCRAP_BUSINESS / TIER_2",
    identifier: "shop@kabadiwala.local",
    password: "KabadiPass123",
    path: "/dashboard/shop",
    expectHeading: "Area shop",
  },
  {
    role: "SCRAP_BUSINESS / TIER_3",
    identifier: "wholesale@kabadiwala.local",
    password: "KabadiPass123",
    path: "/dashboard/mandi",
    expectHeading: "Wholesale mandi",
  },
  {
    role: "AUTHORISED_RECYCLER",
    identifier: "recycler@kabadiwala.local",
    password: "KabadiPass123",
    path: "/dashboard/recycler",
    expectHeading: "Authorised recycler",
  },
  {
    role: "ADMIN",
    identifier: "admin@kabadiwala.local",
    password: "AdminPass123",
    path: "/dashboard/admin",
    expectHeading: "Platform administration",
  },
];

let failures = 0;

function check(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failures += 1;
  }
}

// The API rate-limits auth to 25 requests a minute per IP (`authRateLimiter`), and one
// run of this script performs 12 logins. Running it three times in a minute is a 429,
// which is the limiter working correctly -- not a product failure. Retrying once after
// the window, then failing with a plain explanation, keeps a real credential problem
// distinguishable from "you just ran the tests too fast".
async function signInIn(account: Account, attempt = 0): Promise<string> {
  const response = await fetch(`${WEB}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: account.identifier, password: account.password }),
  });

  if (response.status === 429) {
    if (attempt === 0) {
      console.log("  ..   auth rate limit hit, waiting 60s (the limiter is doing its job)");
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return signInIn(account, 1);
    }
    throw new Error(
      `rate limited twice on ${account.identifier}. The API allows 25 auth requests per ` +
        `minute and this script needs 12 per run -- wait a minute before running it again.`
    );
  }

  if (!response.ok) throw new Error(`login failed for ${account.identifier}: ${response.status}`);
  const cookies = response.headers.getSetCookie?.() ?? [];
  const jar = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  if (!jar) throw new Error(`login set no cookie for ${account.identifier}`);
  return jar;
}

async function main() {
  console.log(`Dashboard journey against ${WEB}\n`);

  for (const account of ACCOUNTS) {
    console.log(`${account.role} -> ${account.path}`);
    const jar = await signInIn(account);

    // The session the page itself will read. If this fails, the dashboard will show
    // "signed out" no matter how correct the page component is.
    const me = await fetch(`${WEB}/api/v1/auth/me`, { headers: { Cookie: jar } });
    check(me.ok, `GET /auth/me answers (${me.status})`);

    const page = await fetch(`${WEB}${account.path}`, { headers: { Cookie: jar } });
    const html = await page.text();
    check(page.ok, `${account.path} responds 200 (${page.status})`);
    // The shell's heading is rendered by the client, so the server HTML shows the
    // loading frame; what must be true is that the route exists and its bundle does.
    check(!/404/.test(html.slice(0, 400)), `${account.path} is not a 404`);

    // Every dashboard fetches at least one endpoint. Proving the endpoints answer for
    // this role is what proves the page has data to show rather than empty panels.
    const endpoints = endpointsFor(account.role);
    for (const endpoint of endpoints) {
      const result = await fetch(`${WEB}${endpoint}`, { headers: { Cookie: jar } });
      check(result.ok, `${endpoint} answers for this role (${result.status})`);
    }
    console.log("");
  }

  // The point of the whole exercise: a wrong-role visit must not show that role's
  // dashboard. The shell decides this in the browser, but the API proves the data
  // behind it is unreachable, which is the part that actually matters.
  console.log("Cross-role refusal");
  const customer = ACCOUNTS[0];
  if (!customer) throw new Error("customer account is missing from ACCOUNTS");
  const customerJar = await signInIn(customer);
  const adminMetrics = await fetch(`${WEB}/api/v1/admin/metrics`, { headers: { Cookie: customerJar } });
  check(adminMetrics.status === 403, `a customer cannot read admin metrics (${adminMetrics.status})`);
  const audit = await fetch(`${WEB}/api/v1/admin/audit-events?limit=5`, { headers: { Cookie: customerJar } });
  check(audit.status === 403, `a customer cannot read the audit trail (${audit.status})`);

  const anon = await fetch(`${WEB}/api/v1/auth/me`);
  check(anon.status === 401, `signed-out /auth/me is 401 (${anon.status})`);

  // The one write path a customer dashboard actually performs. It is checked here
  // because the page read `data.order` while the endpoint answers `data.listing`,
  // so a successful request crashed the panel. Asserting the shape catches that
  // class of mistake even though this script cannot render the panel itself.
  console.log("\nCustomer posts a listing, a collector can see it");
  const created = await fetch(`${WEB}/api/v1/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: customerJar },
    body: JSON.stringify({
      title: "Journey check — 5 kg copper",
      pickupPincode: "141003",
      pickupAddressPrivate: "Journey check address, Gill Road, Ludhiana",
      preferredMode: "BUYER_PICKUP",
      items: [{ materialSlug: "metal-copper-bright", estimatedGrams: 5000 }],
    }),
  });
  check(created.ok, `POST /listings accepted (${created.status})`);
  const createdBody = (await created.json()) as { data?: { listing?: { id: string; title: string } } };
  check(Boolean(createdBody.data?.listing?.id), "response carries data.listing (not data.order)");

  const collector = ACCOUNTS[1];
  if (!collector) throw new Error("collector account is missing from ACCOUNTS");
  const collectorJar = await signInIn(collector);
  const open = await fetch(`${WEB}/api/v1/listings/open`, { headers: { Cookie: collectorJar } });
  const openBody = (await open.json()) as { data?: { listings?: Array<{ id: string }> } };
  const visible = openBody.data?.listings?.some((item) => item.id === createdBody.data?.listing?.id);
  check(Boolean(visible), "the collector sees the listing the customer just posted");

  // The full address must not be in what a collector receives before acceptance.
  const leaked = JSON.stringify(openBody).includes("Journey check address");
  check(!leaked, "the private pickup address is not exposed to the collector");

  console.log("");
  if (failures > 0) {
    console.log(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All checks passed");
}

function endpointsFor(role: string): string[] {
  if (role === "ADMIN") {
    return ["/api/v1/admin/metrics", "/api/v1/admin/verification/cases", "/api/v1/admin/audit-events?limit=5"];
  }
  if (role === "AUTHORISED_RECYCLER") {
    return ["/api/v1/inventory/bins", "/api/v1/orders"];
  }
  return ["/api/v1/orders"];
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
