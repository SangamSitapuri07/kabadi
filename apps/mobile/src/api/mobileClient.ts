import { SupportedLanguage, SupplyChainTier, UserRole } from "@kabadi/shared";
import {
  clearMobileSessionTokens,
  expoSecureTokenAdapter,
  getMobileAccessToken,
  getMobileRefreshToken,
  saveMobileSessionTokens,
  TokenStorageAdapter,
} from "../security/secureSession";

export interface MobileActorProfile {
  id: string;
  role: UserRole;
  tier: SupplyChainTier;
  phone: string;
  email: string | null;
  platformCode: string;
  verificationLevel: string;
  profile?: {
    displayName?: string;
    preferredLanguage?: SupportedLanguage;
    city?: string;
    pincode?: string;
  } | null;
}

export interface QrResolutionResult {
  kind: "VERIFY_ENTITY" | "TRACE_BALE" | "UPI_PAYMENT_INTENT" | "UNRECOGNIZED";
  extractedKey: string;
  upiUri?: string;
  serverData?: Record<string, unknown>;
}

/**
 * Pure helper parsing raw camera QR codes scanned in the field:
 * - Public entity verification badges: `https://.../verify/KC-...` or bare `KC-COL-...` / `KC-SHP-...`
 * - Public supply-chain bale lineage stickers: `https://.../trace/KC-TRACE-...` or bare `KC-TRACE-...`
 * - Dynamic NPCI UPI deep-links: `upi://pay?pa=...`
 */
export function classifyScannedQrString(raw: string): {
  kind: QrResolutionResult["kind"];
  key: string;
} {
  const trimmed = raw.trim();
  if (/^upi:\/\/pay/i.test(trimmed)) {
    return { kind: "UPI_PAYMENT_INTENT", key: trimmed };
  }

  const traceMatch = trimmed.match(/\/trace\/([A-Za-z0-9_-]+)/i);
  if (traceMatch?.[1]) {
    return { kind: "TRACE_BALE", key: traceMatch[1] };
  }
  if (/^KC-TRACE-/i.test(trimmed) || /^KBC-BALE-/i.test(trimmed)) {
    return { kind: "TRACE_BALE", key: trimmed };
  }

  const verifyMatch = trimmed.match(/\/verify\/([A-Za-z0-9_-]+)/i);
  if (verifyMatch?.[1]) {
    return { kind: "VERIFY_ENTITY", key: verifyMatch[1] };
  }
  if (/^KC-/i.test(trimmed) || /^KBC-/i.test(trimmed)) {
    return { kind: "VERIFY_ENTITY", key: trimmed };
  }

  return { kind: "UNRECOGNIZED", key: trimmed };
}

export class MobileApiClient {
  constructor(
    public apiBaseUrl: string,
    private readonly tokenAdapter: TokenStorageAdapter = expoSecureTokenAdapter,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  setApiBaseUrl(nextUrl: string): void {
    this.apiBaseUrl = nextUrl.replace(/\/+$/, "");
  }

  async requestJson<T>(
    path: string,
    init: RequestInit = {},
    allowRefreshRetry = true
  ): Promise<{ ok: boolean; status: number; data?: T; errorMessage?: string }> {
    const accessToken = await getMobileAccessToken(this.tokenAdapter);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (accessToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers,
    });

    if (res.status === 401 && allowRefreshRetry) {
      const refreshed = await this.tryRotateTokens();
      if (refreshed) {
        return this.requestJson<T>(path, init, false);
      }
    }

    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: T;
      error?: { code?: string; message?: string };
    };

    if (!res.ok || body.success === false) {
      return {
        ok: false,
        status: res.status,
        errorMessage: body.error?.message ?? `HTTP ${res.status}`,
      };
    }

    return { ok: true, status: res.status, data: body.data };
  }

  async tryRotateTokens(): Promise<boolean> {
    const refreshToken = await getMobileRefreshToken(this.tokenAdapter);
    if (!refreshToken) return false;

    const res = await this.fetchImpl(`${this.apiBaseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      await clearMobileSessionTokens(this.tokenAdapter);
      return false;
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: { tokens?: { accessToken: string; refreshToken: string } };
    };
    if (!body.success || !body.data?.tokens) {
      await clearMobileSessionTokens(this.tokenAdapter);
      return false;
    }

    await saveMobileSessionTokens(body.data.tokens, this.tokenAdapter);
    return true;
  }

  // ── 1. Mobile OTP & Credentials Auth ────────────────────────────────────────
  async requestPhoneOtpLogin(phone: string) {
    return this.requestJson<{
      sent: boolean;
      expiresInSeconds: number;
      devPreviewOtp?: string;
    }>(
      "/api/v1/auth/otp/login-request",
      {
        method: "POST",
        body: JSON.stringify({ phone }),
      },
      false
    );
  }

  async verifyPhoneOtpLogin(phone: string, code: string) {
    const res = await this.requestJson<{
      user: MobileActorProfile;
      tokens: { accessToken: string; refreshToken: string };
    }>(
      "/api/v1/auth/otp/login-verify",
      {
        method: "POST",
        body: JSON.stringify({ phone, code }),
      },
      false
    );
    if (res.ok && res.data?.tokens) {
      await saveMobileSessionTokens(res.data.tokens, this.tokenAdapter);
    }
    return res;
  }

  async loginWithCredentials(identifier: string, password: string) {
    const res = await this.requestJson<{
      user: MobileActorProfile;
      tokens: { accessToken: string; refreshToken: string };
    }>(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ identifier, password }),
      },
      false
    );
    if (res.ok && res.data?.tokens) {
      await saveMobileSessionTokens(res.data.tokens, this.tokenAdapter);
    }
    return res;
  }

  async getMe() {
    return this.requestJson<{ user: MobileActorProfile }>("/api/v1/auth/me");
  }

  async logout(): Promise<void> {
    await this.requestJson("/api/v1/auth/logout", { method: "POST" }, false).catch(
      () => undefined
    );
    await clearMobileSessionTokens(this.tokenAdapter);
  }

  // ── 2. Storefronts, Materials, Price History, Spoken Audio & Bidding ────────
  async listStorefronts(tier?: string) {
    const qs = tier ? `?tier=${encodeURIComponent(tier)}` : "";
    return this.requestJson<{
      storefronts: Array<Record<string, unknown>>;
      pricingDisclaimer: string;
    }>(`/api/v1/storefronts${qs}`);
  }

  async listMaterials() {
    return this.requestJson<{ categories: Array<Record<string, unknown>> }>(
      "/api/v1/materials"
    );
  }

  async getPriceTrends(materialSlug = "metal-copper-bright") {
    return this.requestJson<{
      history: Array<Record<string, unknown>>;
      tierArbitrageSpreads: Array<Record<string, unknown>>;
    }>(
      `/api/v1/materials/price-history?materialSlug=${encodeURIComponent(materialSlug)}`
    );
  }

  async getStorefrontSpeechScript(
    storefrontId: string,
    language: SupportedLanguage
  ) {
    return this.requestJson<{ locale: string; script: string }>(
      "/api/v1/ai/speech-script",
      {
        method: "POST",
        body: JSON.stringify({
          contextType: "STOREFRONT_RATES",
          language,
          storefrontId,
        }),
      }
    );
  }

  async listOpenListings() {
    return this.requestJson<{ listings: Array<Record<string, unknown>> }>(
      "/api/v1/listings/open"
    );
  }

  async createListingOrOrder(payload: {
    title: string;
    pickupPincode: string;
    pickupAddressPrivate: string;
    preferredMode: "SELLER_DROPOFF" | "BUYER_PICKUP";
    targetStorefrontId?: string;
    items: Array<{ materialSlug: string; estimatedGrams: number }>;
  }) {
    return this.requestJson<{
      listing: Record<string, unknown>;
      order?: Record<string, unknown>;
    }>("/api/v1/listings", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async placeOffer(
    listingId: string,
    offeredTotalPaise: number,
    message?: string
  ) {
    return this.requestJson<{ offer: Record<string, unknown> }>(
      `/api/v1/listings/${listingId}/offers`,
      {
        method: "POST",
        body: JSON.stringify({
          offeredTotalPaise,
          fulfillmentMode: "BUYER_PICKUP",
          message,
        }),
      }
    );
  }

  // ── 3. Stock Bins, Upward Sales, Khata Ledger & Orders / UPI Slip ───────────
  async listBins() {
    return this.requestJson<{ bins: Array<Record<string, unknown>> }>(
      "/api/v1/inventory/bins"
    );
  }

  async sellBinUpward(params: {
    binId: string;
    sellGrams: number;
    targetStorefrontId: string;
    fulfillmentMode: "BUYER_PICKUP" | "SELLER_DROPOFF";
  }) {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/inventory/bins/${params.binId}/sell-upward`,
      {
        method: "POST",
        body: JSON.stringify({
          sellGrams: params.sellGrams,
          targetStorefrontId: params.targetStorefrontId,
          fulfillmentMode: params.fulfillmentMode,
        }),
      }
    );
  }

  async listKhataEntries() {
    return this.requestJson<{ entries: Array<Record<string, unknown>> }>(
      "/api/v1/khata"
    );
  }

  async createKhataEntry(params: {
    borrowerPlatformCode: string;
    amountPaise: number;
    entryType: "CASH_ADVANCE_GIVEN" | "CASH_REPAYMENT";
    notes?: string;
  }) {
    return this.requestJson<{ entry: Record<string, unknown> }>(
      "/api/v1/khata/entries",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  async listOrders() {
    return this.requestJson<{ orders: Array<Record<string, unknown>> }>(
      "/api/v1/orders"
    );
  }

  async acceptOrder(orderId: string) {
    return this.requestJson<{ order: Record<string, unknown> }>(
      `/api/v1/orders/${orderId}/accept`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
  }

  async weighAndSettleOrder(params: {
    orderId: string;
    items: Array<{ orderItemId: string; actualGrams: number }>;
    adjustmentPaise?: number;
    autoOffsetKhataAdvance?: boolean;
  }) {
    return this.requestJson<{ order: Record<string, unknown> }>(
      `/api/v1/orders/${params.orderId}/weigh-and-settle`,
      {
        method: "POST",
        body: JSON.stringify({
          items: params.items,
          adjustmentPaise: params.adjustmentPaise ?? 0,
          autoOffsetKhataAdvance: params.autoOffsetKhataAdvance ?? true,
        }),
      }
    );
  }

  async getSettlementSlip(orderId: string) {
    return this.requestJson<{
      slip: {
        slipNumber: string;
        receiptDigestSha256: string;
        upi: {
          upiIntentUri: string;
          upiQrSvg: string;
        };
        traceQrSvg: string;
        totals: {
          grossAmountPaise: number;
          khataAdvanceOffsetPaise: number;
          netPayablePaise: number;
          netPayableExactInr: string;
        };
      };
    }>(`/api/v1/orders/${orderId}/settlement-slip`);
  }

  // ── 4. Native Camera Vision, 7-Segment Scale OCR & Live QR Resolver ─────────
  async scanMaterialBase64(params: {
    imageBase64: string;
    estimatedGrams: number;
    city: string;
    language: SupportedLanguage;
    orderId?: string;
  }) {
    return this.requestJson<Record<string, unknown>>(
      "/api/v1/ai/vision-verify",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  async scanScaleOcrBase64(params: {
    imageBase64: string;
    declaredGrams: number;
    language: SupportedLanguage;
    orderId?: string;
  }) {
    return this.requestJson<Record<string, unknown>>("/api/v1/ai/scale-ocr", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async confirmScan(scanId: string) {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/ai/scans/${scanId}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({}),
      }
    );
  }

  async scanApplianceXrayBase64(params: {
    imageBase64: string;
    observedCondition?:
      | "POWERS_ON_INTACT"
      | "CRACKED_SCREEN_BOOTS"
      | "DEAD_BOOT_INTACT_BODY"
      | "HEAVILY_DAMAGED_SCRAP";
    coilTypeHint?: "UNKNOWN" | "COPPER" | "ALUMINUM";
  }) {
    return this.requestJson<Record<string, unknown>>(
      "/api/v1/ai/xray-estimate",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    );
  }

  async askVernacularAssistant(params: {
    message: string;
    language?: SupportedLanguage;
    autoCreateListing?: boolean;
  }) {
    return this.requestJson<Record<string, unknown>>("/api/v1/ai/assistant", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getMarketIntelligence(city?: string) {
    const q = city ? `?city=${encodeURIComponent(city)}` : "";
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/ai/market-intelligence${q}`
    );
  }

  async matchSmartBuyers(params: {
    city?: string;
    pincode?: string;
    fulfillmentMode?: "BUYER_PICKUP" | "SELLER_DROPOFF";
    items: Array<{ materialSlug: string; weightGrams: number }>;
  }) {
    return this.requestJson<Record<string, unknown>>("/api/v1/ai/smart-match", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async fetchSampleFrameBase64(query: string): Promise<string> {
    const res = await this.fetchImpl(
      `${this.apiBaseUrl}/api/v1/ai/sample-frame?${query}`
    );
    const arrayBuf = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }
    if (typeof btoa === "function") {
      return btoa(binary);
    }
    return Buffer.from(arrayBuf).toString("base64");
  }

  async resolveScannedQrPayload(rawQr: string): Promise<QrResolutionResult> {
    const classified = classifyScannedQrString(rawQr);
    if (classified.kind === "UPI_PAYMENT_INTENT") {
      return {
        kind: "UPI_PAYMENT_INTENT",
        extractedKey: classified.key,
        upiUri: classified.key,
      };
    }
    if (classified.kind === "VERIFY_ENTITY") {
      const res = await this.requestJson<Record<string, unknown>>(
        `/api/v1/public/verify/${encodeURIComponent(classified.key)}`
      );
      return {
        kind: "VERIFY_ENTITY",
        extractedKey: classified.key,
        serverData: res.data ?? { error: res.errorMessage ?? "Entity not found" },
      };
    }
    if (classified.kind === "TRACE_BALE") {
      const res = await this.requestJson<Record<string, unknown>>(
        `/api/v1/public/trace/${encodeURIComponent(classified.key)}`
      );
      return {
        kind: "TRACE_BALE",
        extractedKey: classified.key,
        serverData: res.data ?? { error: res.errorMessage ?? "Bale not found" },
      };
    }
    return {
      kind: "UNRECOGNIZED",
      extractedKey: classified.key,
    };
  }
}
