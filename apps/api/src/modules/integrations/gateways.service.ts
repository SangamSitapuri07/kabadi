import crypto from "crypto";
import { env } from "../../config/env";

export interface SmsDispatchResult {
  provider: "sandbox" | "msg91" | "twilio";
  delivered: boolean;
  providerMessageId: string;
  dispatchedAtIso: string;
}

export interface SmsGatewayAdapter {
  readonly providerName: "sandbox" | "msg91" | "twilio";
  sendOtpCode(phoneE164: string, otpCode: string): Promise<SmsDispatchResult>;
}

const sandboxDispatchHistory: Array<{
  phoneMasked: string;
  providerMessageId: string;
  dispatchedAtIso: string;
}> = [];

export function getRecentSandboxSmsDispatches() {
  return [...sandboxDispatchHistory];
}

class SandboxSmsAdapter implements SmsGatewayAdapter {
  readonly providerName = "sandbox" as const;

  async sendOtpCode(phoneE164: string, _otpCode: string): Promise<SmsDispatchResult> {
    const id = `sbx-msg-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    // Never store plaintext OTP in logs or memory history!
    const phoneMasked = `${phoneE164.slice(0, 5)}****${phoneE164.slice(-2)}`;
    sandboxDispatchHistory.push({
      phoneMasked,
      providerMessageId: id,
      dispatchedAtIso: now,
    });
    if (sandboxDispatchHistory.length > 100) {
      sandboxDispatchHistory.shift();
    }
    return {
      provider: "sandbox",
      delivered: true,
      providerMessageId: id,
      dispatchedAtIso: now,
    };
  }
}

class Msg91SmsAdapter implements SmsGatewayAdapter {
  readonly providerName = "msg91" as const;

  async sendOtpCode(phoneE164: string, otpCode: string): Promise<SmsDispatchResult> {
    if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID) {
      throw new Error("MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required for msg91 provider");
    }
    const mobileDigits = phoneE164.replace(/^\+/, "");
    const res = await fetch("https://control.msg91.com/api/v5/otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authkey: env.MSG91_AUTH_KEY,
      },
      body: JSON.stringify({
        template_id: env.MSG91_TEMPLATE_ID,
        mobile: mobileDigits,
        otp: otpCode,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { request_id?: string };
    return {
      provider: "msg91",
      delivered: res.ok,
      providerMessageId: json.request_id ?? `msg91-${Date.now()}`,
      dispatchedAtIso: new Date().toISOString(),
    };
  }
}

class TwilioMessagingAdapter implements SmsGatewayAdapter {
  readonly providerName = "twilio" as const;

  async sendOtpCode(phoneE164: string, otpCode: string): Promise<SmsDispatchResult> {
    if (
      !env.TWILIO_ACCOUNT_SID ||
      !env.TWILIO_AUTH_TOKEN ||
      !env.TWILIO_FROM_NUMBER
    ) {
      throw new Error(
        "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER are required for twilio provider"
      );
    }
    const credentials = Buffer.from(
      `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");
    const form = new URLSearchParams({
      To: phoneE164,
      From: env.TWILIO_FROM_NUMBER,
      Body: `Your Kabadiwala Connect verification code is ${otpCode}. Valid for 5 minutes.`,
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );
    const json = (await res.json().catch(() => ({}))) as { sid?: string };
    return {
      provider: "twilio",
      delivered: res.ok,
      providerMessageId: json.sid ?? `twilio-${Date.now()}`,
      dispatchedAtIso: new Date().toISOString(),
    };
  }
}

export function resolveSmsGatewayAdapter(): SmsGatewayAdapter {
  switch (env.SMS_PROVIDER) {
    case "msg91":
      return new Msg91SmsAdapter();
    case "twilio":
      return new TwilioMessagingAdapter();
    default:
      return new SandboxSmsAdapter();
  }
}

/**
 * Computes HMAC-SHA256 hex digest over `${timestampSec}.${rawPayload}` for signed payment webhooks.
 */
export function computeWebhookHmacSignature(
  timestampSec: number | string,
  rawPayload: string,
  secret = env.PAYMENT_WEBHOOK_SECRET
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestampSec}.${rawPayload}`)
    .digest("hex");
}

/**
 * Constant-time HMAC-SHA256 verification preventing timing side-channel signature forgery.
 */
export function verifyWebhookHmacSignature(
  timestampSec: string,
  rawPayload: string,
  providedHexSig: string,
  secret = env.PAYMENT_WEBHOOK_SECRET,
  maxSkewSeconds = 300
): { valid: boolean; reason?: string } {
  const tsNum = Number(timestampSec);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, reason: "INVALID_TIMESTAMP_HEADER" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > maxSkewSeconds) {
    return { valid: false, reason: "WEBHOOK_TIMESTAMP_OUTSIDE_REPLAY_WINDOW" };
  }

  const expectedHex = computeWebhookHmacSignature(tsNum, rawPayload, secret);
  const expectedBuf = Buffer.from(expectedHex, "utf8");
  const actualBuf = Buffer.from(providedHexSig.trim().toLowerCase(), "utf8");

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: "SIGNATURE_MISMATCH" };
  }
  const equal = crypto.timingSafeEqual(expectedBuf, actualBuf);
  return equal ? { valid: true } : { valid: false, reason: "SIGNATURE_MISMATCH" };
}
