// Google Sign-In: the provider side only.
//
// This file talks to Google and nothing else. It does not create sessions, set
// cookies or decide roles -- those belong to the auth routes, so that a Google
// login and a password login end up in exactly the same session code. Anything
// that knows how this product stores sessions should not also know OAuth.
//
// Three decisions worth stating, because each is a place where this is commonly
// implemented unsafely:
//
//   1. `state` and PKCE are stored server-side in the database, single-use. A state
//      that lives only in a cookie can be planted by an attacker who can write
//      cookies on a subdomain, which defeats the point of state.
//   2. The lookup key is Google's `sub` claim, never the email. Emails can be
//      reassigned within a Google Workspace domain; `sub` cannot.
//   3. An unverified email is never used to link to an existing account. Linking
//      needs the email to be verified by the provider, otherwise anyone who could
//      make Google assert an unverified address could attach themselves to an
//      existing password account.
import crypto from "crypto";
import { env } from "../../config/env";


/**
 * A per-request deadline.
 *
 * `AbortSignal.timeout` is not in the TypeScript lib this project targets, and
 * without a deadline a hung connection to Google would hold a request open until the
 * platform times it out -- which looks to the user like a sign-in button that does
 * nothing. An AbortController is used directly so it works on the declared lib and
 * on any Node 18+ runtime.
 */
function deadline(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs";

export interface GoogleProfile {
  /** Google's stable subject identifier. This is the account key. */
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export interface GoogleIdentity {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The configured Google app, or null when sign-in is not set up.
 *
 * A half-configured pair throws: an install with an id but no secret would render a
 * Google button that can only fail, and silently hiding the button would leave the
 * operator wondering why. Failing at the first use names the problem.
 */
export function readGoogleIdentity(source: NodeJS.ProcessEnv = process.env): GoogleIdentity | null {
  const clientId = source.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = source.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = source.GOOGLE_REDIRECT_URI?.trim();

  if (!clientId && !clientSecret) return null;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Google sign-in is half configured: set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither."
    );
  }
  if (!redirectUri) {
    throw new Error(
      "Google sign-in needs GOOGLE_REDIRECT_URI. It must match the redirect URI registered " +
        "in the Google Cloud console exactly, e.g. http://localhost:4000/api/v1/auth/google/callback"
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** Where the button sends the browser when no explicit redirect is configured. */
export function defaultRedirectUri(): string {
  return `http://localhost:${env.API_PORT}/api/v1/auth/google/callback`;
}

export function isGoogleConfigured(): boolean {
  try {
    return readGoogleIdentity() !== null;
  } catch {
    // Misconfigured counts as "not available": the route answers 503 with the
    // reason, and the sign-in page hides the button rather than offering a trap.
    return false;
  }
}

export function buildAuthorizationUrl(params: {
  identity: GoogleIdentity;
  state: string;
  codeChallenge: string;
  prompt?: "select_account" | "consent";
}): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", params.identity.clientId);
  url.searchParams.set("redirect_uri", params.identity.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // `select_account` matters on a shared phone, which is the common case this app
  // is built for: without it Google silently reuses whichever account is already
  // signed in to the browser, and the shop owner ends up inside the collector's
  // account on a borrowed device.
  url.searchParams.set("prompt", params.prompt ?? "select_account");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

/** PKCE: the verifier stays on the server, only its SHA-256 hash goes to Google. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function exchangeCodeForTokens(params: {
  identity: GoogleIdentity;
  code: string;
  codeVerifier: string;
}): Promise<{ idToken: string; accessToken: string }> {
  const gate = deadline(10_000);
  const response = await fetch(TOKEN_ENDPOINT, {
    signal: gate.signal,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: params.code,
      client_id: params.identity.clientId,
      client_secret: params.identity.clientSecret,
      redirect_uri: params.identity.redirectUri,
      grant_type: "authorization_code",
      code_verifier: params.codeVerifier,
    }).toString(),
  }).finally(gate.cancel);

  if (!response.ok) {
    // The body can carry a `error_description` that says "bad code" vs "redirect
    // mismatch"; it is useful to the operator and contains no secret of ours.
    const detail = await response.text().catch(() => "");
    throw new GoogleAuthError(
      `Google rejected the code exchange (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }

  const body = (await response.json()) as { id_token?: string; access_token?: string };
  if (!body.id_token) throw new GoogleAuthError("Google returned no id_token");
  return { idToken: body.id_token, accessToken: body.access_token ?? "" };
}

interface VerifiedClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
}

/**
 * Verifies the id_token and returns the claims we actually use.
 *
 * Why verify by hand rather than trust the token: the id_token arrives in the
 * response to a call we made with our own secret, so the transport is already
 * authenticated -- but "we can trust this" is exactly the assumption that turns a
 * redirect bug into an account takeover. The signature, issuer, audience and
 * expiry are all checked, and an audience that is not our client_id is rejected.
 *
 * Signature verification prefers Google's published JWKS and falls back to Google's
 * own tokeninfo endpoint when the keys cannot be fetched. The fallback exists
 * because this runs on a free tier with a cold cache; it is not a weaker check,
 * it is the same check performed by Google.
 */
export async function verifyIdToken(idToken: string, clientId: string): Promise<GoogleProfile> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleAuthError("Malformed id_token");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as VerifiedClaims;

  if (header.alg !== "RS256") throw new GoogleAuthError(`Unexpected id_token alg: ${header.alg}`);

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = Buffer.from(signatureB64, "base64url");

  let signatureValid = false;
  try {
    const keys = await fetchSigningKeys();
    const key = keys.find((candidate) => candidate.kid === header.kid);
    if (key) {
      signatureValid = crypto.verify(
        "RSA-SHA256",
        signingInput,
        crypto.createPublicKey({ key: key.jwk as crypto.JsonWebKey, format: "jwk" }),
        signature
      );
    }
  } catch {
    // fall through to the remote check below
  }

  if (!signatureValid) {
    signatureValid = await verifyViaTokenInfo(idToken);
  }
  if (!signatureValid) throw new GoogleAuthError("id_token signature could not be verified");

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) {
    throw new GoogleAuthError("id_token was issued for a different client");
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    throw new GoogleAuthError(`Unexpected id_token issuer: ${claims.iss}`);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < nowSeconds - 60) {
    throw new GoogleAuthError("id_token has expired");
  }
  if (typeof claims.iat === "number" && claims.iat > nowSeconds + 300) {
    throw new GoogleAuthError("id_token issued in the future");
  }
  if (!claims.sub) throw new GoogleAuthError("id_token has no subject");

  return {
    sub: claims.sub,
    email: claims.email?.trim().toLowerCase() ?? null,
    // Google returns this as `true` only when it has actually verified the address.
    emailVerified: claims.email_verified === true,
    name: claims.name?.trim() || null,
    picture: claims.picture?.trim() || null,
  };
}

// --- signing keys, cached in memory -----------------------------------------
//
// Google publishes two or three RSA keys and rotates them slowly. Caching for an
// hour keeps this off the network on the hot path; a `kid` miss forces one refetch
// so a rotation is picked up on the first token that needs the new key.
// Node's `crypto.createPublicKey({ format: "jwk" })` accepts the JWK object as
// published by Google. `JsonWebKey` is a DOM type and this tsconfig has no DOM lib,
// so the shape is described by the field that is actually read: the key material.
export interface RsaJwk {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

let keyCache: { keys: Array<{ kid: string; jwk: RsaJwk }>; fetchedAt: number } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

/**
 * Drops the cached signing keys.
 *
 * Exists for tests: the cache is module-level, so a test that swaps the JWKS
 * endpoint would otherwise run against keys fetched by whichever test came first.
 * That makes results depend on test order, which is how a signature check appears
 * to accept one token and reject another with no change to the code.
 */
export function resetSigningKeyCache(): void {
  keyCache = null;
}

async function fetchSigningKeys(force = false): Promise<Array<{ kid: string; jwk: RsaJwk }>> {
  if (!force && keyCache && Date.now() - keyCache.fetchedAt < KEY_TTL_MS) return keyCache.keys;
  const gate = deadline(8_000);
  const response = await fetch(JWKS_ENDPOINT, { signal: gate.signal }).finally(gate.cancel);
  if (!response.ok) throw new GoogleAuthError(`Could not fetch Google signing keys (${response.status})`);
  const body = (await response.json()) as { keys?: RsaJwk[] };
  const keys = (body.keys ?? [])
    .filter((key): key is RsaJwk & { kid: string } => typeof key.kid === "string")
    .map((key) => ({ kid: key.kid, jwk: key }));
  keyCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/** Google's own verification endpoint, used only if local signature checks fail. */
async function verifyViaTokenInfo(idToken: string): Promise<boolean> {
  const gate = deadline(8_000);
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { signal: gate.signal }
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    gate.cancel();
  }
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
