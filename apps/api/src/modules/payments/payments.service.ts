import crypto from "crypto";
import { paiseToInrString } from "@kabadi/shared";
import { env } from "../../config/env";
import { getPrisma } from "../../lib/prisma";
import { recordAuditEvent } from "../audit/audit.service";
import {
  PaymentProviderError,
  getPaymentProvider,
  type ProviderPayment,
} from "./payment.provider";

/**
 * Server-authoritative payment service.
 *
 * Rules enforced here:
 *  1. The amount is always derived from the TransactionOrder row — a client can
 *     never send (or tamper with) the price.
 *  2. A payment is only ever marked PAID after a signature-verified gateway
 *     confirmation (webhook or checkout callback), never on client assertion.
 *  3. Every state transition is idempotent and audit-logged.
 */

export interface PaymentIntentView {
  id: string;
  intentNumber: string;
  orderId: string;
  orderNumber: string;
  provider: "MOCK" | "RAZORPAY";
  providerOrderId: string;
  amountPaise: number;
  amountFormatted: string;
  currency: string;
  status: string;
  purpose: string;
  description: string | null;
  publicKeyId: string | null;
  checkoutMode: "MOCK_SIMULATOR" | "RAZORPAY_CHECKOUT";
  keyIdEnvironment: "TEST" | "LIVE" | "MOCK";
  paidAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  payments: Array<{
    providerPaymentId: string;
    status: string;
    method: string | null;
    amountPaise: number;
    capturedAt: string | null;
  }>;
  refundedPaise: number;
  refundablePaise: number;
}

const ACTIVE_INTENT_STATUSES = ["CREATED", "ATTEMPTED"] as const;
const NON_PAYABLE_ORDER_STATUSES = ["CANCELLED", "REJECTED", "DRAFT"] as const;

function toIso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function mapPaymentMethodToLedger(method: string | null): "UPI_INTENT" | "BANK_TRANSFER" {
  const normalised = (method ?? "").toLowerCase();
  return normalised.includes("upi") ? "UPI_INTENT" : "BANK_TRANSFER";
}

function razorpayKeyEnvironment(keyId: string | null): "TEST" | "LIVE" | "MOCK" {
  if (!keyId || keyId.startsWith("mock_")) return "MOCK";
  return keyId.startsWith("rzp_test_") ? "TEST" : "LIVE";
}

export function resolvePayableAmountPaise(order: {
  finalSettlementPaise: number | null;
  agreedTotalPaise: number;
  indicativeTotalPaise: number;
}): number {
  const amount =
    order.finalSettlementPaise ?? order.agreedTotalPaise ?? order.indicativeTotalPaise;
  return Math.max(0, Math.trunc(amount));
}

async function buildIntentView(intentId: string): Promise<PaymentIntentView | null> {
  const prisma = await getPrisma();
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: intentId },
    include: {
      order: { select: { orderNumber: true } },
      payments: { orderBy: { createdAt: "asc" } },
      refunds: true,
    },
  });
  if (!intent) return null;

  const provider = getPaymentProvider();
  const captured = intent.payments
    .filter((p) => p.status === "CAPTURED" || p.status === "REFUNDED" || p.status === "PARTIALLY_REFUNDED")
    .reduce((sum, p) => sum + p.amountPaise, 0);
  const refunded = intent.refunds
    .filter((r) => r.status === "PROCESSED")
    .reduce((sum, r) => sum + r.amountPaise, 0);

  return {
    id: intent.id,
    intentNumber: intent.intentNumber,
    orderId: intent.orderId,
    orderNumber: intent.order.orderNumber,
    provider: intent.provider,
    providerOrderId: intent.providerOrderId,
    amountPaise: intent.amountPaise,
    amountFormatted: paiseToInrString(intent.amountPaise),
    currency: intent.currency,
    status: intent.status,
    purpose: intent.purpose,
    description: intent.description,
    publicKeyId: provider.publicKeyId,
    checkoutMode: provider.kind === "RAZORPAY" ? "RAZORPAY_CHECKOUT" : "MOCK_SIMULATOR",
    keyIdEnvironment: razorpayKeyEnvironment(provider.publicKeyId),
    paidAt: toIso(intent.paidAt),
    expiresAt: toIso(intent.expiresAt),
    createdAt: toIso(intent.createdAt)!,
    payments: intent.payments.map((p) => ({
      providerPaymentId: p.providerPaymentId,
      status: p.status,
      method: p.method,
      amountPaise: p.amountPaise,
      capturedAt: toIso(p.capturedAt),
    })),
    refundedPaise: refunded,
    refundablePaise: Math.max(0, captured - refunded),
  };
}

export interface CreateIntentInput {
  orderId: string;
  actorId: string;
  actorRole: string;
  purpose?: string;
  description?: string;
  correlationId: string;
  ipAddress?: string;
}

export async function createPaymentIntent(input: CreateIntentInput): Promise<PaymentIntentView> {
  const prisma = await getPrisma();
  const order = await prisma.transactionOrder.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      orderNumber: true,
      buyerId: true,
      sellerId: true,
      status: true,
      agreedTotalPaise: true,
      indicativeTotalPaise: true,
      finalSettlementPaise: true,
    },
  });

  if (!order) {
    throw new PaymentProviderError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  const isParticipant = order.buyerId === input.actorId || order.sellerId === input.actorId;
  if (!isParticipant && input.actorRole !== "ADMIN") {
    throw new PaymentProviderError(
      "Only the buyer, seller, or an admin can initiate payment for this order",
      403,
      "NOT_AN_ORDER_PARTICIPANT"
    );
  }
  if ((NON_PAYABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    throw new PaymentProviderError(
      `Order is ${order.status} and cannot be paid`,
      409,
      "ORDER_NOT_PAYABLE"
    );
  }

  const amountPaise = resolvePayableAmountPaise(order);
  if (amountPaise <= 0) {
    throw new PaymentProviderError(
      "Order has no payable amount yet — agree on a settlement value first",
      409,
      "ZERO_PAYABLE_AMOUNT"
    );
  }

  const purpose = input.purpose ?? "ORDER_SETTLEMENT";

  // Guard: never open a second checkout for an order that is already covered.
  const settled = await prisma.paymentIntent.findMany({
    where: { orderId: order.id, purpose: input.purpose ?? "ORDER_SETTLEMENT", status: "PAID" },
    select: { amountPaise: true, refunds: { where: { status: "PROCESSED" }, select: { amountPaise: true } } },
  });
  const alreadyPaidPaise = settled.reduce(
    (sum, row) =>
      sum + row.amountPaise - row.refunds.reduce((r, refund) => r + refund.amountPaise, 0),
    0
  );
  if (alreadyPaidPaise >= amountPaise) {
    throw new PaymentProviderError(
      `Order ${order.orderNumber} is already fully paid (${paiseToInrString(alreadyPaidPaise)})`,
      409,
      "ORDER_ALREADY_PAID"
    );
  }

  // Idempotency: reuse an in-flight intent for the same order/purpose/amount
  // instead of spawning duplicate gateway orders on every button press.
  const existing = await prisma.paymentIntent.findFirst({
    where: {
      orderId: order.id,
      purpose,
      amountPaise,
      status: { in: [...ACTIVE_INTENT_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    const view = await buildIntentView(existing.id);
    if (view) return view;
  }

  const provider = getPaymentProvider();
  const intentNumber = `KC-PAY-${new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "")}-${crypto.randomInt(100000, 999999)}`;

  const providerOrder = await provider.createOrder({
    amountPaise,
    currency: env.PAYMENT_CURRENCY,
    receipt: `rcpt_${order.orderNumber}`.slice(0, 40),
    notes: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      intentNumber,
      purpose,
    },
  });

  const created = await prisma.paymentIntent.create({
    data: {
      intentNumber,
      orderId: order.id,
      payerId: order.buyerId,
      payeeId: order.sellerId,
      purpose,
      provider: provider.kind,
      providerOrderId: providerOrder.id,
      amountPaise,
      currency: providerOrder.currency,
      status: "CREATED",
      description:
        input.description ??
        `Settlement for ${order.orderNumber} (${paiseToInrString(amountPaise)})`,
    },
  });

  await recordAuditEvent({
    actorId: input.actorId,
    action: "PAYMENT_INTENT_CREATED",
    resourceType: "PaymentIntent",
    resourceId: created.id,
    outcome: "SUCCESS",
    metadata: {
      orderId: order.id,
      provider: provider.kind,
      amountPaise,
      purpose,
    },
    correlationId: input.correlationId,
    ipAddress: input.ipAddress,
  });

  const view = await buildIntentView(created.id);
  if (!view) throw new PaymentProviderError("Intent vanished after creation", 500);
  return view;
}

/**
 * Single place where money becomes "received". Idempotent by design: webhook
 * retries, checkout callback racing the webhook, and manual reconcile all land
 * here safely.
 */
export async function settleCapturedPayment(params: {
  intentId: string;
  payment: ProviderPayment;
  source: "WEBHOOK" | "CHECKOUT_CALLBACK" | "RECONCILIATION" | "SIMULATION";
  correlationId: string;
  ipAddress?: string;
}): Promise<{ status: "PAID" | "ALREADY_PAID" | "AMOUNT_MISMATCH"; intent: PaymentIntentView }> {
  const prisma = await getPrisma();
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: params.intentId },
    include: { order: true },
  });
  if (!intent) {
    throw new PaymentProviderError("Payment intent not found", 404, "INTENT_NOT_FOUND");
  }

  // Gateway must not be able to under-charge us into a "paid" order.
  if (params.payment.amountPaise !== intent.amountPaise) {
    await recordAuditEvent({
      action: "PAYMENT_AMOUNT_MISMATCH_REJECTED",
      resourceType: "PaymentIntent",
      resourceId: intent.id,
      outcome: "DENIED",
      reason: `Expected ${intent.amountPaise} paise, gateway reported ${params.payment.amountPaise}`,
      correlationId: params.correlationId,
      ipAddress: params.ipAddress,
    });
    return { status: "AMOUNT_MISMATCH", intent: (await buildIntentView(intent.id))! };
  }

  const capturedAt = params.payment.capturedAt
    ? new Date(params.payment.capturedAt)
    : new Date();

  // Conditional transition: only one concurrent caller can flip CREATED/ATTEMPTED → PAID.
  const flip = await prisma.paymentIntent.updateMany({
    where: { id: intent.id, status: { in: [...ACTIVE_INTENT_STATUSES] } },
    data: { status: "PAID", paidAt: capturedAt, failureReason: null },
  });

  const existingPayment = await prisma.gatewayPayment.findUnique({
    where: { providerPaymentId: params.payment.id },
  });

  const gatewayPayment = existingPayment
    ? await prisma.gatewayPayment.update({
        where: { id: existingPayment.id },
        data: {
          status: "CAPTURED",
          method: params.payment.method,
          feePaise: params.payment.feePaise,
          taxPaise: params.payment.taxPaise,
          capturedAt,
          failureReason: null,
        },
      })
    : await prisma.gatewayPayment.create({
        data: {
          intentId: intent.id,
          providerPaymentId: params.payment.id,
          status: "CAPTURED",
          method: params.payment.method,
          amountPaise: params.payment.amountPaise,
          feePaise: params.payment.feePaise,
          taxPaise: params.payment.taxPaise,
          capturedAt,
        },
      });

  const alreadySettled = flip.count === 0;

  if (!alreadySettled) {
    // Ledger entry the rest of the platform already understands.
    const ledgerExists = await prisma.paymentRecord.findFirst({
      where: { orderId: intent.orderId, externalRef: params.payment.id },
    });
    if (!ledgerExists) {
      await prisma.paymentRecord.create({
        data: {
          orderId: intent.orderId,
          method: mapPaymentMethodToLedger(params.payment.method),
          status: "PAID",
          amountPaise: params.payment.amountPaise,
          externalRef: params.payment.id,
          recordedById: intent.payerId,
          paidAt: capturedAt,
        },
      });
    }

    await prisma.notification.createMany({
      data: [
        {
          userId: intent.payeeId ?? intent.order.sellerId,
          title: "Payment received",
          body: `${paiseToInrString(params.payment.amountPaise)} confirmed for ${intent.order.orderNumber} (ref ${params.payment.id}).`,
        },
        {
          userId: intent.payerId,
          title: "Payment successful",
          body: `Your payment of ${paiseToInrString(params.payment.amountPaise)} for ${intent.order.orderNumber} is confirmed.`,
        },
      ],
    });

    await recordAuditEvent({
      actorId: intent.payerId,
      action: "PAYMENT_CAPTURED",
      resourceType: "PaymentIntent",
      resourceId: intent.id,
      outcome: "SUCCESS",
      metadata: {
        source: params.source,
        provider: intent.provider,
        providerPaymentId: params.payment.id,
        gatewayPaymentId: gatewayPayment.id,
        amountPaise: params.payment.amountPaise,
        method: params.payment.method,
      },
      correlationId: params.correlationId,
      ipAddress: params.ipAddress,
    });
  }

  return {
    status: alreadySettled ? "ALREADY_PAID" : "PAID",
    intent: (await buildIntentView(intent.id))!,
  };
}

export async function markIntentFailed(params: {
  intentId: string;
  providerPaymentId: string | null;
  reason: string;
  correlationId: string;
}): Promise<void> {
  const prisma = await getPrisma();
  const intent = await prisma.paymentIntent.findUnique({ where: { id: params.intentId } });
  if (!intent || intent.status === "PAID") return; // never downgrade a paid intent

  await prisma.paymentIntent.updateMany({
    where: { id: intent.id, status: { in: [...ACTIVE_INTENT_STATUSES] } },
    data: { status: "FAILED", failureReason: params.reason.slice(0, 500) },
  });

  if (params.providerPaymentId) {
    const existing = await prisma.gatewayPayment.findUnique({
      where: { providerPaymentId: params.providerPaymentId },
    });
    if (existing) {
      await prisma.gatewayPayment.update({
        where: { id: existing.id },
        data: { status: "FAILED", failureReason: params.reason.slice(0, 500) },
      });
    }
  }

  await recordAuditEvent({
    action: "PAYMENT_FAILED",
    resourceType: "PaymentIntent",
    resourceId: intent.id,
    outcome: "FAILURE",
    reason: params.reason.slice(0, 500),
    metadata: { providerPaymentId: params.providerPaymentId },
    correlationId: params.correlationId,
  });
}

export async function verifyCheckoutAndSettle(params: {
  intentId: string;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
  actorId: string;
  correlationId: string;
  ipAddress?: string;
}): Promise<{ status: "PAID" | "ALREADY_PAID"; intent: PaymentIntentView }> {
  const prisma = await getPrisma();
  const intent = await prisma.paymentIntent.findUnique({ where: { id: params.intentId } });
  if (!intent) {
    throw new PaymentProviderError("Payment intent not found", 404, "INTENT_NOT_FOUND");
  }
  if (intent.payerId !== params.actorId) {
    throw new PaymentProviderError(
      "Only the payer can confirm this payment",
      403,
      "NOT_THE_PAYER"
    );
  }

  const provider = getPaymentProvider();
  const signatureValid = provider.verifyCheckoutSignature({
    providerOrderId: params.providerOrderId,
    providerPaymentId: params.providerPaymentId,
    signature: params.signature,
  });

  if (!signatureValid || intent.providerOrderId !== params.providerOrderId) {
    await recordAuditEvent({
      actorId: params.actorId,
      action: "PAYMENT_CHECKOUT_SIGNATURE_REJECTED",
      resourceType: "PaymentIntent",
      resourceId: intent.id,
      outcome: "DENIED",
      reason: "Invalid Razorpay checkout signature or order id mismatch",
      correlationId: params.correlationId,
      ipAddress: params.ipAddress,
    });
    throw new PaymentProviderError(
      "Checkout signature verification failed — payment not accepted",
      400,
      "CHECKOUT_SIGNATURE_INVALID"
    );
  }

  // Signature proves possession of the gateway secret, but we still ask the
  // gateway for the authoritative amount/status before crediting the order.
  const remote = await provider.fetchPayment(params.providerPaymentId);
  if (remote.orderId && remote.orderId !== intent.providerOrderId) {
    throw new PaymentProviderError(
      "Payment belongs to a different gateway order",
      400,
      "ORDER_MISMATCH"
    );
  }
  if (remote.status !== "captured" && remote.status !== "authorized") {
    throw new PaymentProviderError(
      `Payment is not captured (gateway status: ${remote.status})`,
      409,
      "PAYMENT_NOT_CAPTURED"
    );
  }

  const settled = await settleCapturedPayment({
    intentId: intent.id,
    payment: remote,
    source: "CHECKOUT_CALLBACK",
    correlationId: params.correlationId,
    ipAddress: params.ipAddress,
  });
  if (settled.status === "AMOUNT_MISMATCH") {
    throw new PaymentProviderError(
      "Gateway amount does not match the order amount",
      409,
      "AMOUNT_MISMATCH"
    );
  }
  return { status: settled.status, intent: settled.intent };
}

export async function refundIntent(params: {
  intentId: string;
  amountPaise?: number;
  reason: string;
  actorId: string;
  correlationId: string;
  ipAddress?: string;
}): Promise<{ providerRefundId: string; amountPaise: number; status: string }> {
  const prisma = await getPrisma();
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: params.intentId },
    include: { payments: true, refunds: true },
  });
  if (!intent) {
    throw new PaymentProviderError("Payment intent not found", 404, "INTENT_NOT_FOUND");
  }
  if (intent.status !== "PAID") {
    throw new PaymentProviderError(
      "Only a paid intent can be refunded",
      409,
      "INTENT_NOT_PAID"
    );
  }
  const captured = intent.payments.find((p) => p.status === "CAPTURED" || p.status === "PARTIALLY_REFUNDED");
  if (!captured) {
    throw new PaymentProviderError(
      "No captured gateway payment to refund",
      409,
      "NO_CAPTURED_PAYMENT"
    );
  }

  const alreadyRefunded = intent.refunds
    .filter((r) => r.status === "PROCESSED")
    .reduce((sum, r) => sum + r.amountPaise, 0);
  const refundable = captured.amountPaise - alreadyRefunded;
  const requested = params.amountPaise ? Math.trunc(params.amountPaise) : refundable;

  if (requested <= 0 || requested > refundable) {
    throw new PaymentProviderError(
      `Refund amount must be between 1 and ${refundable} paise`,
      400,
      "INVALID_REFUND_AMOUNT"
    );
  }

  const provider = getPaymentProvider();
  const refund = await provider.refundPayment(captured.providerPaymentId, requested, {
    reason: params.reason.slice(0, 200),
    intentId: intent.id,
  });

  const record = await prisma.paymentRefund.create({
    data: {
      intentId: intent.id,
      paymentId: captured.id,
      providerRefundId: refund.id,
      amountPaise: requested,
      status: refund.status === "processed" ? "PROCESSED" : "PENDING",
      reason: params.reason.slice(0, 500),
      initiatedById: params.actorId,
      processedAt: refund.status === "processed" ? new Date() : null,
    },
  });

  if (record.status === "PROCESSED") {
    const newRefundedTotal = alreadyRefunded + requested;
    await prisma.$transaction([
      prisma.gatewayPayment.update({
        where: { id: captured.id },
        data: {
          status: newRefundedTotal >= captured.amountPaise ? "REFUNDED" : "PARTIALLY_REFUNDED",
        },
      }),
      prisma.paymentIntent.update({
        where: { id: intent.id },
        data: { status: newRefundedTotal >= captured.amountPaise ? "CANCELLED" : "PAID" },
      }),
    ]);
  }

  await recordAuditEvent({
    actorId: params.actorId,
    action: "PAYMENT_REFUND_INITIATED",
    resourceType: "PaymentRefund",
    resourceId: record.id,
    outcome: "SUCCESS",
    metadata: {
      intentId: intent.id,
      providerRefundId: refund.id,
      amountPaise: requested,
      reason: params.reason.slice(0, 200),
    },
    correlationId: params.correlationId,
    ipAddress: params.ipAddress,
  });

  return { providerRefundId: refund.id, amountPaise: requested, status: record.status };
}

/**
 * Sweeps intents that never reached a terminal state and asks the gateway what
 * actually happened. Used for lost webhooks / network partitions.
 */
export async function reconcilePendingIntents(olderThanMinutes = 5): Promise<{
  scanned: number;
  repaired: number;
  failed: number;
}> {
  const prisma = await getPrisma();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const stale = await prisma.paymentIntent.findMany({
    where: { status: { in: [...ACTIVE_INTENT_STATUSES] }, createdAt: { lt: cutoff } },
    include: { payments: true },
    take: 50,
  });

  const provider = getPaymentProvider();
  let repaired = 0;
  let failed = 0;

  for (const intent of stale) {
    const candidate = intent.payments[0]?.providerPaymentId;
    if (!candidate) continue;
    try {
      const remote = await provider.fetchPayment(candidate);
      if (remote.status === "captured" || remote.status === "authorized") {
        await settleCapturedPayment({
          intentId: intent.id,
          payment: remote,
          source: "RECONCILIATION",
          correlationId: "reconcile-sweep",
        });
        repaired += 1;
      } else if (remote.status === "failed") {
        await markIntentFailed({
          intentId: intent.id,
          providerPaymentId: candidate,
          reason: remote.errorDescription ?? "Gateway reported failed payment",
          correlationId: "reconcile-sweep",
        });
        failed += 1;
      }
    } catch {
      // Keep sweeping — one bad intent must not abort the whole batch.
    }
  }

  return { scanned: stale.length, repaired, failed };
}

export async function getIntentForActor(
  intentId: string,
  actorId: string,
  actorRole: string
): Promise<PaymentIntentView> {
  const prisma = await getPrisma();
  const intent = await prisma.paymentIntent.findUnique({
    where: { id: intentId },
    include: { order: { select: { buyerId: true, sellerId: true } } },
  });
  if (!intent) {
    throw new PaymentProviderError("Payment intent not found", 404, "INTENT_NOT_FOUND");
  }
  const allowed =
    actorRole === "ADMIN" ||
    intent.payerId === actorId ||
    intent.payeeId === actorId ||
    intent.order.buyerId === actorId ||
    intent.order.sellerId === actorId;
  if (!allowed) {
    throw new PaymentProviderError("Not allowed to view this payment", 403, "FORBIDDEN");
  }
  const view = await buildIntentView(intent.id);
  if (!view) throw new PaymentProviderError("Payment intent not found", 404, "INTENT_NOT_FOUND");
  return view;
}

export async function listIntentsForOrder(
  orderId: string,
  actorId: string,
  actorRole: string
): Promise<{ intents: PaymentIntentView[]; paidPaise: number; payablePaise: number }> {
  const prisma = await getPrisma();
  const order = await prisma.transactionOrder.findUnique({
    where: { id: orderId },
    select: {
      buyerId: true,
      sellerId: true,
      agreedTotalPaise: true,
      indicativeTotalPaise: true,
      finalSettlementPaise: true,
    },
  });
  if (!order) {
    throw new PaymentProviderError("Order not found", 404, "ORDER_NOT_FOUND");
  }
  if (actorRole !== "ADMIN" && order.buyerId !== actorId && order.sellerId !== actorId) {
    throw new PaymentProviderError("Not allowed to view this order", 403, "FORBIDDEN");
  }

  const rows = await prisma.paymentIntent.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const intents: PaymentIntentView[] = [];
  for (const row of rows) {
    const view = await buildIntentView(row.id);
    if (view) intents.push(view);
  }
  const paidPaise = intents
    .filter((i) => i.status === "PAID")
    .reduce((sum, i) => sum + (i.amountPaise - i.refundedPaise), 0);
  return {
    intents,
    paidPaise,
    payablePaise: Math.max(0, resolvePayableAmountPaise(order) - paidPaise),
  };
}
