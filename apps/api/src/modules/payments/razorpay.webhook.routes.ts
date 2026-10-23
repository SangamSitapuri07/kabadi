import crypto from "crypto";
import express, { Router } from "express";
import { getPrisma } from "../../lib/prisma";
import { sendError, sendSuccess } from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";
import { getPaymentProvider, type ProviderPayment } from "./payment.provider";
import { markIntentFailed, settleCapturedPayment } from "./payments.service";

export const paymentWebhooksRouter = Router();

interface RazorpayWebhookPaymentEntity {
  id?: string;
  order_id?: string;
  status?: string;
  amount?: number;
  method?: string | null;
  fee?: number | null;
  tax?: number | null;
  created_at?: number;
  error_description?: string | null;
}

interface RazorpayWebhookRefundEntity {
  id?: string;
  payment_id?: string;
  amount?: number;
  status?: string;
}

interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayWebhookPaymentEntity };
    order?: { entity?: { id?: string } };
    refund?: { entity?: RazorpayWebhookRefundEntity };
  };
}

function toProviderPayment(entity: RazorpayWebhookPaymentEntity): ProviderPayment {
  return {
    id: entity.id ?? "",
    orderId: entity.order_id ?? "",
    status: entity.status ?? "captured",
    amountPaise: entity.amount ?? 0,
    method: entity.method ?? null,
    feePaise: entity.fee ?? 0,
    taxPaise: entity.tax ?? 0,
    capturedAt: entity.created_at ? new Date(entity.created_at * 1000).toISOString() : null,
    errorDescription: entity.error_description ?? null,
  };
}

/**
 * POST /api/v1/webhooks/payments/razorpay
 *
 * Mounted BEFORE express.json() so the HMAC is computed over the exact bytes
 * Razorpay signed (`x-razorpay-signature` = HMAC_SHA256(rawBody, webhook_secret)).
 *
 * Replay safety: every delivery carries `x-razorpay-event-id`, stored in a
 * unique column. A retried event is acknowledged with 200 and skipped, so a
 * flaky network can never double-credit an order.
 */
paymentWebhooksRouter.post(
  "/payments/razorpay",
  express.text({ type: "*/*", limit: "256kb" }),
  async (req, res, next) => {
    try {
      const rawBody = typeof req.body === "string" ? req.body : "";
      const signature = req.header("x-razorpay-signature") ?? "";
      const eventIdHeader = req.header("x-razorpay-event-id") ?? "";

      if (!rawBody || !signature) {
        sendError(
          res,
          401,
          "WEBHOOK_AUTH_MISSING",
          "Missing x-razorpay-signature header or raw webhook body"
        );
        return;
      }

      const provider = getPaymentProvider();
      if (!provider.verifyWebhookSignature(rawBody, signature)) {
        await recordAuditEvent({
          action: "PAYMENT_WEBHOOK_SIGNATURE_REJECTED",
          resourceType: "PaymentWebhook",
          outcome: "DENIED",
          reason: "Razorpay HMAC signature mismatch",
          correlationId: req.correlationId,
          ipAddress: req.ip,
        });
        sendError(
          res,
          401,
          "WEBHOOK_SIGNATURE_INVALID",
          "Webhook signature verification failed"
        );
        return;
      }

      let body: RazorpayWebhookBody;
      try {
        body = JSON.parse(rawBody) as RazorpayWebhookBody;
      } catch {
        sendError(res, 400, "INVALID_JSON", "Malformed JSON webhook body");
        return;
      }

      const eventType = body.event ?? "unknown";
      const paymentEntity = body.payload?.payment?.entity;
      const orderEntityId = body.payload?.order?.entity?.id;

      // Deterministic fallback id if the header is absent (e.g. manual replay).
      const providerEventId =
        eventIdHeader ||
        crypto
          .createHash("sha256")
          .update(`${eventType}:${rawBody}`)
          .digest("hex")
          .slice(0, 48);

      const prisma = await getPrisma();

      // Idempotency ledger — unique(providerEventId).
      try {
        await prisma.paymentWebhookEvent.create({
          data: {
            provider: provider.kind,
            providerEventId,
            eventType,
            signatureVerified: true,
            status: "PROCESSED",
            rawPayload: rawBody.slice(0, 100_000),
            processedAt: new Date(),
          },
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes("Unique constraint") ||
            err.message.includes("unique constraint") ||
            (err as { code?: string }).code === "P2002")
        ) {
          sendSuccess(res, {
            received: true,
            idempotentReplay: true,
            eventId: providerEventId,
            eventType,
          });
          return;
        }
        throw err;
      }

      const finish = (payload: Record<string, unknown>) => {
        sendSuccess(res, {
          received: true,
          idempotentReplay: false,
          eventId: providerEventId,
          eventType,
          ...payload,
        });
      };

      // ---------------------------------------------------------------
      // payment.captured / order.paid → credit the order
      // ---------------------------------------------------------------
      if (eventType === "payment.captured" || eventType === "order.paid") {
        if (!paymentEntity?.id) {
          finish({ handled: false, reason: "PAYMENT_ENTITY_MISSING" });
          return;
        }
        const gatewayOrderId = paymentEntity.order_id ?? orderEntityId ?? "";
        const intent = await prisma.paymentIntent.findUnique({
          where: { providerOrderId: gatewayOrderId },
        });
        if (!intent) {
          // Acknowledge so Razorpay stops retrying; surfaced in audit for replay.
          await recordAuditEvent({
            action: "PAYMENT_WEBHOOK_ORPHANED",
            resourceType: "PaymentWebhook",
            resourceId: providerEventId,
            outcome: "FAILURE",
            reason: `No payment intent for gateway order ${gatewayOrderId}`,
            correlationId: req.correlationId,
            ipAddress: req.ip,
          });
          finish({ handled: false, reason: "INTENT_NOT_FOUND" });
          return;
        }
        const settled = await settleCapturedPayment({
          intentId: intent.id,
          payment: toProviderPayment(paymentEntity),
          source: "WEBHOOK",
          correlationId: req.correlationId,
          ipAddress: req.ip,
        });
        finish({
          handled: true,
          intentId: intent.id,
          intentStatus: settled.intent.status,
          settlement: settled.status,
        });
        return;
      }

      // ---------------------------------------------------------------
      // payment.failed → mark the attempt failed (never downgrade PAID)
      // ---------------------------------------------------------------
      if (eventType === "payment.failed") {
        const gatewayOrderId = paymentEntity?.order_id ?? "";
        const intent = await prisma.paymentIntent.findUnique({
          where: { providerOrderId: gatewayOrderId },
        });
        if (!intent) {
          finish({ handled: false, reason: "INTENT_NOT_FOUND" });
          return;
        }
        await markIntentFailed({
          intentId: intent.id,
          providerPaymentId: paymentEntity?.id ?? null,
          reason:
            paymentEntity?.error_description ?? "Gateway reported payment failure",
          correlationId: req.correlationId,
        });
        finish({ handled: true, intentId: intent.id, intentStatus: "FAILED" });
        return;
      }

      // ---------------------------------------------------------------
      // refund.processed → reconcile the refund ledger
      // ---------------------------------------------------------------
      if (eventType === "refund.processed" || eventType === "refund.created") {
        const refundEntity = body.payload?.refund?.entity;
        if (!refundEntity?.id) {
          finish({ handled: false, reason: "REFUND_ENTITY_MISSING" });
          return;
        }
        const existing = await prisma.paymentRefund.findUnique({
          where: { providerRefundId: refundEntity.id },
        });
        if (existing && refundEntity.status === "processed" && existing.status !== "PROCESSED") {
          await prisma.paymentRefund.update({
            where: { id: existing.id },
            data: { status: "PROCESSED", processedAt: new Date() },
          });
          finish({ handled: true, refundId: existing.id, refundStatus: "PROCESSED" });
          return;
        }
        finish({
          handled: Boolean(existing),
          refundId: existing?.id ?? null,
          reason: existing ? "ALREADY_IN_SYNC" : "REFUND_NOT_INITIATED_BY_KABADI",
        });
        return;
      }

      // Unhandled but validly-signed event: acknowledge, keep the audit trail.
      finish({ handled: false, reason: "EVENT_TYPE_NOT_HANDLED" });
    } catch (err) {
      next(err);
    }
  }
);
