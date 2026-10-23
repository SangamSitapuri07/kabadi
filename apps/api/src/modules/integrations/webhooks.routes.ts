import express, { Router } from "express";
import { z } from "zod";
import { paiseToInrString } from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import { sendError, sendSuccess } from "../../middleware/security.middleware";
import { recordAuditEvent } from "../audit/audit.service";
import { verifyWebhookHmacSignature } from "./gateways.service";

export const webhooksRouter = Router();

const UpiPayoutWebhookSchema = z
  .object({
    eventId: z.string().trim().min(6).max(120),
    eventType: z.enum(["payout.processed", "upi.collect.settled"]),
    orderId: z.string().uuid(),
    amountPaise: z.number().int().positive(),
    utrReference: z.string().trim().min(6).max(80),
  })
  .strict();

/**
 * POST /api/v1/webhooks/payments/upi-payout
 * Receives raw UTF-8 payload before JSON parsing so HMAC-SHA256 signature verification
 * runs over the exact unmutated wire bytes (`${timestamp}.${rawBody}`).
 */
webhooksRouter.post(
  "/payments/upi-payout",
  express.text({ type: "*/*", limit: "64kb" }),
  async (req, res, next) => {
    try {
      const signature = req.header("x-kabadi-signature") ?? "";
      const timestamp = req.header("x-kabadi-timestamp") ?? "";
      const rawBody = typeof req.body === "string" ? req.body : "";

      if (!signature || !timestamp || !rawBody) {
        sendError(
          res,
          401,
          "WEBHOOK_AUTH_MISSING",
          "Missing x-kabadi-signature, x-kabadi-timestamp, or raw webhook payload"
        );
        return;
      }

      const check = verifyWebhookHmacSignature(timestamp, rawBody, signature);
      if (!check.valid) {
        await recordAuditEvent({
          action: "PAYMENT_WEBHOOK_SIGNATURE_REJECTED",
          resourceType: "PaymentWebhook",
          outcome: "DENIED",
          reason: check.reason ?? "Signature verification failed",
          correlationId: req.correlationId,
          ipAddress: req.ip,
        });
        sendError(
          res,
          401,
          "WEBHOOK_SIGNATURE_INVALID",
          `Webhook verification failed: ${check.reason}`
        );
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody);
      } catch {
        sendError(res, 400, "INVALID_JSON", "Malformed JSON webhook body");
        return;
      }

      const validated = UpiPayoutWebhookSchema.safeParse(parsedJson);
      if (!validated.success) {
        sendError(
          res,
          400,
          "WEBHOOK_SCHEMA_INVALID",
          "Invalid payment webhook fields",
          validated.error.flatten().fieldErrors
        );
        return;
      }

      const payload = validated.data;
      const prisma = await getPrisma();

      // Strict idempotency guard: never double-record duplicate webhook retries!
      const alreadyProcessed = await prisma.auditEvent.findFirst({
        where: {
          action: "PAYMENT_WEBHOOK_SETTLEMENT_RECORDED",
          resourceId: payload.eventId,
          outcome: "SUCCESS",
        },
      });
      if (alreadyProcessed) {
        sendSuccess(res, {
          received: true,
          idempotentReplay: true,
          eventId: payload.eventId,
        });
        return;
      }

      const order = await prisma.transactionOrder.findUnique({
        where: { id: payload.orderId },
      });
      if (!order) {
        sendError(res, 404, "ORDER_NOT_FOUND", "Referenced order does not exist");
        return;
      }

      const [paymentRecord] = await prisma.$transaction([
        prisma.paymentRecord.create({
          data: {
            orderId: order.id,
            method: "UPI_INTENT",
            status: "PAID",
            amountPaise: payload.amountPaise,
            externalRef: payload.utrReference ?? payload.eventId,
            recordedById: order.buyerId,
            paidAt: new Date(),
          },
        }),
        prisma.notification.create({
          data: {
            userId: order.sellerId,
            title: "Verified UPI Payout Received",
            body: `UTR ${payload.utrReference ?? payload.eventId} confirmed ${paiseToInrString(
              payload.amountPaise
            )} on Order ${order.orderNumber}.`,
          },
        }),
      ]);

      await recordAuditEvent({
        actorId: order.buyerId,
        action: "PAYMENT_WEBHOOK_SETTLEMENT_RECORDED",
        resourceType: "PaymentRecord",
        resourceId: payload.eventId,
        outcome: "SUCCESS",
        metadata: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          utrReference: payload.utrReference,
          amountPaise: payload.amountPaise,
          paymentRecordId: paymentRecord.id,
        },
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });

      sendSuccess(res, {
        received: true,
        idempotentReplay: false,
        eventId: payload.eventId,
        paymentRecordId: paymentRecord.id,
      });
    } catch (err) {
      next(err);
    }
  }
);
