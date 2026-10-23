#!/usr/bin/env node
/**
 * Generates a .env with cryptographically strong secrets.
 *
 *   node scripts/generate-env.mjs           # create .env (refuses to overwrite)
 *   node scripts/generate-env.mjs --force   # overwrite, rotating all secrets
 *
 * Existing unrelated keys are preserved when rotating, so rotating secrets
 * never wipes RAZORPAY_* or SMS settings you already configured.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

const FORCE = process.argv.includes("--force");
const envPath = path.resolve(process.cwd(), ".env");
const examplePath = path.resolve(process.cwd(), ".env.example");

const SECRET_KEYS = [
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "SIGNED_URL_SECRET",
  "PAYMENT_WEBHOOK_SECRET",
];

const hexSecret = () => crypto.randomBytes(32).toString("hex");

function readExisting() {
  if (!fs.existsSync(envPath)) return new Map();
  const map = new Map();
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (match) map.set(match[1], match[2]);
  }
  return map;
}

if (fs.existsSync(envPath) && !FORCE) {
  console.error(
    ".env already exists. Re-run with --force to rotate secrets " +
      "(existing non-secret settings are preserved)."
  );
  process.exit(1);
}

const existing = readExisting();
const generated = new Map();

// Start from .env.example when present so the file stays readable/commented.
const template = fs.existsSync(examplePath)
  ? fs.readFileSync(examplePath, "utf8")
  : "";

let output = template;
for (const key of SECRET_KEYS) {
  const value = hexSecret();
  generated.set(key, value);
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}="${value}"`;
  if (pattern.test(output)) {
    output = output.replace(pattern, line);
  } else {
    output += `\n${line}`;
  }
}

// Preserve user-set values that are not secrets (gateway keys, SMS, DB...).
for (const [key, value] of existing.entries()) {
  if (SECRET_KEYS.includes(key)) continue;
  if (!value || value === '""') continue;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(output)) {
    output = output.replace(pattern, `${key}=${value}`);
  } else {
    output += `\n${key}=${value}`;
  }
}

fs.writeFileSync(envPath, output, { mode: 0o600 });

console.log(`✔ Wrote ${envPath} with ${SECRET_KEYS.length} freshly generated secrets:`);
for (const key of SECRET_KEYS) {
  console.log(`   • ${key} = ${generated.get(key).slice(0, 6)}… (64 hex chars)`);
}
console.log(
  "\nNext: npm run db:push && npm run db:seed, then start the API with npm run dev:api"
);
