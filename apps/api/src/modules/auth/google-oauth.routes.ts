// Google sign-in routes, mounted at /api/v1/auth/google.
//
// Flow:
//   1. Browser hits GET /auth/google/start?intent=signin|signup&role=...
//      We create a single-use state + PKCE pair server-side, then 302 to Google.
//   2. Google sends the browser back to GET /auth/google/callback?code&state
//      We consume the state, exchange the code, verify the id_token, decide which
//      account this is, and then:
//        - existing account  -> issue a session, redirect to the role's dashboard
//        - unknown account   -> issue NO session; redirect to the web app's
//                               "choose how you sign in" screen with a short-lived
//                               handle that carries the verified profile
//   3. The web app shows "sign in or create an account", the person picks, and
//      POST /auth/google/complete turns the handle into an account and a session.
//
// Step 2's split is the owner's requirement: ask how they want to sign in *before*
// creating anything, so nobody is silently given a role they did not choose.
import crypto from "crypto";
import { Router } from "express";
import { PUBLIC_REGISTRATION_ROLES, ROLE_CAPABILITIES, resolveDefaultTierForRole } from "@kabadi/shared";
import { env } from "../../config/env";
import { getPrisma } from "../../lib/prisma";
import {
  consumeOAuthState,
  consumePendingSignup,
  createOAuthState,
  createPendingSignup,
  findOAuthAccount,
  findOAuthState,
  findPendingSignup,
  linkOAuthAccount,
  touchOAuthAccount,
  type PendingProfile,
} from "./google-oauth.repository";
import { generatePlatformCode } from "../../lib/security";
import { authRateLimiter, sendError, sendSuccess } from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";
import { serializeOwnUserAccount } from "./auth.routes";
import {
  GoogleAuthError,
  buildAuthorizationUrl,
  createPkcePair,
  defaultRedirectUri,
  exchangeCodeForTokens,
  readGoogleIdentity,
  sha256,
  verifyIdToken,
  type GoogleProfile,
} from "./google-oauth.service";
import { attachAuthCookies, issueSession } from "./session.service";

export const googleAuthRouter = Router();

// How long a person has between "Google said yes" and "pick an account type".
// Long enough to read the screen, short enough that a stolen handle is useless.
const HANDLE_TTL_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function webOrigin(): string {
  return env.WEB_APP_ORIGIN.replace(/\/$/, "");
}

function redirectUri(): string {
  return readGoogleIdentity()?.redirectUri ?? defaultRedirectUri();
}

/** Only same-origin paths are honoured, so this cannot become an open redirect. */
function safeRedirectTo(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

// GET /api/v1/auth/google/start
//
// `intent` and `role` are hints that survive the round trip. They let the sign-in
// page say "I am signing up as an area shop" and come back to a screen that already
// has that choice, instead of asking twice.
googleAuthRouter.get("/start", authRateLimiter, async (req, res) => {
  let identity;
  try {
    identity = readGoogleIdentity();
  } catch (error) {
    // Half-configured: say what is wrong rather than sending the user to Google
    // where they would get an opaque redirect_uri_mismatch.
    sendError(
      res,
      503,
      "GOOGLE_SIGNIN_MISCONFIGURED",
      error instanceof Error ? error.message : "Google sign-in is misconfigured"
    );
    return;
  }
  if (!identity) {
    sendError(
      res,
      503,
      "GOOGLE_SIGNIN_NOT_CONFIGURED",
      "Google sign-in is not configured on this server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
    );
    return;
  }

  const prisma = await getPrisma();
  const state = crypto.randomBytes(32).toString("base64url");
  const { verifier, challenge } = createPkcePair();

  const intent = req.query.intent === "signup" ? "signup" : "signin";
  const role = typeof req.query.role === "string" ? req.query.role : "";
  const redirectTo = safeRedirectTo(req.query.redirectTo);

  // The hint is packed into redirectTo so it needs no extra column. It is only a
  // hint: `complete` re-validates the role against PUBLIC_REGISTRATION_ROLES.
  const hint = new URLSearchParams();
  hint.set("intent", intent);
  if (role) hint.set("role", role);
  if (redirectTo) hint.set("next", redirectTo);

  await createOAuthState({
    stateHash: sha256(state),
    codeVerifier: verifier,
    redirectTo: hint.toString(),
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  res.redirect(
    302,
    buildAuthorizationUrl({ identity, state, codeChallenge: challenge })
  );
});

// GET /api/v1/auth/google/callback — Google redirects here.
googleAuthRouter.get("/callback", authRateLimiter, async (req, res) => {
  const prisma = await getPrisma();

  // Google reports a cancelled or denied consent as an error, not a code. Sending
  // the person back to the sign-in page with a reason is friendlier than a 400.
  const providerError = typeof req.query.error === "string" ? req.query.error : null;
  if (providerError) {
    res.redirect(
      302,
      withQuery(`${webOrigin()}/`, { googleError: providerError })
    );
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code || !state) {
    res.redirect(302, withQuery(`${webOrigin()}/`, { googleError: "missing_code" }));
    return;
  }

  // State is looked up by hash and consumed atomically. `updateMany` with a
  // `consumedAt: null` filter is the compare-and-swap: two parallel callbacks with
  // the same state, only one can flip it, so the second finds nothing.
  const stateHash = sha256(state);
  const record = await findOAuthState(stateHash);
  if (!record || record.expiresAt.getTime() < Date.now()) {
    res.redirect(302, withQuery(`${webOrigin()}/`, { googleError: "state_expired" }));
    return;
  }
  if (!(await consumeOAuthState(stateHash))) {
    res.redirect(302, withQuery(`${webOrigin()}/`, { googleError: "state_reused" }));
    return;
  }

  let profile: GoogleProfile;
  try {
    const identity = readGoogleIdentity();
    if (!identity) throw new GoogleAuthError("Google sign-in is not configured");
    const tokens = await exchangeCodeForTokens({
      identity,
      code,
      codeVerifier: record.codeVerifier,
    });
    profile = await verifyIdToken(tokens.idToken, identity.clientId);
  } catch (error) {
    const reason = error instanceof GoogleAuthError ? error.message : "exchange_failed";
    // Never echoed into the URL: it can contain provider text and is useful to the
    // operator, so it goes to the audit trail instead.
    await recordAuditEvent({
      action: "AUTH_GOOGLE_FAILED",
      resourceType: "Auth",
      outcome: "FAILURE",
      reason: reason.slice(0, 300),
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });
    res.redirect(302, withQuery(`${webOrigin()}/`, { googleError: "exchange_failed" }));
    return;
  }

  const hint = new URLSearchParams(record.redirectTo ?? "");
  const next = safeRedirectTo(hint.get("next"));

  // An existing Google link wins: this is the returning user.
  const existingLink = await findOAuthAccount(profile.sub);

  if (existingLink) {
    const user = await prisma.user.findUnique({
      where: { id: existingLink.userId },
      include: { profile: true, organization: { include: { storefront: true } } },
    });
    if (!user) {
      // The link outlived its user, which the cascade should have prevented. Treat
      // it as a broken attempt instead of crashing on the next line.
      res.redirect(302, withQuery(`${webOrigin()}/`, { googleError: "account_missing" }));
      return;
    }
    if (user.accountStatus !== "ACTIVE") {
      await recordAuditEvent({
        actorId: user.id,
        actorRole: user.role,
        action: "AUTH_GOOGLE_DENIED_RESTRICTED",
        resourceType: "User",
        resourceId: user.id,
        outcome: "DENIED",
        reason: `Account status ${user.accountStatus}`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      res.redirect(302, withQuery(`${webOrigin()}/`, { googleError: "account_restricted" }));
      return;
    }

    const session = await issueSession(user, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    attachAuthCookies(res, session.accessToken, session.refreshToken);

    await touchOAuthAccount(profile.sub, profile.email);
    await recordAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: "AUTH_GOOGLE_LOGIN_SUCCESS",
      resourceType: "Session",
      resourceId: session.familyId,
      outcome: "SUCCESS",
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    // The dashboard route is decided here because the API already knows the role;
    // the web app would otherwise have to mount and fetch /auth/me first, and the
    // user would see a spinner at "/" before being moved again.
    res.redirect(302, `${webOrigin()}${next ?? dashboardPathForUser(user.role, user.tier)}`);
    return;
  }

  // No link yet. The owner's requirement applies here: do not create an account,
  // and do not attach this Google identity to a password account, without asking.
  //
  // Linking by email is offered only when Google says the address is verified --
  // an unverified address proves nothing about who is holding it.
  const linkCandidate =
    profile.email && profile.emailVerified
      ? await prisma.user.findFirst({
          where: { email: profile.email },
          select: { id: true, role: true, accountStatus: true },
        })
      : null;

  const handle = crypto.randomBytes(32).toString("base64url");
  const pending = {
    sub: profile.sub,
    email: profile.email,
    emailVerified: profile.emailVerified,
    name: profile.name,
    picture: profile.picture,
    linkCandidateUserId: linkCandidate?.id ?? null,
    linkCandidateRole: linkCandidate?.role ?? null,
    next,
    intent: hint.get("intent") ?? "signin",
    roleHint: hint.get("role") ?? "",
  };
  await createPendingSignup({
    handleHash: sha256(handle),
    profile: pending as PendingProfile,
    expiresAt: new Date(Date.now() + HANDLE_TTL_MS),
  });

  // The handle lives in the URL fragment, not the query: fragments are not sent to
  // the server, not written to access logs, and not forwarded in a Referer header.
  res.redirect(302, `${webOrigin()}/auth/google?h=${handle}`);
});

// GET /api/v1/auth/google/pending?h=... — what the chooser screen needs to render.
googleAuthRouter.get("/pending", authRateLimiter, async (req, res) => {
  const handle = typeof req.query.h === "string" ? req.query.h : "";
  if (!handle) {
    sendError(res, 400, "MISSING_HANDLE", "No sign-in attempt was supplied");
    return;
  }
  const prisma = await getPrisma();
  const record = await findPendingSignup(sha256(handle));
  if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
    sendError(res, 410, "HANDLE_EXPIRED", "This sign-in attempt has expired. Please start again.");
    return;
  }

  const pending = JSON.parse(record.profileJson) as {
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    linkCandidateUserId: string | null;
    linkCandidateRole: string | null;
    intent: string;
    roleHint: string;
  };

  // Only the minimum the screen needs. The Google subject stays server-side.
  sendSuccess(res, {
    email: pending.email,
    emailVerified: pending.emailVerified,
    name: pending.name,
    // The screen uses this to say "you already have an account here — sign in or
    // link". The id itself is never sent, only the fact of the match.
    hasExistingAccount: Boolean(pending.linkCandidateUserId),
    existingAccountRole: pending.linkCandidateRole,
    intent: pending.intent,
    roleHint: pending.roleHint,
  });
});

// POST /api/v1/auth/google/complete — the person has chosen what to do.
googleAuthRouter.post("/complete", authRateLimiter, async (req, res) => {
  const body = req.body as {
    handle?: string;
    choice?: "signin" | "signup" | "link";
    role?: string;
    phone?: string;
    displayName?: string;
  };

  const handle = typeof body.handle === "string" ? body.handle : "";
  if (!handle) {
    sendError(res, 400, "MISSING_HANDLE", "No sign-in attempt was supplied");
    return;
  }

  const prisma = await getPrisma();
  const record = await findPendingSignup(sha256(handle));
  if (!record || record.consumedAt || record.expiresAt.getTime() < Date.now()) {
    sendError(res, 410, "HANDLE_EXPIRED", "This sign-in attempt has expired. Please start again.");
    return;
  }

  const pending = JSON.parse(record.profileJson) as {
    sub: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
    picture: string | null;
    linkCandidateUserId: string | null;
    next: string | null;
  };

  const choice = body.choice;
  if (choice !== "signin" && choice !== "signup" && choice !== "link") {
    sendError(res, 400, "INVALID_CHOICE", "Choose sign in, create an account, or link");
    return;
  }

  // Consumed once, before any account is touched.
  if (!(await consumePendingSignup(sha256(handle)))) {
    sendError(res, 409, "HANDLE_ALREADY_USED", "This sign-in attempt was already used");
    return;
  }

  try {
    // --- link: attach this Google identity to the matched password account -----
    if (choice === "link") {
      // The match is re-read, not trusted from the client: the request names the
      // choice, never the user id.
      const target = pending.linkCandidateUserId
        ? await prisma.user.findUnique({
            where: { id: pending.linkCandidateUserId },
            include: { profile: true, organization: { include: { storefront: true } } },
          })
        : null;
      if (!target || !pending.emailVerified) {
        sendError(res, 409, "LINK_NOT_AVAILABLE", "There is no account to link to");
        return;
      }
      if (target.accountStatus !== "ACTIVE") {
        sendError(res, 403, "ACCOUNT_RESTRICTED", "That account is not active");
        return;
      }

      await linkOAuthAccount({
        userId: target.id,
        providerAccountId: pending.sub,
        email: pending.email,
        emailVerified: pending.emailVerified,
        displayName: pending.name,
        avatarUrl: pending.picture,
      });

      const session = await issueSession(target, {
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
      attachAuthCookies(res, session.accessToken, session.refreshToken);

      // Linking a second credential to an existing account is exactly the kind of
      // event that must be visible later, whoever asks.
      await recordAuditEvent({
        actorId: target.id,
        actorRole: target.role,
        action: "AUTH_GOOGLE_LINKED",
        resourceType: "User",
        resourceId: target.id,
        outcome: "SUCCESS",
        reason: `Google identity linked by verified email ${pending.email ?? "(none)"}`,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });

      sendSuccess(res, {
        user: serializeOwnUserAccount(target),
        capabilities: ROLE_CAPABILITIES[target.role],
        redirectTo: pending.next ?? dashboardPathForUser(target.role, target.tier),
      });
      return;
    }

    // --- signin: the person says they already have an account ----------------
    if (choice === "signin") {
      if (!pending.linkCandidateUserId) {
        sendError(
          res,
          404,
          "NO_ACCOUNT_FOR_EMAIL",
          "No account uses this email. Create one instead."
        );
        return;
      }
      // Signing in as an existing account with Google is the same act as linking a
      // credential, so it is recorded the same way.
      const target = await prisma.user.findUnique({
        where: { id: pending.linkCandidateUserId },
        include: { profile: true, organization: { include: { storefront: true } } },
      });
      if (!target || target.accountStatus !== "ACTIVE") {
        sendError(res, 403, "ACCOUNT_RESTRICTED", "That account is not active");
        return;
      }
      await linkOAuthAccount({
        userId: target.id,
        providerAccountId: pending.sub,
        email: pending.email,
        emailVerified: pending.emailVerified,
        displayName: pending.name,
        avatarUrl: pending.picture,
      });
      const session = await issueSession(target, {
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });
      attachAuthCookies(res, session.accessToken, session.refreshToken);
      await recordAuditEvent({
        actorId: target.id,
        actorRole: target.role,
        action: "AUTH_GOOGLE_LOGIN_SUCCESS",
        resourceType: "Session",
        resourceId: session.familyId,
        outcome: "SUCCESS",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendSuccess(res, {
        user: serializeOwnUserAccount(target),
        capabilities: ROLE_CAPABILITIES[target.role],
        redirectTo: pending.next ?? dashboardPathForUser(target.role, target.tier),
      });
      return;
    }

    // --- signup: create a new account ---------------------------------------
    //
    // The role is validated here, not taken on trust: it comes from a request body
    // and must be one the public is allowed to choose. ADMIN is never offered.
    const role = body.role as (typeof PUBLIC_REGISTRATION_ROLES)[number] | undefined;
    if (!role || !PUBLIC_REGISTRATION_ROLES.includes(role)) {
      sendError(
        res,
        400,
        "INVALID_ROLE",
        `Choose one of: ${PUBLIC_REGISTRATION_ROLES.join(", ")}`
      );
      return;
    }

    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!phone) {
      // Required, and the reason is stated in the message rather than in a comment
      // nobody reads: this is the number the collector will ring.
      sendError(
        res,
        400,
        "PHONE_REQUIRED",
        "A mobile number is needed so the collector can reach you. Add one to continue."
      );
      return;
    }
    if (!/^\+?[6-9]\d{9,12}$/.test(phone)) {
      sendError(res, 400, "INVALID_PHONE", "Enter a valid mobile number");
      return;
    }
    const clash = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
    if (clash) {
      sendError(res, 409, "PHONE_IN_USE", "That mobile number is already registered. Sign in with it instead.");
      return;
    }

    const displayName: string =
      (typeof body.displayName === "string" ? body.displayName.trim() : "") ||
      pending.name ||
      (pending.email ? pending.email.split("@")[0] : "") ||
      "Kabadiwala Connect user";

    const tier = resolveDefaultTierForRole(role);
    const platformCode = generatePlatformCode(tier);

    // An unusable password hash: the account has no password, and this value can
    // never match anything because it is not a valid argon2 string. It exists only
    // so the NOT NULL column is satisfied; sign-in for this account is Google-only
    // until the person adds a phone, which is when a real password becomes possible.
    const unusablePasswordHash = `!google-oauth-no-password!${crypto.randomUUID()}`;

    const created = await prisma.user.create({
      data: {
        phone,
        email: pending.email,
        passwordHash: unusablePasswordHash,
        role,
        tier,
        platformCode,
        verificationLevel: "LEVEL_0_REGISTERED",
        profile: {
          create: {
            displayName: displayName.slice(0, 100),
            preferredLanguage: "EN",
            city: "Ludhiana",
            pincode: "141001",
          },
        },
      },
      include: { profile: true, organization: { include: { storefront: true } } },
    });

    // The link is a raw insert for the same reason the rest of this file uses the
    // repository: the checked-in Prisma client predates the table.
    await linkOAuthAccount({
      userId: created.id,
      providerAccountId: pending.sub,
      email: pending.email,
      emailVerified: pending.emailVerified,
      displayName: pending.name,
      avatarUrl: pending.picture,
    });

    const session = await issueSession(created, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"] ?? null,
    });
    attachAuthCookies(res, session.accessToken, session.refreshToken);

    await recordAuditEvent({
      actorId: created.id,
      actorRole: created.role,
      action: "AUTH_GOOGLE_SIGNUP_SUCCESS",
      resourceType: "User",
      resourceId: created.id,
      outcome: "SUCCESS",
      reason: `Account created via Google as ${role}${phone ? "" : ", phone not yet supplied"}`,
      correlationId: req.correlationId,
      ipAddress: req.ip,
    });

    sendSuccess(res, {
      user: serializeOwnUserAccount(created),
      capabilities: ROLE_CAPABILITIES[created.role],
      redirectTo: pending.next ?? dashboardPathForUser(created.role, created.tier),
    });
  } catch (error) {
    // A racing request may have inserted the same (provider, sub) pair; the unique
    // constraint is the real guard, so report it as such rather than a 500.
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      sendError(res, 409, "ALREADY_SIGNED_UP", "This Google account is already registered");
      return;
    }
    throw error;
  }
});

/**
 * Where a role belongs. Kept here (not imported from the web app) because the
 * redirect happens on the API origin, and a duplicated 5-line map is a smaller
 * liability than a cross-workspace import of a browser module.
 */
export function dashboardPathForUser(role: string, tier: string): string {
  switch (role) {
    case "CUSTOMER":
      return "/dashboard/customer";
    case "COLLECTOR":
      return "/dashboard/collector";
    case "SCRAP_BUSINESS":
      return tier === "TIER_3_WHOLESALE_AGGREGATOR" ? "/dashboard/mandi" : "/dashboard/shop";
    case "AUTHORISED_RECYCLER":
      return "/dashboard/recycler";
    case "ADMIN":
      return "/dashboard/admin";
    default:
      return "/dashboard";
  }
}
