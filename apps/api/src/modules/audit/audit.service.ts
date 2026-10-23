import crypto from "crypto";
import { Prisma } from "../../generated/prisma/client";
import { getPrisma } from "../../lib/prisma";

const SENSITIVE_KEY_PATTERN =
  /(password|passhash|token|secret|otp|authorization|cookie|aadhaar|pan_number|privatekey)/i;

/**
 * Recursively strips any sensitive secret, credential, token or raw identity
 * field before persisting structured audit metadata (Section 8.11).
 */
export function sanitizeAuditMetadata(input: unknown, depth = 0): Prisma.InputJsonValue | undefined {
  if (input === null || input === undefined || depth > 4) return undefined;
  if (typeof input === "string") {
    return input.length > 500 ? `${input.slice(0, 500)}...[truncated]` : input;
  }
  if (typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .slice(0, 25)
      .map((item) => sanitizeAuditMetadata(item, depth + 1) ?? null);
  }
  if (typeof input === "object") {
    const clean: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        clean[key] = "[REDACTED]";
      } else {
        clean[key] = sanitizeAuditMetadata(value, depth + 1) ?? null;
      }
    }
    return clean;
  }
  return undefined;
}

export interface RecordAuditParams {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: "SUCCESS" | "DENIED" | "FAILURE";
  reason?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  ipAddress?: string | null;
}

export async function recordAuditEvent(params: RecordAuditParams): Promise<void> {
  try {
    const prisma = await getPrisma();
    const metadataJson = params.metadata
      ? sanitizeAuditMetadata(params.metadata)
      : undefined;

    await prisma.auditEvent.create({
      data: {
        actorId: params.actorId ?? null,
        actorRole: params.actorRole ?? null,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId ?? null,
        outcome: params.outcome,
        reason: params.reason ?? null,
        metadataJson,
        correlationId: params.correlationId ?? crypto.randomUUID(),
        ipAddress: params.ipAddress ?? null,
      },
    });
  } catch (err) {
    // Never leak internal details to callers, log minimal diagnostic server-side
    console.error("Failed to persist AuditEvent:", err instanceof Error ? err.message : "unknown");
  }
}
