#!/usr/bin/env node
// "Is Google sign-in actually wired up?" — one command, no guessing.
//
//   node apps/api/scripts/check-google-setup.mjs
//
// It reads the same .env the API reads, calls the running API, and reports each
// thing that has to be true. Everything it prints is either a boolean about your
// configuration or a URL Google will also see — no secret is ever echoed.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const envPath = path.join(root, ".env");

function readEnv() {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = readEnv();
const API = process.env.API_URL ?? "http://127.0.0.1:4000";

let problems = 0;
const ok = (label, detail = "") => console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
const bad = (label, detail = "") => {
  problems += 1;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
};
const note = (label) => console.log(`  ..    ${label}`);

function secretLooksReal(value) {
  if (!value) return false;
  const fake = ["test", "xxxx", "your-", "replace", "changeme", "<", "dummy", "example"];
  const lower = value.toLowerCase();
  return !fake.some((marker) => lower.includes(marker));
}

console.log("\nFiles");
if (!fs.existsSync(envPath)) {
  bad(".env exists", `not found at ${envPath}\n        run: cp .env.example .env`);
} else {
  ok(".env exists");
  const mode = fs.statSync(envPath).mode & 0o777;
  if (mode & 0o077) {
    note(`.env mode is ${mode.toString(8)} — consider: chmod 600 .env`);
  } else {
    ok(".env is private", mode.toString(8));
  }
}

console.log("\nGoogle credentials in .env");
const clientId = env.GOOGLE_CLIENT_ID ?? "";
const clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
const redirect = env.GOOGLE_REDIRECT_URI ?? "";
// Not every value lives in .env: WEB_APP_ORIGIN has an API-side default. Printing a
// value the API is not actually using would make this script lie, so the source is
// reported alongside it.
const webOrigin = env.WEB_APP_ORIGIN ?? "(API default: http://localhost:3000)";

if (!clientId) bad("GOOGLE_CLIENT_ID is set");
else if (!clientId.endsWith(".apps.googleusercontent.com"))
  bad("GOOGLE_CLIENT_ID looks like a Google client id", "should end with .apps.googleusercontent.com");
else ok("GOOGLE_CLIENT_ID is set", `(${clientId.length} chars, ends correctly)`);

if (!clientSecret) bad("GOOGLE_CLIENT_SECRET is set");
else if (!secretLooksReal(clientSecret))
  bad("GOOGLE_CLIENT_SECRET looks like the real one", "it matches a placeholder such as 'test' or 'xxxx'");
else ok("GOOGLE_CLIENT_SECRET is set", `(${clientSecret.length} chars, value never printed)`);

const expectedRedirect = "http://localhost:4000/api/v1/auth/google/callback";
if (!redirect) bad("GOOGLE_REDIRECT_URI is set", `should be ${expectedRedirect}`);
else if (redirect !== expectedRedirect)
  bad(
    "GOOGLE_REDIRECT_URI matches the local default",
    `yours: ${redirect}\n        expected: ${expectedRedirect}\n        It must match Google Cloud exactly, and it points at the API (4000), not the web app (3000).`
  );
else ok("GOOGLE_REDIRECT_URI is the local default", redirect);
ok("WEB_APP_ORIGIN", webOrigin);

console.log("\nThe API, if it is running");
let providers = null;
try {
  const response = await fetch(`${API}/api/v1/auth/providers`, {
    signal: AbortSignal.timeout(4000),
  });
  providers = await response.json().catch(() => null);
} catch {
  note(`API not reachable at ${API} — start it with: npm run dev:api`);
}

if (providers) {
  const data = providers.data ?? {};
  if (data.google && !clientId) {
    bad(
      "API reports google: true, but .env has no GOOGLE_CLIENT_ID",
      "the running process is using credentials from before the .env was cleared, " +
        "or from another source. Restart it so what it uses matches this file."
    );
  } else if (data.google) ok("API reports google: true", "the sign-in page will show the button");
  else if (data.googleMisconfigured)
    bad("API says half configured", "only one of id/secret reached it — restart the API");
  else
    bad(
      "API reports google: false",
      "the running process has not picked up the new .env; restart it (npm run dev:api)"
    );

  const start = await fetch(`${API}/api/v1/auth/google/start`, {
    redirect: "manual",
    signal: AbortSignal.timeout(4000),
  });
  if (start.status === 302) {
    const location = start.headers.get("location") ?? "";
    let host = "";
    try {
      host = new URL(location).host;
    } catch {
      /* leave empty */
    }
    if (host === "accounts.google.com") ok("Google redirect begins", "host accounts.google.com");
    else bad("Google redirect begins", `unexpected location host: ${host || "(none)"}`);
    if (!location.includes("code_challenge=")) bad("PKCE is sent", "no code_challenge in the URL");
    else ok("PKCE is sent");
  } else if (start.status === 503) {
    bad("Google redirect begins", "API answered 503 — it has no usable credentials yet");
  } else {
    bad("Google redirect begins", `unexpected status ${start.status}`);
  }
}

console.log("\nWhat to do next");
if (problems === 0) {
  console.log("  Everything checks out.");
  console.log(`  Open ${webOrigin} and click "Continue with Google".`);
  console.log("  If Google answers redirect_uri_mismatch, the URI above is not registered");
  console.log("  byte-for-byte in Google Cloud, or your Gmail is not in Test users.\n");
} else {
  console.log(`  ${problems} thing(s) to fix above. docs/GOOGLE_SIGNIN.md has the details.\n`);
  process.exitCode = 1;
}
