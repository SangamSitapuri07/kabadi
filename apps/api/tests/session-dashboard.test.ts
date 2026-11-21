// The session endpoint that makes per-role dashboards possible.
//
// Without it the web app had no way to survive a page load: the access token is in
// an httpOnly cookie the browser cannot read, `/auth/refresh` returns only new
// tokens, and there was no "who am I" route. That is why the old single page signed
// in as one hardcoded collector on mount and every role looked identical.
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { closePrisma, getPrisma } from "../src/lib/prisma";
import { closeRedisRateLimiter } from "../src/lib/redisStore";
import { ensureSeeded } from "../prisma/seed";

const SEED_PASSWORD = "KabadiPass123";

describe("GET /api/v1/auth/me — session restore and per-role dashboards", () => {
  const app = createApp();

  beforeAll(async () => {
    await getPrisma();
    await ensureSeeded();
  }, 30000);

  afterAll(async () => {
    await closeRedisRateLimiter();
    await closePrisma();
  });

  async function signIn(identifier: string, password = SEED_PASSWORD) {
    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ identifier, password });
    expect(response.status).toBe(200);
    return response;
  }

  // The cookie the browser would hold. supertest's agent keeps it for us, but
  // asserting on the raw header proves the token is httpOnly rather than readable.
  function authHeader(response: request.Response): string {
    const cookies = response.headers["set-cookie"] as unknown as string[];
    const access = cookies.find((cookie) => cookie.startsWith("kc_access_token="));
    expect(access, "login must set an access-token cookie").toBeTruthy();
    return access!;
  }

  it("refuses to answer without a session, rather than guessing", async () => {
    const response = await request(app).get("/api/v1/auth/me");
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it("returns the signed-in account and its capabilities", async () => {
    const login = await signIn("shop@kabadiwala.local");
    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", authHeader(login).split(";")[0]);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const { user, capabilities } = response.body.data;

    expect(user.role).toBe("SCRAP_BUSINESS");
    // The same detail login returns, so a dashboard can render without a second call.
    expect(user.platformCode).toMatch(/^KC-/);
    expect(user.organization).toBeTruthy();
    expect(Array.isArray(capabilities)).toBe(true);
    expect(capabilities).toContain("storefront:manage:own");
  });

  it("never leaks a credential, in any casing", async () => {
    // A session endpoint that returns a hash is a worse leak than one that returns
    // the profile, so this is asserted on the raw body rather than on fields.
    const login = await signIn("customer@kabadiwala.local");
    const response = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", authHeader(login).split(";")[0]);

    const raw = JSON.stringify(response.body).toLowerCase();
    for (const forbidden of ["passwordhash", "tokenhash", "accesstoken", "refreshtoken", "familyid"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("marks the access token httpOnly so a script cannot read it", async () => {
    const login = await signIn("collector@kabadiwala.local");
    const access = authHeader(login);
    expect(access).toMatch(/HttpOnly/i);
    // SameSite=Lax is what stops a cross-site form from carrying the session.
    expect(access).toMatch(/SameSite=Lax/i);
  });

  it("gives each role a different capability set, so dashboards can differ", async () => {
    // This is the whole point of splitting the page: if every role answered with the
    // same list, a per-role dashboard would still be guesswork.
    const byRole: Record<string, string[]> = {};
    for (const [identifier, role] of [
      ["customer@kabadiwala.local", "CUSTOMER"],
      ["shop@kabadiwala.local", "SCRAP_BUSINESS"],
      ["recycler@kabadiwala.local", "AUTHORISED_RECYCLER"],
      ["admin@kabadiwala.local", "ADMIN"],
    ] as const) {
      const login = await signIn(identifier, role === "ADMIN" ? "AdminPass123" : SEED_PASSWORD);
      const response = await request(app)
        .get("/api/v1/auth/me")
        .set("Cookie", authHeader(login).split(";")[0]);
      expect(response.status).toBe(200);
      expect(response.body.data.user.role).toBe(role);
      byRole[role] = response.body.data.capabilities;
    }

    // A customer cannot bid; a shop can. An admin cannot create listings.
    expect(byRole.CUSTOMER).not.toContain("offer:create");
    expect(byRole.SCRAP_BUSINESS).toContain("offer:create");
    expect(byRole.ADMIN).not.toContain("listing:create");
    expect(byRole.ADMIN).toContain("verification:review:admin");
    // The sets are not all the same -- the defect that made every page identical.
    const distinct = new Set(Object.values(byRole).map((caps) => caps.join("|")));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("fails closed when the account is suspended, instead of serving a stale claim", async () => {
    const login = await signIn("wholesale@kabadiwala.local");
    const cookie = authHeader(login).split(";")[0];
    const prisma = await getPrisma();

    const user = await prisma.user.findFirst({ where: { email: "wholesale@kabadiwala.local" } });
    expect(user).toBeTruthy();

    await prisma.user.update({
      where: { id: user!.id },
      data: { accountStatus: "SUSPENDED" },
    });
    try {
      const response = await request(app).get("/api/v1/auth/me").set("Cookie", cookie);
      // The token is still cryptographically valid; the account is not. Serving the
      // profile here would let a suspended account keep browsing.
      //
      // The refusal comes from `authenticate`, which checks accountStatus before my
      // handler runs -- so the code is ACCOUNT_RESTRICTED, not the ACCOUNT_NOT_ACTIVE
      // this test first expected. The endpoint's own check is still correct and
      // still needed: it covers the case where the account changes between the
      // middleware's read and the handler's, and it is reached by any route that
      // mounts the handler without that middleware.
      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe("ACCOUNT_RESTRICTED");
    } finally {
      await prisma.user.update({
        where: { id: user!.id },
        data: { accountStatus: "ACTIVE" },
      });
    }
  });
});
