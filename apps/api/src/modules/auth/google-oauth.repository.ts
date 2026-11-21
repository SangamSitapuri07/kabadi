// Typed access to the Google sign-in tables.
//
// These three tables are declared in `prisma/schema.prisma` for documentation and
// for wherever the client is generated, but the client checked into this repository
// predates them and cannot be regenerated in an offline build (Prisma downloads its
// engine binaries). So every query here goes through raw SQL on the same connection
// pool the rest of the app uses.
//
// That is a deliberate, contained concession, not a pattern: when the client is
// regenerated on a networked machine, these functions can be replaced by their
// Prisma equivalents one at a time and callers will not change.
import { getPrisma } from "../../lib/prisma";

export interface PendingProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  linkCandidateUserId: string | null;
  linkCandidateRole: string | null;
  next: string | null;
  intent: string;
  roleHint: string;
}

export interface PendingRow {
  id: string;
  handleHash: string;
  profileJson: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface OAuthStateRow {
  id: string;
  codeVerifier: string;
  redirectTo: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
}

// The Prisma client type does not know these tables, so `$queryRaw` returns its
// generic row type. Narrowing happens immediately, in one place, so nothing
// downstream deals with `unknown`.
async function rawRows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const prisma = await getPrisma();
  return prisma.$queryRawUnsafe<T[]>(sql, ...params);
}

async function rawCount(sql: string, ...params: unknown[]): Promise<number> {
  const prisma = await getPrisma();
  return prisma.$executeRawUnsafe(sql, ...params);
}

// --- OAuthState -------------------------------------------------------------

export async function createOAuthState(input: {
  stateHash: string;
  codeVerifier: string;
  redirectTo: string | null;
  expiresAt: Date;
}): Promise<void> {
  await rawCount(
    `INSERT INTO "OAuthState" ("id", "stateHash", "codeVerifier", "redirectTo", "expiresAt")
     VALUES ($1, $2, $3, $4, $5)`,
    crypto.randomUUID(),
    input.stateHash,
    input.codeVerifier,
    input.redirectTo,
    input.expiresAt
  );
}

export async function findOAuthState(stateHash: string): Promise<OAuthStateRow | null> {
  const rows = await rawRows<OAuthStateRow>(
    `SELECT "id", "codeVerifier", "redirectTo", "expiresAt", "consumedAt"
       FROM "OAuthState" WHERE "stateHash" = $1 LIMIT 1`,
    stateHash
  );
  return rows[0] ?? null;
}

/**
 * Marks the state used. Returns false when it is already used, which is the
 * compare-and-swap that makes a replayed callback fail instead of re-running.
 */
export async function consumeOAuthState(stateHash: string): Promise<boolean> {
  const affected = await rawCount(
    `UPDATE "OAuthState" SET "consumedAt" = CURRENT_TIMESTAMP
      WHERE "stateHash" = $1 AND "consumedAt" IS NULL`,
    stateHash
  );
  return affected === 1;
}

// --- PendingGoogleSignup ----------------------------------------------------

export async function createPendingSignup(input: {
  handleHash: string;
  profile: PendingProfile;
  expiresAt: Date;
}): Promise<void> {
  await rawCount(
    `INSERT INTO "PendingGoogleSignup" ("id", "handleHash", "profileJson", "expiresAt")
     VALUES ($1, $2, $3, $4)`,
    crypto.randomUUID(),
    input.handleHash,
    JSON.stringify(input.profile),
    input.expiresAt
  );
}

export async function findPendingSignup(handleHash: string): Promise<PendingRow | null> {
  const rows = await rawRows<PendingRow>(
    `SELECT "id", "handleHash", "profileJson", "expiresAt", "consumedAt"
       FROM "PendingGoogleSignup" WHERE "handleHash" = $1 LIMIT 1`,
    handleHash
  );
  return rows[0] ?? null;
}

export async function consumePendingSignup(handleHash: string): Promise<boolean> {
  const affected = await rawCount(
    `UPDATE "PendingGoogleSignup" SET "consumedAt" = CURRENT_TIMESTAMP
      WHERE "handleHash" = $1 AND "consumedAt" IS NULL`,
    handleHash
  );
  return affected === 1;
}

// --- OAuthAccount -----------------------------------------------------------

export async function linkOAuthAccount(input: {
  userId: string;
  providerAccountId: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
  avatarUrl: string | null;
}): Promise<void> {
  await rawCount(
    `INSERT INTO "OAuthAccount"
       ("id", "userId", "provider", "providerAccountId", "email", "emailVerified", "displayName", "avatarUrl")
     VALUES ($1, $2, 'google', $3, $4, $5, $6, $7)`,
    crypto.randomUUID(),
    input.userId,
    input.providerAccountId,
    input.email,
    input.emailVerified,
    input.displayName,
    input.avatarUrl
  );
}

export async function findOAuthAccount(providerAccountId: string): Promise<{ userId: string } | null> {
  const rows = await rawRows<{ userId: string }>(
    `SELECT "userId" FROM "OAuthAccount"
      WHERE "provider" = 'google' AND "providerAccountId" = $1 LIMIT 1`,
    providerAccountId
  );
  return rows[0] ?? null;
}

export async function touchOAuthAccount(
  providerAccountId: string,
  email: string | null
): Promise<void> {
  await rawCount(
    `UPDATE "OAuthAccount"
        SET "lastUsedAt" = CURRENT_TIMESTAMP,
            "email" = COALESCE($2, "email")
      WHERE "provider" = 'google' AND "providerAccountId" = $1`,
    providerAccountId,
    email
  );
}
