// Google Sign-In, without Google.
//
// The one thing this cannot test is Google's own consent screen. Everything on our
// side of the redirect is tested for real: the state is created and single-use, the
// id_token is verified (against a locally generated RSA key that stands in for
// Google's), the code exchange is mocked at the HTTP boundary, and the account
// decisions -- sign in, create, link -- run against the real database.
//
// The mocking boundary is deliberately the network, not our own functions: stubbing
// `exchangeCodeForTokens` would test that the code calls itself. Stubbing `fetch`
// means the real code path runs, including the real id_token verification.
import crypto from "crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { closePrisma, getPrisma } from "../src/lib/prisma";
import { closeRedisRateLimiter } from "../src/lib/redisStore";
import { ensureSeeded } from "../prisma/seed";
import { resetSigningKeyCache } from "../src/modules/auth/google-oauth.service";

// --- a stand-in for Google's signing key ------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";
const publicJwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: KID };

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_REDIRECT_URI: "http://localhost:4000/api/v1/auth/google/callback",
};

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** A correctly signed id_token, as Google would issue it. */
function makeIdToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: GOOGLE_ENV.GOOGLE_CLIENT_ID,
      sub: "google-sub-default",
      email: "someone@gmail.com",
      email_verified: true,
      name: "Someone",
      iat: now,
      exp: now + 3600,
      ...overrides,
    })
  );
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

// fetch is replaced only for Google's two hosts; everything else falls through to
// the real implementation so the app's own HTTP keeps working.
const realFetch = globalThis.fetch;
let currentIdToken = "";

function installGoogleStub(idToken: string) {
  currentIdToken = idToken;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Must be checked before the certs/tokeninfo branches: "oauth2.googleapis.com/
    // tokeninfo" contains ".../token", so a loose matcher here swallowed the
    // fallback verifier's call and answered it with a *valid* id_token. That made a
    // forged token look verified -- the test was wrong, not the code.
    if (url.includes("oauth2.googleapis.com/token") && !url.includes("tokeninfo")) {
      return new Response(JSON.stringify({ id_token: currentIdToken, access_token: "ya29.test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("googleapis.com/oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("oauth2.googleapis.com/tokeninfo")) {
      // Google's own verifier, stubbed to say "no". Left hitting the network, this
      // test would have passed or failed depending on whether the sandbox had
      // internet -- and it would have been testing Google, not our check.
      return new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 });
    }
    return realFetch(input as RequestInfo, init);
  });
}

describe("Google Sign-In — state, verification, and account decisions", () => {
  const app = createApp();

  beforeAll(async () => {
    Object.assign(process.env, GOOGLE_ENV);
    await getPrisma();
    await ensureSeeded();
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeRedisRateLimiter();
    await closePrisma();
  });

  /** Walks /start and returns the state Google would echo back. */
  async function startFlow(query = ""): Promise<string> {
    const response = await request(app).get(`/api/v1/auth/google/start${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.host).toBe("accounts.google.com");
    const state = location.searchParams.get("state");
    expect(state, "the redirect must carry a state").toBeTruthy();
    // PKCE is not optional here.
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    return state!;
  }

  // The signing-key cache is module-level. Without this, whichever test runs first
  // decides which keys every later test verifies against, so a forged-token test can
  // pass or fail purely on ordering.
  beforeEach(() => {
    resetSigningKeyCache();
  });

  it("advertises Google only when it is configured", async () => {
    const response = await request(app).get("/api/v1/auth/providers");
    expect(response.status).toBe(200);
    expect(response.body.data.google).toBe(true);
    // The client id must not be sent to an unauthenticated caller.
    expect(JSON.stringify(response.body)).not.toContain(GOOGLE_ENV.GOOGLE_CLIENT_ID);
  });

  it("refuses a callback whose state is unknown", async () => {
    const response = await request(app).get(
      "/api/v1/auth/google/callback?code=abc&state=never-issued"
    );
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("googleError=state_expired");
  });

  it("consumes the state, so the same callback cannot be replayed", async () => {
    installGoogleStub(makeIdToken({ sub: "replay-sub", email: "replay@gmail.com" }));
    const state = await startFlow();

    const first = await request(app).get(
      `/api/v1/auth/google/callback?code=good&state=${encodeURIComponent(state)}`
    );
    expect(first.status).toBe(302);

    // The second attempt arrives with the same, already-consumed state.
    const second = await request(app).get(
      `/api/v1/auth/google/callback?code=good&state=${encodeURIComponent(state)}`
    );
    expect(second.status).toBe(302);
    // `state_reused`, not `state_expired`: the row exists, it has been consumed.
    // Either way the callback is refused, which is the property under test.
    expect(second.headers.location).toMatch(/googleError=state_(reused|expired)/);
  });

  it("rejects an id_token signed by the wrong key", async () => {
    // Sign with a different private key while claiming the same kid: the signature
    // check must fail, not fall back to trusting the claims.
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = b64url(JSON.stringify({ alg: "RS256", kid: KID }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: GOOGLE_ENV.GOOGLE_CLIENT_ID,
        sub: "forged",
        email: "attacker@gmail.com",
        email_verified: true,
        iat: now,
        exp: now + 3600,
      })
    );
    const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), other.privateKey);
    const forged = `${header}.${payload}.${signature.toString("base64url")}`;

    installGoogleStub(forged);
    // The tokeninfo fallback would also refuse this; make it refuse loudly.
    const state = await startFlow();
    const response = await request(app).get(
      `/api/v1/auth/google/callback?code=bad&state=${encodeURIComponent(state)}`
    );
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("googleError=exchange_failed");
  });

  it("rejects an id_token issued for a different client", async () => {
    installGoogleStub(makeIdToken({ aud: "someone-elses-client-id" }));
    const state = await startFlow();
    const response = await request(app).get(
      `/api/v1/auth/google/callback?code=wrong-aud&state=${encodeURIComponent(state)}`
    );
    expect(response.headers.location).toContain("googleError=exchange_failed");
  });

  it("rejects an expired id_token", async () => {
    const now = Math.floor(Date.now() / 1000);
    installGoogleStub(makeIdToken({ exp: now - 600 }));
    const state = await startFlow();
    const response = await request(app).get(
      `/api/v1/auth/google/callback?code=old&state=${encodeURIComponent(state)}`
    );
    expect(response.headers.location).toContain("googleError=exchange_failed");
  });

  it("sends an unknown person to the chooser, and creates nothing yet", async () => {
    const prisma = await getPrisma();
    const before = await prisma.user.count();

    installGoogleStub(
      makeIdToken({ sub: "brand-new-sub", email: `new-${Date.now()}@gmail.com`, name: "New Person" })
    );
    const state = await startFlow();
    const response = await request(app).get(
      `/api/v1/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`
    );

    expect(response.status).toBe(302);
    const location = response.headers.location as string;
    expect(location).toContain("/auth/google");
    expect(location).toContain("h=");

    // The owner's requirement: ask before creating. No account, no user row.
    const after = await prisma.user.count();
    expect(after).toBe(before);
    // And no session cookie either: nothing is signed in yet.
    const cookies = (response.headers["set-cookie"] as unknown as string[]) ?? [];
    expect(cookies.some((cookie) => cookie.startsWith("kc_access_token="))).toBe(false);
  });

  it("creates an account only after the person chooses a role and gives a phone", async () => {
    installGoogleStub(
      makeIdToken({ sub: `signup-sub-${Date.now()}`, email: `signup-${Date.now()}@gmail.com`, name: "Signup Person" })
    );
    const state = await startFlow("?intent=signup&role=COLLECTOR");
    const callback = await request(app).get(
      `/api/v1/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`
    );
    const handle = new URL(callback.headers.location as string).searchParams.get("h");
    expect(handle).toBeTruthy();

    // 1. The chooser can read what it needs without the Google subject leaking.
    const pending = await request(app).get(`/api/v1/auth/google/pending?h=${handle}`);
    expect(pending.status).toBe(200);
    expect(pending.body.data.hasExistingAccount).toBe(false);
    expect(JSON.stringify(pending.body)).not.toContain("signup-sub-");

    // 2. Signing up without a phone is refused -- there is no one for a collector
    //    to call otherwise.
    const noPhone = await request(app)
      .post("/api/v1/auth/google/complete")
      .send({ handle, choice: "signup", role: "COLLECTOR" });
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error.code).toBe("PHONE_REQUIRED");

    // 3. A fresh handle (the failed attempt consumed the first one) with a phone.
    installGoogleStub(
      makeIdToken({ sub: `signup-sub2-${Date.now()}`, email: `signup2-${Date.now()}@gmail.com`, name: "Signup Two" })
    );
    const state2 = await startFlow("?intent=signup&role=COLLECTOR");
    const callback2 = await request(app).get(
      `/api/v1/auth/google/callback?code=ok&state=${encodeURIComponent(state2)}`
    );
    const handle2 = new URL(callback2.headers.location as string).searchParams.get("h")!;

    const phone = `+9199${String(Date.now()).slice(-8)}`;
    const created = await request(app)
      .post("/api/v1/auth/google/complete")
      .send({ handle: handle2, choice: "signup", role: "COLLECTOR", phone });

    expect(created.status).toBe(200);
    expect(created.body.data.user.role).toBe("COLLECTOR");
    expect(created.body.data.user.phone).toBe(phone);
    expect(created.body.data.redirectTo).toBe("/dashboard/collector");
    // A real session, the same one a password login produces.
    const cookies = (created.headers["set-cookie"] as unknown as string[]) ?? [];
    expect(cookies.some((cookie) => cookie.startsWith("kc_access_token="))).toBe(true);
  });

  it("never lets a public signup choose ADMIN", async () => {
    installGoogleStub(makeIdToken({ sub: `admin-attempt-${Date.now()}`, email: `a-${Date.now()}@gmail.com` }));
    const state = await startFlow("?intent=signup");
    const callback = await request(app).get(
      `/api/v1/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`
    );
    const handle = new URL(callback.headers.location as string).searchParams.get("h")!;

    const attempt = await request(app)
      .post("/api/v1/auth/google/complete")
      .send({ handle, choice: "signup", role: "ADMIN", phone: "+919888877776" });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.code).toBe("INVALID_ROLE");
  });

  it("offers to link an existing account when Google's verified email matches", async () => {
    // The seeded shop account, reached through Google with the same verified email.
    installGoogleStub(
      makeIdToken({
        sub: `link-sub-${Date.now()}`,
        email: "shop@kabadiwala.local",
        email_verified: true,
      })
    );
    const state = await startFlow();
    const callback = await request(app).get(
      `/api/v1/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`
    );
    const handle = new URL(callback.headers.location as string).searchParams.get("h")!;

    const pending = await request(app).get(`/api/v1/auth/google/pending?h=${handle}`);
    expect(pending.body.data.hasExistingAccount).toBe(true);
    expect(pending.body.data.existingAccountRole).toBe("SCRAP_BUSINESS");
    // The matched account's id must not travel to the browser.
    expect(JSON.stringify(pending.body)).not.toContain("8dd08096");

    const linked = await request(app)
      .post("/api/v1/auth/google/complete")
      .send({ handle, choice: "link" });
    expect(linked.status).toBe(200);
    expect(linked.body.data.user.email).toBe("shop@kabadiwala.local");
    expect(linked.body.data.redirectTo).toBe("/dashboard/shop");
  });

  it("does NOT link on an unverified email", async () => {
    installGoogleStub(
      makeIdToken({
        sub: `unverified-${Date.now()}`,
        email: "shop@kabadiwala.local",
        email_verified: false,
      })
    );
    const state = await startFlow();
    const callback = await request(app).get(
      `/api/v1/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`
    );
    const handle = new URL(callback.headers.location as string).searchParams.get("h")!;

    const pending = await request(app).get(`/api/v1/auth/google/pending?h=${handle}`);
    // An unverified address proves nothing, so no account is offered for linking.
    expect(pending.body.data.hasExistingAccount).toBe(false);
  });
});
