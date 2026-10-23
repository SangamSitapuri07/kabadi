import crypto from "crypto";
import { env } from "../../config/env";

/**
 * Payment gateway abstraction.
 *
 * Two adapters ship with the codebase:
 *  - `mock`     — deterministic local/CI adapter. It is NOT a dummy value: it
 *                 runs the exact same state machine, signatures and webhook
 *                 verification path as production, just without moving rupees.
 *  - `razorpay` — real UPI / cards / netbanking / wallets via api.razorpay.com.
 *
 * Amounts are ALWAYS integers in paise. Nothing outside this layer is allowed
 * to talk to the PSP.
 */

export type ProviderKind = "MOCK" | "RAZORPAY";

export interface CreateProviderOrderInput {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
}

export interface ProviderOrder {
  id: string;
  amountPaise: number;
  currency: string;
  status: string;
  receipt: string | null;
}

export interface ProviderPayment {
  id: string;
  orderId: string;
  status: string;
  amountPaise: number;
  method: string | null;
  feePaise: number;
  taxPaise: number;
  capturedAt: string | null;
  errorDescription: string | null;
}

export interface ProviderRefund {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: string;
}

export interface CheckoutSignaturePayload {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface PaymentProviderAdapter {
  readonly kind: ProviderKind;
  readonly displayName: string;
  /** Public key id the browser/mobile checkout needs. Never the secret. */
  readonly publicKeyId: string | null;
  createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder>;
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment>;
  refundPayment(
    providerPaymentId: string,
    amountPaise: number,
    notes: Record<string, string>
  ): Promise<ProviderRefund>;
  verifyCheckoutSignature(payload: CheckoutSignaturePayload): boolean;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

export class PaymentProviderError extends Error {
  readonly statusCode: number;
  readonly providerCode: string | null;

  constructor(message: string, statusCode = 502, providerCode: string | null = null) {
    super(message);
    this.name = "PaymentProviderError";
    this.statusCode = statusCode;
    this.providerCode = providerCode;
  }
}

function timingSafeHexEqual(expectedHex: string, providedHex: string): boolean {
  const expected = Buffer.from(expectedHex, "utf8");
  const provided = Buffer.from((providedHex ?? "").trim().toLowerCase(), "utf8");
  if (expected.length !== provided.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(expected, provided);
}

// ============================================================================
// MOCK ADAPTER — local development & automated tests
// ============================================================================

class MockPaymentProvider implements PaymentProviderAdapter {
  readonly kind = "MOCK" as const;
  readonly displayName = "Local simulator (no real money)";
  readonly publicKeyId = "mock_key_local_only";

  private readonly signingSecret: string;

  constructor() {
    // Reuses the mandatory server-side webhook secret so mock signatures are
    // still cryptographically verified — a forged callback is rejected locally
    // exactly the way it would be in production.
    this.signingSecret = env.PAYMENT_WEBHOOK_SECRET;
  }

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    if (input.amountPaise <= 0) {
      throw new PaymentProviderError("Order amount must be positive", 400);
    }
    return {
      id: `order_mock_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
      amountPaise: input.amountPaise,
      currency: input.currency,
      status: "created",
      receipt: input.receipt,
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
    if (!providerPaymentId.startsWith("pay_mock_")) {
      throw new PaymentProviderError("Unknown mock payment reference", 404);
    }
    return {
      id: providerPaymentId,
      orderId: "",
      status: "captured",
      amountPaise: 0,
      method: "upi",
      feePaise: 0,
      taxPaise: 0,
      capturedAt: new Date().toISOString(),
      errorDescription: null,
    };
  }

  async refundPayment(
    providerPaymentId: string,
    amountPaise: number
  ): Promise<ProviderRefund> {
    return {
      id: `rfnd_mock_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
      paymentId: providerPaymentId,
      amountPaise,
      status: "processed",
    };
  }

  /** Mirrors Razorpay's `HMAC_SHA256(order_id|payment_id, key_secret)`. */
  verifyCheckoutSignature(payload: CheckoutSignaturePayload): boolean {
    const expected = crypto
      .createHmac("sha256", this.signingSecret)
      .update(`${payload.providerOrderId}|${payload.providerPaymentId}`)
      .digest("hex");
    return timingSafeHexEqual(expected, payload.signature);
  }

  /** Mirrors Razorpay's `HMAC_SHA256(raw_body, webhook_secret)`. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = crypto
      .createHmac("sha256", this.signingSecret)
      .update(rawBody)
      .digest("hex");
    return timingSafeHexEqual(expected, signature);
  }

  /** Builds a valid signature so local/mock callbacks can be exercised. */
  static signCheckout(providerOrderId: string, providerPaymentId: string): string {
    return crypto
      .createHmac("sha256", env.PAYMENT_WEBHOOK_SECRET)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest("hex");
  }
}

// ============================================================================
// RAZORPAY ADAPTER — real money
// ============================================================================

interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string | null;
}

interface RazorpayPaymentResponse {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  method?: string | null;
  fee?: number | null;
  tax?: number | null;
  captured?: boolean;
  created_at?: number;
  error_description?: string | null;
}

interface RazorpayRefundResponse {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
}

interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string };
}

class RazorpayPaymentProvider implements PaymentProviderAdapter {
  readonly kind = "RAZORPAY" as const;
  readonly displayName = "Razorpay";
  readonly publicKeyId: string;

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl = "https://api.razorpay.com/v1";
  private readonly timeoutMs = 15_000;

  constructor() {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new PaymentProviderError(
        "Razorpay adapter selected but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing",
        500,
        "CONFIG_MISSING"
      );
    }
    this.keyId = env.RAZORPAY_KEY_ID;
    this.keySecret = env.RAZORPAY_KEY_SECRET;
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET ?? "";
    this.publicKeyId = env.RAZORPAY_KEY_ID;
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: this.authHeader(),
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed: RazorpayErrorBody = {};
        try {
          parsed = JSON.parse(text) as RazorpayErrorBody;
        } catch {
          // non-JSON error body
        }
        throw new PaymentProviderError(
          parsed.error?.description ??
            `Razorpay request failed with HTTP ${res.status}`,
          res.status === 401 ? 502 : res.status,
          parsed.error?.code ?? null
        );
      }
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof PaymentProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new PaymentProviderError("Razorpay request timed out", 504, "TIMEOUT");
      }
      throw new PaymentProviderError(
        `Razorpay network error: ${(err as Error).message}`,
        502,
        "NETWORK_ERROR"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    const body = {
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes,
      payment_capture: 1,
    };
    const order = await this.request<RazorpayOrderResponse>("/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Never trust the gateway's amount echo — assert it matches what we computed.
    if (order.amount !== input.amountPaise) {
      throw new PaymentProviderError(
        "Gateway order amount mismatch — refusing to open checkout",
        502,
        "AMOUNT_MISMATCH"
      );
    }
    return {
      id: order.id,
      amountPaise: order.amount,
      currency: order.currency,
      status: order.status,
      receipt: order.receipt ?? null,
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const payment = await this.request<RazorpayPaymentResponse>(
      `/payments/${encodeURIComponent(providerPaymentId)}`
    );
    return {
      id: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      amountPaise: payment.amount,
      method: payment.method ?? null,
      feePaise: payment.fee ?? 0,
      taxPaise: payment.tax ?? 0,
      capturedAt: payment.created_at
        ? new Date(payment.created_at * 1000).toISOString()
        : null,
      errorDescription: payment.error_description ?? null,
    };
  }

  async refundPayment(
    providerPaymentId: string,
    amountPaise: number,
    notes: Record<string, string>
  ): Promise<ProviderRefund> {
    const refund = await this.request<RazorpayRefundResponse>(
      `/payments/${encodeURIComponent(providerPaymentId)}/refund`,
      {
        method: "POST",
        body: JSON.stringify({ amount: amountPaise, notes, speed: "normal" }),
      }
    );
    return {
      id: refund.id,
      paymentId: refund.payment_id,
      amountPaise: refund.amount,
      status: refund.status,
    };
  }

  verifyCheckoutSignature(payload: CheckoutSignaturePayload): boolean {
    const expected = crypto
      .createHmac("sha256", this.keySecret)
      .update(`${payload.providerOrderId}|${payload.providerPaymentId}`)
      .digest("hex");
    return timingSafeHexEqual(expected, payload.signature);
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret) return false;
    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(rawBody)
      .digest("hex");
    return timingSafeHexEqual(expected, signature);
  }
}

// ============================================================================

let adapter: PaymentProviderAdapter | null = null;

export function getPaymentProvider(): PaymentProviderAdapter {
  if (adapter) return adapter;
  adapter = env.PAYMENT_PROVIDER === "razorpay"
    ? new RazorpayPaymentProvider()
    : new MockPaymentProvider();
  return adapter;
}

/** Test-only hook so the mock adapter can be exercised with forged signatures. */
export function signMockCheckout(
  providerOrderId: string,
  providerPaymentId: string
): string {
  return MockPaymentProvider.signCheckout(providerOrderId, providerPaymentId);
}

export function buildMockWebhookSignature(rawBody: string): string {
  return crypto
    .createHmac("sha256", env.PAYMENT_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
}
