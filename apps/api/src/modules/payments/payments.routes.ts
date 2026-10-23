import crypto from "crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { describePaymentRuntime, env } from "../../config/env";
import {
  authenticate,
  requireRoles,
  sendError,
  sendSuccess,
  validateBody,
} from "../../middleware/security.middleware";
import {
  PaymentProviderError,
  getPaymentProvider,
  type ProviderPayment,
} from "./payment.provider";
import {
  createPaymentIntent,
  getIntentForActor,
  listIntentsForOrder,
  reconcilePendingIntents,
  refundIntent,
  settleCapturedPayment,
  verifyCheckoutAndSettle,
} from "./payments.service";

export const paymentsRouter = Router();

const CreateIntentSchema = z
  .object({
    orderId: z.string().uuid(),
    purpose: z.enum(["ORDER_SETTLEMENT", "PLATFORM_FEE", "ESCROW_TOPUP"]).optional(),
    description: z.string().trim().max(200).optional(),
  })
  .strict();

const VerifyCheckoutSchema = z
  .object({
    razorpay_order_id: z.string().trim().min(6).max(120),
    razorpay_payment_id: z.string().trim().min(6).max(120),
    razorpay_signature: z.string().trim().min(16).max(256),
  })
  .strict();

const RefundSchema = z
  .object({
    amountPaise: z.number().int().positive().optional(),
    reason: z.string().trim().min(4).max(500),
  })
  .strict();

const ReconcileSchema = z
  .object({
    olderThanMinutes: z.number().int().min(0).max(1440).optional(),
  })
  .strict();

function handlePaymentError(res: Response, err: unknown): boolean {
  if (err instanceof PaymentProviderError) {
    sendError(res, err.statusCode, err.providerCode ?? "PAYMENT_ERROR", err.message);
    return true;
  }
  return false;
}

// ============================================================================
// PUBLIC — checkout bootstrap config (no secrets, safe to cache briefly)
// ============================================================================
paymentsRouter.get("/payments/config", (_req, res) => {
  const runtime = describePaymentRuntime();
  sendSuccess(res, {
    provider: runtime.provider,
    currency: runtime.currency,
    publicKeyId: getPaymentProvider().publicKeyId,
    keyIdEnvironment:
      runtime.provider === "razorpay"
        ? env.RAZORPAY_KEY_ID?.startsWith("rzp_test_")
          ? "TEST"
          : "LIVE"
        : "MOCK",
    liveMoneyEnabled: runtime.liveMoneyEnabled,
    simulationAllowed: runtime.simulationAllowed,
    payout: { provider: runtime.payoutProvider, live: runtime.payoutLive },
    webhookUrl: runtime.publicWebhookUrl,
    checkoutScriptUrl:
      runtime.provider === "razorpay" ? "https://checkout.razorpay.com/v1/checkout.js" : null,
    /** Honest disclaimer rendered in the UI. */
    disclaimer:
      runtime.liveMoneyEnabled
        ? "Payments are processed by Razorpay. Amounts are fixed server-side and cannot be edited at checkout."
        : "Local simulator active — no real money moves. Set PAYMENT_PROVIDER=razorpay with keys to enable live payments.",
  });
});

// ============================================================================
// CREATE INTENT — amount is derived from the order, never from the request
// ============================================================================
paymentsRouter.post(
  "/payments/intents",
  authenticate,
  validateBody(CreateIntentSchema),
  async (req, res, next) => {
    try {
      const actor = req.actor!;
      const body = req.body as z.infer<typeof CreateIntentSchema>;
      const intent = await createPaymentIntent({
        orderId: body.orderId,
        actorId: actor.id,
        actorRole: actor.role,
        purpose: body.purpose,
        description: body.description,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendSuccess(res, intent, 201);
    } catch (err) {
      if (!handlePaymentError(res, err)) next(err);
    }
  }
);

// ============================================================================
// READ
// ============================================================================
paymentsRouter.get("/payments/intents/:intentId", authenticate, async (req, res, next) => {
  try {
    const actor = req.actor!;
    const intent = await getIntentForActor(String(req.params.intentId ?? ""), actor.id, actor.role);
    sendSuccess(res, intent);
  } catch (err) {
    if (!handlePaymentError(res, err)) next(err);
  }
});

paymentsRouter.get("/payments/orders/:orderId", authenticate, async (req, res, next) => {
  try {
    const actor = req.actor!;
    const summary = await listIntentsForOrder(String(req.params.orderId ?? ""), actor.id, actor.role);
    sendSuccess(res, summary);
  } catch (err) {
    if (!handlePaymentError(res, err)) next(err);
  }
});

// ============================================================================
// CHECKOUT CALLBACK — signature-verified, then re-confirmed with the gateway
// ============================================================================
paymentsRouter.post(
  "/payments/intents/:intentId/verify",
  authenticate,
  validateBody(VerifyCheckoutSchema),
  async (req, res, next) => {
    try {
      const actor = req.actor!;
      const body = req.body as z.infer<typeof VerifyCheckoutSchema>;
      const result = await verifyCheckoutAndSettle({
        intentId: String(req.params.intentId ?? ""),
        providerOrderId: body.razorpay_order_id,
        providerPaymentId: body.razorpay_payment_id,
        signature: body.razorpay_signature,
        actorId: actor.id,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendSuccess(res, {
        status: result.status,
        idempotentReplay: result.status === "ALREADY_PAID",
        intent: result.intent,
      });
    } catch (err) {
      if (!handlePaymentError(res, err)) next(err);
    }
  }
);

// ============================================================================
// LOCAL SIMULATOR — only when PAYMENT_PROVIDER=mock. Blocked in production.
// ============================================================================
paymentsRouter.post(
  "/payments/intents/:intentId/simulate",
  authenticate,
  async (req, res, next) => {
    try {
      if (env.PAYMENT_PROVIDER !== "mock" || !env.ALLOW_PAYMENT_SIMULATION) {
        sendError(
          res,
          409,
          "SIMULATION_DISABLED",
          "Payment simulation is only available when PAYMENT_PROVIDER=mock and ALLOW_PAYMENT_SIMULATION=true"
        );
        return;
      }
      const actor = req.actor!;
      const intent = await getIntentForActor(String(req.params.intentId ?? ""), actor.id, actor.role);
      if (intent.status === "PAID") {
        sendSuccess(res, { status: "ALREADY_PAID", idempotentReplay: true, intent });
        return;
      }
      if (intent.status !== "CREATED" && intent.status !== "ATTEMPTED") {
        sendError(res, 409, "INTENT_NOT_PAYABLE", `Intent is ${intent.status}`);
        return;
      }

      const simulatedPaymentId = `pay_mock_${crypto
        .randomUUID()
        .replace(/-/g, "")
        .slice(0, 18)}`;
      const providerPayment: ProviderPayment = {
        id: simulatedPaymentId,
        orderId: intent.providerOrderId,
        status: "captured",
        amountPaise: intent.amountPaise,
        method: "upi",
        feePaise: 0,
        taxPaise: 0,
        capturedAt: new Date().toISOString(),
        errorDescription: null,
      };

      const settled = await settleCapturedPayment({
        intentId: intent.id,
        payment: providerPayment,
        source: "SIMULATION",
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });

      sendSuccess(res, {
        status: settled.status,
        simulated: true,
        providerPaymentId: simulatedPaymentId,
        intent: settled.intent,
      });
    } catch (err) {
      if (!handlePaymentError(res, err)) next(err);
    }
  }
);

// ============================================================================
// REFUNDS & RECONCILIATION — admin only, fully audited
// ============================================================================
paymentsRouter.post(
  "/payments/intents/:intentId/refund",
  authenticate,
  requireRoles("ADMIN"),
  validateBody(RefundSchema),
  async (req, res, next) => {
    try {
      const actor = req.actor!;
      const body = req.body as z.infer<typeof RefundSchema>;
      const refund = await refundIntent({
        intentId: String(req.params.intentId ?? ""),
        amountPaise: body.amountPaise,
        reason: body.reason,
        actorId: actor.id,
        correlationId: req.correlationId,
        ipAddress: req.ip,
      });
      sendSuccess(res, refund, 201);
    } catch (err) {
      if (!handlePaymentError(res, err)) next(err);
    }
  }
);

paymentsRouter.post(
  "/payments/reconcile",
  authenticate,
  requireRoles("ADMIN"),
  validateBody(ReconcileSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof ReconcileSchema>;
      const result = await reconcilePendingIntents(body.olderThanMinutes ?? 5);
      sendSuccess(res, result);
    } catch (err) {
      if (!handlePaymentError(res, err)) next(err);
    }
  }
);
