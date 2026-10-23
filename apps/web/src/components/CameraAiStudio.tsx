"use client";

import React, { useRef, useState } from "react";
import {
  Camera,
  Cpu,
  Scale,
  Upload,
  ShieldAlert,
  CheckCircle2,
  Volume2,
  Sparkles,
  Fingerprint,
  Video,
  XCircle,
  MessageSquare,
  TrendingUp,
  Mic,
} from "lucide-react";
import { AppLanguage, LANGUAGE_META } from "../lib/vernacularAudio";

interface OrderSummaryOption {
  id: string;
  orderNumber: string;
  status: string;
  items: Array<{ id: string; estimatedGrams: number; material: { nameEn: string } }>;
}

interface CameraAiStudioProps {
  lang: AppLanguage;
  accessToken: string;
  hasUser: boolean;
  pendingBuyerOrders: OrderSummaryOption[];
  onSpeak: (text: string, tone?: "verified" | "alert" | "info") => void;
  onNotify: (type: "ok" | "err", text: string) => void;
  onOrderSettled: () => Promise<void>;
}

export function CameraAiStudio({
  lang,
  accessToken,
  hasUser,
  pendingBuyerOrders,
  onSpeak,
  onNotify,
  onOrderSettled,
}: CameraAiStudioProps) {
  const [subMode, setSubMode] = useState<
    "vision" | "scale" | "xray" | "assistant" | "mandi"
  >("vision");

  // Shared live webcam state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  // Sub-mode 1: Vision Material & Anti-Fraud state
  const [visionPreviewUrl, setVisionPreviewUrl] = useState<string>("");
  const [visionLastBlob, setVisionLastBlob] = useState<Blob | null>(null);
  const [visionEstKg, setVisionEstKg] = useState<string>("6.5");
  const [visionLoading, setVisionLoading] = useState(false);
  const [visionResult, setVisionResult] = useState<Record<string, unknown> | null>(null);
  const [humanConfirmed, setHumanConfirmed] = useState(false);

  // Sub-mode 2: 7-Segment / LCD / Paper Slip Digital Scale OCR & Anti-Replay state
  const [scaleSimDigits, setScaleSimDigits] = useState<string>("12.45");
  const [scaleLedColor, setScaleLedColor] = useState<
    "RED" | "GREEN" | "LCD" | "PAPER_SLIP"
  >("RED");
  const [declaredWeightKg, setDeclaredWeightKg] = useState<string>("12.45");
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [scalePreviewUrl, setScalePreviewUrl] = useState<string>("");
  const [scaleLastBlob, setScaleLastBlob] = useState<Blob | null>(null);
  const [scaleLoading, setScaleLoading] = useState(false);
  const [scaleResult, setScaleResult] = useState<Record<string, unknown> | null>(null);

  // Sub-mode 3: Device Internal Component BOM X-Ray state
  const [deviceQuery, setDeviceQuery] = useState<string>("Redmi Note Smartphone 5G");
  const [deviceCondition, setDeviceCondition] = useState<
    "POWERS_ON_INTACT" | "CRACKED_SCREEN_BOOTS" | "DEAD_BOOT_INTACT_BODY" | "HEAVILY_DAMAGED_SCRAP"
  >("DEAD_BOOT_INTACT_BODY");
  const [coilHint, setCoilHint] = useState<"UNKNOWN" | "COPPER" | "ALUMINUM">("UNKNOWN");
  const [xrayLoading, setXrayLoading] = useState(false);
  const [xrayPreviewUrl, setXrayPreviewUrl] = useState<string>("");
  const [xrayResult, setXrayResult] = useState<Record<string, unknown> | null>(null);

  // Sub-mode 4: Vernacular Neural Voice/Chat Kabadi Assistant state
  const [chatInput, setChatInput] = useState<string>(
    "Mere paas 2 purane AC aur 15 kg tamba hai Ludhiana mein kitna milega?"
  );
  const [chatLoading, setChatLoading] = useState(false);
  const [listeningMic, setListeningMic] = useState(false);
  const [chatResult, setChatResult] = useState<Record<string, unknown> | null>(null);

  // Sub-mode 5: AI Mandi Price Forecaster & Smart Upward Buyer Matcher state
  const [intelCity, setIntelCity] = useState<string>("Ludhiana");
  const [intelLoading, setIntelLoading] = useState(false);
  const [marketIntel, setMarketIntel] = useState<Record<string, unknown> | null>(null);
  const [matchSlug, setMatchSlug] = useState<string>("metal-copper-bright");
  const [matchKg, setMatchKg] = useState<string>("120");
  const [smartMatchResult, setSmartMatchResult] = useState<Record<string, unknown> | null>(
    null
  );

  const submitXrayPhotoBlob = async (blob: Blob, filename = "appliance-camera.png") => {
    if (!hasUser) {
      onNotify("err", "Select a role session first");
      return;
    }
    setXrayLoading(true);
    setXrayPreviewUrl(URL.createObjectURL(blob));
    const form = new FormData();
    form.append("image", blob, filename);
    form.append("observedCondition", deviceCondition);
    if (coilHint !== "UNKNOWN") form.append("coilTypeHint", coilHint);

    const res = await fetch("/api/v1/ai/xray-estimate", {
      method: "POST",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: "include",
      body: form,
    });
    const json = await res.json();
    setXrayLoading(false);
    if (json.success) {
      setXrayResult(json.data);
      const harvest = (
        (json.data.indicativePathways as Record<string, unknown>)
          ?.partsHarvest as Record<string, unknown>
      )?.displayRangeInr;
      onSpeak(
        `${json.data.matchedDevice.modelName}. Indicative parts harvest ${harvest}.`,
        "verified"
      );
    } else {
      onNotify("err", json.error?.message || "Camera X-Ray scan failed");
    }
  };

  const runXrayCameraPreset = async (preset: string) => {
    const res = await fetch(`/api/v1/ai/sample-frame?kind=${encodeURIComponent(preset)}`);
    const blob = await res.blob();
    await submitXrayPhotoBlob(blob, `${preset}.png`);
  };

  const runAssistantQuery = async (overrideMsg?: string, autoCreate = false) => {
    const msg = overrideMsg ?? chatInput;
    if (overrideMsg) setChatInput(overrideMsg);
    setChatLoading(true);
    const res = await fetch("/api/v1/ai/assistant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      credentials: "include",
      body: JSON.stringify({
        message: msg,
        language: lang,
        autoCreateListing: autoCreate,
      }),
    });
    const json = await res.json();
    setChatLoading(false);
    if (json.success) {
      setChatResult(json.data);
      onSpeak(String(json.data.replyText ?? ""), "verified");
      if (json.data.createdListing) {
        await onOrderSettled();
        onNotify("ok", `Live Pickup Listing Created: ${json.data.createdListing.title}`);
      }
    } else {
      onNotify("err", json.error?.message || "Assistant query failed");
    }
  };

  const startVoiceMicInput = () => {
    const w = window as unknown as Record<string, unknown>;
    const SpeechRec = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => {
          lang: string;
          interimResults: boolean;
          onresult: (ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
          onerror: () => void;
          onend: () => void;
          start: () => void;
        })
      | undefined;
    if (!SpeechRec) {
      onNotify("err", "Browser SpeechRecognition unavailable — type or click any vernacular chip!");
      return;
    }
    const rec = new SpeechRec();
    rec.lang = LANGUAGE_META[lang].locale;
    rec.interimResults = false;
    setListeningMic(true);
    rec.onresult = (ev) => {
      const spoken = ev.results?.[0]?.[0]?.transcript ?? "";
      if (spoken) {
        setChatInput(spoken);
        runAssistantQuery(spoken, false);
      }
    };
    rec.onerror = () => setListeningMic(false);
    rec.onend = () => setListeningMic(false);
    rec.start();
  };

  const loadMandiAndSmartMatch = async () => {
    setIntelLoading(true);
    const [iRes, mRes] = await Promise.all([
      fetch(`/api/v1/ai/market-intelligence?city=${encodeURIComponent(intelCity)}`),
      fetch("/api/v1/ai/smart-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: intelCity,
          fulfillmentMode: "SELLER_DROPOFF",
          items: [
            {
              materialSlug: matchSlug,
              weightGrams: Math.max(500, Math.round(Number(matchKg || "50") * 1000)),
            },
          ],
        }),
      }),
    ]);
    const [iJson, mJson] = await Promise.all([iRes.json(), mRes.json()]);
    setIntelLoading(false);
    if (iJson.success) setMarketIntel(iJson.data);
    if (mJson.success) setSmartMatchResult(mJson.data);
  };

  const startLiveCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } },
      });
      setCameraActive(true);
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 50);
    } catch {
      onNotify(
        "err",
        "Camera permission unavailable in this browser tab — use Upload Photo or any 1-Click Real PNG Preset!"
      );
    }
  };

  const stopLiveCamera = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  const snapLiveCameraBlob = async (): Promise<Blob | null> => {
    if (!videoRef.current) return null;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth || 640;
    canvas.height = videoRef.current.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    stopLiveCamera();
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
  };

  const submitVisionBlob = async (blob: Blob, filename = "camera-lot.png") => {
    if (!hasUser) {
      onNotify("err", "Select an active role session first");
      return;
    }
    setVisionLoading(true);
    setHumanConfirmed(false);
    setVisionLastBlob(blob);
    setVisionPreviewUrl(URL.createObjectURL(blob));

    const form = new FormData();
    form.append("image", blob, filename);
    form.append("estimatedGrams", String(Math.max(100, Math.round(Number(visionEstKg) * 1000))));
    form.append("language", lang);

    const res = await fetch("/api/v1/ai/vision-verify", {
      method: "POST",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: "include",
      body: form,
    });
    const json = await res.json();
    setVisionLoading(false);

    if (json.success) {
      setVisionResult(json.data);
      const scripts = json.data.vernacularAudioScripts as Record<string, string>;
      const isAlert = json.data.antiFraudForensics.fraudRiskLevel === "HIGH";
      onSpeak(scripts[lang] ?? scripts.EN ?? "", isAlert ? "alert" : "verified");
    } else {
      onNotify("err", json.error?.message || "Vision scan rejected");
    }
  };

  const runVisionPreset = async (preset: string) => {
    const res = await fetch(`/api/v1/ai/sample-frame?kind=${encodeURIComponent(preset)}`);
    const blob = await res.blob();
    await submitVisionBlob(blob, `${preset}.png`);
  };

  const handleConfirmVisionScan = async () => {
    if (!visionResult?.scanId) return;
    const res = await fetch(`/api/v1/ai/scans/${String(visionResult.scanId)}/confirm`, {
      method: "POST",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: "include",
    });
    const json = await res.json();
    if (json.success) {
      setHumanConfirmed(true);
      onNotify("ok", "Human-in-the-loop confirmation recorded on AIScanRecord!");
    }
  };

  const submitScaleBlob = async (blob: Blob, filename = "scale-frame.png") => {
    if (!hasUser) {
      onNotify("err", "Select an active role session first");
      return;
    }
    setScaleLoading(true);
    setScaleLastBlob(blob);
    setScalePreviewUrl(URL.createObjectURL(blob));

    const form = new FormData();
    form.append("image", blob, filename);
    form.append(
      "declaredGrams",
      String(Math.max(50, Math.round(Number(declaredWeightKg) * 1000)))
    );
    form.append("language", lang);
    if (selectedOrderId) {
      form.append("orderId", selectedOrderId);
    }

    const res = await fetch("/api/v1/ai/scale-ocr", {
      method: "POST",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: "include",
      body: form,
    });
    const json = await res.json();
    setScaleLoading(false);

    if (json.success) {
      setScaleResult(json.data);
      const scripts = json.data.vernacularAudioScripts as Record<string, string>;
      const bad = json.data.ocrDiscrepancyFlag || json.data.replayFraudDetected;
      onSpeak(scripts[lang] ?? scripts.EN ?? "", bad ? "alert" : "verified");
    } else {
      onNotify("err", json.error?.message || "Scale OCR scan rejected");
    }
  };

  const runSimulatedScaleScan = async (overrideSimDigits?: string, overrideDeclaredKg?: string) => {
    const digits = overrideSimDigits ?? scaleSimDigits;
    const decl = overrideDeclaredKg ?? declaredWeightKg;
    if (overrideSimDigits) setScaleSimDigits(overrideSimDigits);
    if (overrideDeclaredKg) setDeclaredWeightKg(overrideDeclaredKg);

    const res = await fetch(
      `/api/v1/ai/sample-frame?kind=scale&kg=${encodeURIComponent(digits)}&led=${scaleLedColor}`
    );
    const pngBlob = await res.blob();

    // Update declared field before submitting
    setScaleLoading(true);
    setScaleLastBlob(pngBlob);
    setScalePreviewUrl(URL.createObjectURL(pngBlob));

    const form = new FormData();
    form.append("image", pngBlob, `scale-${digits}.png`);
    form.append("declaredGrams", String(Math.max(50, Math.round(Number(decl) * 1000))));
    form.append("language", lang);
    if (selectedOrderId) form.append("orderId", selectedOrderId);

    const apiRes = await fetch("/api/v1/ai/scale-ocr", {
      method: "POST",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      credentials: "include",
      body: form,
    });
    const json = await apiRes.json();
    setScaleLoading(false);

    if (json.success) {
      setScaleResult(json.data);
      const scripts = json.data.vernacularAudioScripts as Record<string, string>;
      const bad = json.data.ocrDiscrepancyFlag || json.data.replayFraudDetected;
      onSpeak(scripts[lang] ?? scripts.EN ?? "", bad ? "alert" : "verified");
    }
  };

  const runLossyJpegReplayAttackDemo = async () => {
    if (!scaleLastBlob) {
      onNotify("err", "Run at least one Scale OCR scan first, then click Replay Attack!");
      return;
    }
    // Re-encode the previous PNG blob into a lossy 70% JPEG on HTML5 Canvas (producing a 100% brand-new SHA-256!)
    const imgBitmap = await createImageBitmap(scaleLastBlob);
    const canvas = document.createElement("canvas");
    canvas.width = imgBitmap.width;
    canvas.height = imgBitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(imgBitmap, 0, 0);
    const recompressedJpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.7)
    );
    if (recompressedJpeg) {
      await submitScaleBlob(recompressedJpeg, "recompressed-yesterday-scale.jpg");
    }
  };

  const handleSettleOrderWithScaleScan = async () => {
    const target = pendingBuyerOrders.find((o) => o.id === selectedOrderId);
    if (!target || !scaleResult?.scanId) return;

    const gramsToSettle =
      typeof scaleResult.scaleReadGrams === "number"
        ? scaleResult.scaleReadGrams
        : Number(declaredWeightKg) * 1000;

    const res = await fetch(`/api/v1/orders/${target.id}/weigh-and-settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      credentials: "include",
      body: JSON.stringify({
        items: target.items.map((it, idx) => ({
          orderItemId: it.id,
          actualGrams: idx === 0 ? Math.round(gramsToSettle) : it.estimatedGrams,
        })),
        scaleScanId: String(scaleResult.scanId),
        autoOffsetKhataAdvance: true,
      }),
    });
    const json = await res.json();
    if (json.success) {
      await onOrderSettled();
      onNotify(
        "ok",
        `Order ${target.orderNumber} settled using verified Scale Scan (${(
          gramsToSettle / 1000
        ).toFixed(2)} kg)!`
      );
    } else {
      onNotify("err", `${json.error?.code}: ${json.error?.message}`);
    }
  };

  const runDeviceXray = async (
    qOverride?: string,
    coilOverride?: "UNKNOWN" | "COPPER" | "ALUMINUM"
  ) => {
    if (!hasUser) {
      onNotify("err", "Select a role session first");
      return;
    }
    setXrayLoading(true);
    const q = qOverride ?? deviceQuery;
    const c = coilOverride ?? coilHint;
    if (qOverride) setDeviceQuery(qOverride);
    if (coilOverride) setCoilHint(coilOverride);

    const res = await fetch("/api/v1/ai/xray-estimate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      credentials: "include",
      body: JSON.stringify({
        deviceQuery: q,
        observedCondition: deviceCondition,
        coilTypeHint: c,
        city: "Ludhiana",
      }),
    });
    const json = await res.json();
    setXrayLoading(false);
    if (json.success) {
      setXrayResult(json.data);
      const harvest = (
        (json.data.indicativePathways as Record<string, unknown>)
          ?.partsHarvest as Record<string, unknown>
      )?.displayRangeInr;
      onSpeak(
        `${json.data.matchedDevice.modelName}. Indicative parts harvest value ${harvest}.`,
        "info"
      );
    } else {
      onNotify("err", json.error?.message || "X-Ray scan failed");
    }
  };

  return (
    <div className="space-y-6">
      {/* Sub-Navigation Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSubMode("vision")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
              subMode === "vision"
                ? "bg-emerald-800 text-white shadow"
                : "bg-white text-emerald-950 border border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            <Camera className="h-4 w-4" />
            1. Camera Material & Anti-Fraud Vision
          </button>

          <button
            type="button"
            onClick={() => setSubMode("scale")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
              subMode === "scale"
                ? "bg-emerald-800 text-white shadow"
                : "bg-white text-emerald-950 border border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            <Scale className="h-4 w-4" />
            2. Digital Scale 7-Segment OCR & Anti-Replay
          </button>

          <button
            type="button"
            onClick={() => setSubMode("xray")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
              subMode === "xray"
                ? "bg-emerald-800 text-white shadow"
                : "bg-white text-emerald-950 border border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            <Cpu className="h-4 w-4" />
            3. Camera Photo X-Ray CNN
          </button>

          <button
            type="button"
            onClick={() => setSubMode("assistant")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
              subMode === "assistant"
                ? "bg-emerald-800 text-white shadow"
                : "bg-white text-emerald-950 border border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            <MessageSquare className="h-4 w-4" />
            4. Vernacular AI Kabadi Assistant
          </button>

          <button
            type="button"
            onClick={() => {
              setSubMode("mandi");
              if (!marketIntel) loadMandiAndSmartMatch();
            }}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
              subMode === "mandi"
                ? "bg-emerald-800 text-white shadow"
                : "bg-white text-emerald-950 border border-emerald-200 hover:bg-emerald-100"
            }`}
          >
            <TrendingUp className="h-4 w-4" />
            5. AI Mandi Forecast & Smart Match
          </button>
        </div>

        <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-900 ring-1 ring-emerald-200">
          Active Audio Readout: {LANGUAGE_META[lang].nativeLabel} ({LANGUAGE_META[lang].locale})
        </span>
      </div>

      {/* Live Camera Viewfinder Drawer (shared across Vision & Scale OCR) */}
      {cameraActive && (
        <div className="rounded-2xl border-2 border-emerald-600 bg-slate-950 p-4 text-white shadow-xl">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-bold text-emerald-300">
              Live Camera Viewfinder — Frame Scrap Material or Digital Scale Display
            </span>
            <button
              type="button"
              onClick={stopLiveCamera}
              className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 font-bold"
            >
              <XCircle className="h-3.5 w-3.5" /> Close Camera
            </button>
          </div>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="mx-auto max-h-72 rounded-xl border border-white/20"
          />
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={async () => {
                const blob = await snapLiveCameraBlob();
                if (!blob) return;
                if (subMode === "scale") await submitScaleBlob(blob, "webcam-scale.jpg");
                else if (subMode === "xray") await submitXrayPhotoBlob(blob, "webcam-xray.jpg");
                else await submitVisionBlob(blob, "webcam-material.jpg");
              }}
              className="rounded-xl bg-emerald-500 px-6 py-2.5 text-xs font-extrabold text-slate-950 hover:bg-emerald-400"
            >
              Capture Frame & Run Server Pixel Forensics
            </button>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-MODE 1: CAMERA MATERIAL SPECTRAL + ANTI-FRAUD VISION SCANNER    */}
      {/* =================================================================== */}
      {subMode === "vision" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900">
                <Sparkles className="h-3.5 w-3.5" /> Real Pixel Spectral + Forensics Engine
              </span>
              <span className="font-mono text-[11px] text-slate-400">sharp v2.1</span>
            </div>

            <h2 className="text-lg font-bold text-slate-900">
              Verify Copper vs. Aluminium, Grade-A PCBs & Adulteration Fraud
            </h2>
            <p className="text-xs text-slate-600">
              Inspects actual JPEG/PNG pixel histograms, 3×3 Laplacian sharpness, 64-bit <code className="font-mono">dHash</code> photo replay signatures, illegal wire-burning soot, and wet cardboard moisture weight inflation.
            </p>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Estimated Lot Weight (kg)
              </label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={visionEstKg}
                onChange={(e) => setVisionEstKg(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={startLiveCamera}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white hover:bg-slate-800"
              >
                <Video className="h-4 w-4 text-emerald-400" />
                Live Camera
              </button>

              <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-emerald-600 bg-emerald-50 px-3 py-2.5 text-xs font-bold text-emerald-900 hover:bg-emerald-100">
                <Upload className="h-4 w-4" />
                Upload Photo
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) submitVisionBlob(f, f.name);
                  }}
                />
              </label>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="mb-2 text-xs font-bold text-slate-700">
                Or Scan a Real Rendered Camera Frame (Binary PNG Upload):
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("copper-clean")}
                  className="rounded-xl border border-slate-200 bg-orange-50/70 p-2.5 text-left font-semibold text-slate-900 hover:border-orange-400"
                >
                  🟠 Bright Clean Copper Wire (99% Cu)
                </button>
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("aluminum-coil")}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-left font-semibold text-slate-900 hover:border-slate-400"
                >
                  ⚪ Silvery Aluminium Coil (Non-Copper)
                </button>
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("pcb-grade-a")}
                  className="rounded-xl border border-slate-200 bg-emerald-50/70 p-2.5 text-left font-semibold text-slate-900 hover:border-emerald-500"
                >
                  🟢 High-Gold Grade-A Telecom PCB
                </button>
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("battery-pack")}
                  className="rounded-xl border border-slate-200 bg-blue-50/70 p-2.5 text-left font-semibold text-slate-900 hover:border-blue-400"
                >
                  🔋 Regulated Battery Pack (Safety Alert)
                </button>
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("copper-burnt-fraud")}
                  className="rounded-xl border border-rose-200 bg-rose-50/70 p-2.5 text-left font-semibold text-rose-950 hover:border-rose-400"
                >
                  🚨 Burnt Ash Copper (Illegal Wire Burn)
                </button>
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("cardboard-wet-fraud")}
                  className="rounded-xl border border-amber-200 bg-amber-50/70 p-2.5 text-left font-semibold text-amber-950 hover:border-amber-400"
                >
                  💧 Wet Soaked Cardboard (Moisture Fraud)
                </button>
                <button
                  type="button"
                  disabled={visionLoading}
                  onClick={() => runVisionPreset("mixed-copper-aluminum")}
                  className="col-span-2 rounded-xl border border-indigo-300 bg-indigo-50/80 p-2.5 text-left font-bold text-indigo-950 hover:border-indigo-500"
                >
                  🧩 Mixed Copper + Aluminium Heap (Live .onnx 3×3 Spatial Patch Neural Inference)
                </button>
              </div>

              {visionLastBlob && (
                <button
                  type="button"
                  onClick={() => submitVisionBlob(visionLastBlob, "replayed-photo.png")}
                  className="mt-2.5 w-full rounded-xl border border-purple-300 bg-purple-50 py-2 text-xs font-bold text-purple-900 hover:bg-purple-100"
                >
                  🔁 Re-Submit Last Photo to Test Duplicate Image Replay Guard
                </button>
              )}
            </div>
          </div>

          {/* Vision Forensics & Multi-Tier Valuation Output */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7">
            {!visionResult ? (
              <div className="flex h-full flex-col items-center justify-center py-14 text-center text-slate-500">
                <Camera className="mb-3 h-10 w-10 text-emerald-600" />
                <p className="text-sm font-bold text-slate-800">
                  Click any camera frame button on the left (or upload your own photo)
                </p>
                <p className="mt-1 max-w-md text-xs text-slate-500">
                  Every scan runs real server-side RGB/HSV spectral pixel analysis, 64-bit perceptual hashing, multi-tier storefront pricing, and spoken readout in {LANGUAGE_META[lang].nativeLabel}.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {(() => {
                  const det = visionResult.detectedMaterial as Record<string, unknown>;
                  const range = visionResult.indicativeRange as Record<string, unknown>;
                  const forensics = visionResult.antiFraudForensics as Record<string, unknown>;
                  const flags = (forensics.fraudFlags ?? []) as string[];
                  const imgInfo = forensics.imageForensics as Record<string, unknown>;
                  const tiers = (visionResult.liveMultiTierStorefrontMatches ?? []) as Array<
                    Record<string, unknown>
                  >;
                  const scripts = visionResult.vernacularAudioScripts as Record<string, string>;

                  return (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="flex items-start gap-4">
                          {visionPreviewUrl && (
                            <img
                              src={visionPreviewUrl}
                              alt="Scanned scrap material"
                              className="h-24 w-28 rounded-xl border border-slate-200 object-cover shadow-sm"
                            />
                          )}
                          <div>
                            <div className="flex flex-wrap gap-1.5">
                              <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-950">
                                {String(visionResult.priceType)} ·{" "}
                                {Math.round(Number(visionResult.confidence) * 100)}% Confidence
                              </span>
                              <span
                                className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                                  forensics.fraudRiskLevel === "HIGH"
                                    ? "bg-rose-100 text-rose-900"
                                    : "bg-emerald-100 text-emerald-900"
                                }`}
                              >
                                Fraud Risk: {String(forensics.fraudRiskLevel)}
                              </span>
                            </div>
                            <h3 className="mt-1.5 text-lg font-extrabold text-slate-900">
                              {String(det.subtypeLabel)}
                            </h3>
                            <div className="text-xs font-semibold text-emerald-800">
                              Marathi: {String(det.nameMr)} · Hindi: {String(det.nameHi)}
                            </div>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-[11px] font-semibold uppercase text-slate-500">
                            Indicative Local Value
                          </div>
                          <div className="text-xl font-extrabold text-emerald-800">
                            {String(range.displayInr)}
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              onSpeak(
                                scripts[lang] ?? scripts.EN ?? "",
                                flags.length > 0 ? "alert" : "verified"
                              )
                            }
                            className="mt-1 inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-800 hover:bg-emerald-100"
                          >
                            <Volume2 className="h-3.5 w-3.5" /> Speak in{" "}
                            {LANGUAGE_META[lang].nativeLabel}
                          </button>
                        </div>
                      </div>

                      {flags.length > 0 && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-rose-300 bg-rose-50 p-3.5 text-xs text-rose-950">
                          <ShieldAlert className="h-5 w-5 shrink-0 text-rose-600" />
                          <div>
                            <div className="font-extrabold">
                              Anti-Fraud / Adulteration Flags Triggered: {flags.join(" · ")}
                            </div>
                            <div className="mt-0.5">
                              Recorded in <code className="font-mono">AIScanRecord</code> &
                              append-only <code className="font-mono">AuditEvent</code>. Physical inspection mandatory.
                            </div>
                          </div>
                        </div>
                      )}

                      {Boolean(det.isRegulatedHazardous) && (
                        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                          <strong>Regulated Stream Safety Rule:</strong>{" "}
                          {String(det.handlingGuidance)}
                        </div>
                      )}

                      {/* Cryptographic & Pixel Forensics Strip + ONNX Neural Heap Breakdown */}
                      <div className="rounded-xl bg-slate-900 p-3.5 font-mono text-[11px] text-emerald-300">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 font-bold text-white">
                            <Fingerprint className="h-4 w-4 text-emerald-400" />
                            64-bit Perceptual dHash: {String(imgInfo.perceptualHash64)}
                          </span>
                          <span>
                            Sharpness: {String(imgInfo.laplacianSharpness)} · Luminance:{" "}
                            {String(imgInfo.meanLuminance)}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-slate-400">
                          SHA-256: {String(imgInfo.imageSha256)}
                        </div>
                        {Boolean(forensics.onnxInference) &&
                          (() => {
                            const onnx = forensics.onnxInference as Record<string, unknown>;
                            const comp = (onnx.heapComposition ?? []) as Array<
                              Record<string, unknown>
                            >;
                            return (
                              <div className="mt-2.5 border-t border-slate-700 pt-2 text-indigo-200">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-bold text-indigo-300">
                                    🧠 ONNX Neural Tensor [9, 10] ({String(onnx.runtimeBackend)}):
                                  </span>
                                  <span>
                                    {Boolean(onnx.multiMaterialHeapDetected)
                                      ? "⚠️ MULTI-MATERIAL MIXED HEAP DETECTED"
                                      : "✓ UNIFORM SINGLE-STREAM HEAP"}
                                  </span>
                                </div>
                                {comp.length > 0 && (
                                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                                    {comp.map((c) => (
                                      <span
                                        key={String(c.materialSlug)}
                                        className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-emerald-200"
                                      >
                                        {String(c.materialSlug)}: {String(c.patchCount)}/9 patches (
                                        {Math.round(Number(c.patchShare) * 100)}%)
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {/* REAL-PHOTO gate: CNN trained on 2,527 genuine photographs */}
                        {Boolean(forensics.realPhotoGate) &&
                          (() => {
                            const gate = forensics.realPhotoGate as Record<string, unknown>;
                            const cands = (gate.topCandidates ?? []) as Array<
                              Record<string, unknown>
                            >;
                            const disagrees = Boolean(forensics.realPhotoGateDisagrees);
                            return (
                              <div className="mt-2.5 border-t border-slate-700 pt-2 text-amber-200">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-bold text-amber-300">
                                    📷 REAL-PHOTO CNN (trained on{" "}
                                    {String(gate.dataset ?? "real photos")} ·{" "}
                                    {Math.round(
                                      Number(gate.heldoutRealPhotoAccuracy ?? 0) * 100
                                    )}
                                    % held-out):
                                  </span>
                                  <span className={disagrees ? "text-rose-300" : "text-emerald-300"}>
                                    {disagrees
                                      ? "⚠️ DISAGREES WITH SPECTRAL VERDICT — review before settling"
                                      : "✓ CORROBORATES SPECTRAL VERDICT"}
                                  </span>
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1.5">
                                  <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-amber-100">
                                    {String(gate.predictedClass)} ·{" "}
                                    {Math.round(Number(gate.confidence ?? 0) * 100)}%
                                  </span>
                                  {cands.slice(1).map((c) => (
                                    <span
                                      key={String(c.className)}
                                      className="rounded bg-slate-800/60 px-2 py-0.5 text-[10px] text-slate-300"
                                    >
                                      {String(c.className)} ·{" "}
                                      {Math.round(Number(c.probability ?? 0) * 100)}%
                                    </span>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}
                      </div>

                      {/* Multi-Tier Live Storefront Payout Ladder */}
                      <div>
                        <div className="mb-1.5 text-xs font-bold text-slate-700">
                          Live Local Buyer Payout Ladder Across Hierarchy Tiers ({tiers.length}{" "}
                          Open Storefronts)
                        </div>
                        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-xs">
                          {tiers.map((t) => (
                            <div
                              key={String(t.storefrontId)}
                              className="flex items-center justify-between px-3.5 py-2"
                            >
                              <div>
                                <span className="font-bold text-slate-900">
                                  {String(t.shopTitle)}
                                </span>{" "}
                                <span className="text-[11px] text-slate-500">
                                  ({String(t.tier)})
                                </span>
                              </div>
                              <div className="font-extrabold text-emerald-800">
                                Gate Payout ₹
                                {(Number(t.estimatedPayoutDropoffPaise) / 100).toFixed(2)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Human-in-the-loop Confirmation Action */}
                      <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs">
                        <span className="text-slate-600">
                          {String(visionResult.honestDisclaimer)}
                        </span>
                        <button
                          type="button"
                          disabled={humanConfirmed}
                          onClick={handleConfirmVisionScan}
                          className={`ml-3 shrink-0 rounded-xl px-3.5 py-2 font-bold ${
                            humanConfirmed
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-emerald-700 text-white hover:bg-emerald-800"
                          }`}
                        >
                          {humanConfirmed ? "✓ Human Confirmed" : "Confirm Estimate"}
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-MODE 2: DIGITAL SCALE 7-SEGMENT PIXEL OCR & ANTI-REPLAY VERIFIER*/}
      {/* =================================================================== */}
      {subMode === "scale" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-100 px-3 py-1 text-xs font-bold text-teal-950">
              <Scale className="h-3.5 w-3.5" /> 7-Segment LED Pixel OCR + Anti-Replay Guard
            </span>
            <h2 className="text-lg font-bold text-slate-900">
              Verify Digital Scale (*Kanta*) Reading & Catch Weight Fraud
            </h2>
            <p className="text-xs text-slate-600">
              Segments red/green LED scale digits directly from image pixels, checks deviation against declared weight, and blocks even JPEG-recompressed duplicate scale photos via 64-bit <code className="font-mono">dHash</code>!
            </p>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="font-semibold text-slate-700">
                  Actual LED Display (kg)
                </label>
                <input
                  value={scaleSimDigits}
                  onChange={(e) => setScaleSimDigits(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm font-bold"
                />
              </div>
              <div>
                <label className="font-semibold text-slate-700">
                  Buyer Entered Weight (kg)
                </label>
                <input
                  type="number"
                  step="0.05"
                  value={declaredWeightKg}
                  onChange={(e) => setDeclaredWeightKg(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {(
                [
                  ["RED", "🔴 Red LED Scale"],
                  ["GREEN", "🟢 Green LED Scale"],
                  ["LCD", "📟 Monochrome Gray LCD (.onnx)"],
                  ["PAPER_SLIP", "🧾 Weighbridge Paper Slip (.onnx)"],
                ] as const
              ).map(([c, label]) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setScaleLedColor(c)}
                  className={`rounded-xl border px-2 py-1.5 font-bold ${
                    scaleLedColor === c
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-slate-50 text-slate-700"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {pendingBuyerOrders.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Optional: Link to Active Buyer Order for Immediate Settlement
                </label>
                <select
                  value={selectedOrderId}
                  onChange={(e) => setSelectedOrderId(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
                >
                  <option value="">— Standalone Scale Verification Check —</option>
                  {pendingBuyerOrders.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.orderNumber} ({o.items[0]?.material.nameEn})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-2 pt-1 text-xs">
              <button
                type="button"
                disabled={scaleLoading}
                onClick={() => runSimulatedScaleScan()}
                className="w-full rounded-xl bg-emerald-700 py-2.5 text-sm font-bold text-white shadow hover:bg-emerald-800"
              >
                {scaleLoading
                  ? "Decoding 7-Segment Pixels..."
                  : "Render Scale Photo & Run Pixel OCR Check"}
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => runSimulatedScaleScan("18.45", "18.45")}
                  className="rounded-xl border border-emerald-300 bg-emerald-50 p-2 font-bold text-emerald-900 hover:bg-emerald-100"
                >
                  ✅ Demo Honest Match (18.45 kg = 18.45 kg)
                </button>
                <button
                  type="button"
                  onClick={() => runSimulatedScaleScan("09.20", "12.50")}
                  className="rounded-xl border border-rose-300 bg-rose-50 p-2 font-bold text-rose-900 hover:bg-rose-100"
                >
                  🚨 Demo Scale Tamper (Scale 09.20 vs 12.50 kg)
                </button>
              </div>

              <button
                type="button"
                onClick={runLossyJpegReplayAttackDemo}
                className="w-full rounded-xl border border-purple-300 bg-purple-50 py-2 font-bold text-purple-950 hover:bg-purple-100"
              >
                🕵️ Demo Lossy-JPEG Recompressed Photo Replay Attack (New SHA-256!)
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7">
            {!scaleResult ? (
              <div className="flex h-full flex-col items-center justify-center py-14 text-center text-slate-500">
                <Scale className="mb-3 h-10 w-10 text-teal-600" />
                <p className="text-sm font-bold text-slate-800">
                  Test Honest Scale Reading, Weight Mismatch, or Lossy-JPEG Photo Replay!
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {scalePreviewUrl && (
                  <img
                    src={scalePreviewUrl}
                    alt="Digital scale capture"
                    className="mx-auto max-h-48 rounded-2xl border border-slate-300 shadow"
                  />
                )}

                <div
                  className={`flex items-center justify-between rounded-2xl border-2 p-4 ${
                    scaleResult.verdictStatus === "VERIFIED_WITHIN_TOLERANCE"
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-rose-500 bg-rose-50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {scaleResult.verdictStatus === "VERIFIED_WITHIN_TOLERANCE" ? (
                      <CheckCircle2 className="h-7 w-7 text-emerald-700" />
                    ) : (
                      <ShieldAlert className="h-7 w-7 text-rose-700" />
                    )}
                    <div>
                      <div className="text-sm font-extrabold text-slate-900">
                        {String(scaleResult.verdictStatus)}{" "}
                        {Boolean(scaleResult.displayMode) && (
                          <span className="ml-1.5 rounded bg-slate-900 px-2 py-0.5 font-mono text-[10px] font-bold text-emerald-300">
                            {String(scaleResult.displayMode)}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-700">
                        Pixel OCR Decoded:{" "}
                        <strong className="font-mono">
                          {scaleResult.scaleReadGrams !== null
                            ? `${(Number(scaleResult.scaleReadGrams) / 1000).toFixed(2)} kg`
                            : "UNREADABLE"}
                        </strong>{" "}
                        vs Declared:{" "}
                        <strong className="font-mono">
                          {(Number(scaleResult.declaredGrams) / 1000).toFixed(2)} kg
                        </strong>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const scripts = scaleResult.vernacularAudioScripts as Record<
                        string,
                        string
                      >;
                      onSpeak(
                        scripts[lang] ?? scripts.EN ?? "",
                        scaleResult.verdictStatus === "VERIFIED_WITHIN_TOLERANCE"
                          ? "verified"
                          : "alert"
                      );
                    }}
                    className="inline-flex items-center gap-1 rounded-xl bg-white px-3 py-2 text-xs font-bold text-slate-900 shadow-sm"
                  >
                    <Volume2 className="h-4 w-4 text-emerald-700" /> Speak Verdict
                  </button>
                </div>

                {Boolean(scaleResult.replayFraudDetected) && (
                  <div className="rounded-xl border border-purple-400 bg-purple-950 p-4 font-mono text-xs text-purple-100">
                    <div className="font-bold text-amber-300">
                      ⚡ PERCEPTUAL dHASH REPLAY ATTACK CAUGHT!
                    </div>
                    <div className="mt-1">
                      Match Type:{" "}
                      {String(
                        (scaleResult.replayCheck as Record<string, unknown>)?.replayType
                      )}{" "}
                      · Hamming Distance:{" "}
                      {String(
                        (scaleResult.replayCheck as Record<string, unknown>)
                          ?.minHammingDistance
                      )}{" "}
                      / 64 bits
                    </div>
                    <div className="mt-1 text-purple-300">
                      Attempting to settle any order with this scan ID is automatically blocked with HTTP 409 SCALE_PHOTO_REPLAY_BLOCKED!
                    </div>
                  </div>
                )}

                {selectedOrderId && (
                  <button
                    type="button"
                    onClick={handleSettleOrderWithScaleScan}
                    className="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white hover:bg-slate-800"
                  >
                    Settle Linked Order Using This Scale Scan Record
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-MODE 3: MULTI-TASK 2D-CNN CAMERA PHOTO DEVICE X-RAY             */}
      {/* =================================================================== */}
      {subMode === "xray" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-100 px-3 py-1 text-xs font-bold text-indigo-950">
                <Cpu className="h-3.5 w-3.5" /> Multi-Head 2D CNN (.onnx) + Live Mandi BOM
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                device_xray_cnn_v2.onnx
              </span>
            </div>

            <h2 className="text-lg font-bold text-slate-900">
              Snap Any Appliance / E-Waste Photo → Instant Internal Component Valuation
            </h2>
            <p className="text-xs text-slate-600">
              Self-hosted 2D CNN runs directly on RGB camera pixels (<code className="font-mono">[1, 3, 64, 64]</code>) to classify appliance type, internal <strong>Copper vs. Aluminium</strong> coil probability, exterior condition, and live local mandi component payouts — zero API cost!
            </p>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={startLiveCamera}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-bold text-white hover:bg-slate-800"
              >
                <Video className="h-4 w-4 text-emerald-400" />
                Live Camera
              </button>
              <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-indigo-600 bg-indigo-50 px-3 py-2.5 text-xs font-bold text-indigo-950 hover:bg-indigo-100">
                <Upload className="h-4 w-4" />
                Upload Appliance Photo
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) submitXrayPhotoBlob(f, f.name);
                  }}
                />
              </label>
            </div>

            <div className="border-t border-slate-100 pt-3">
              <div className="mb-2 text-xs font-bold text-slate-700">
                1-Click Real Camera Frame X-Ray Presets (Binary PNG → 2D CNN):
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  disabled={xrayLoading}
                  onClick={() => runXrayCameraPreset("xray-split-ac-copper")}
                  className="rounded-xl border border-orange-200 bg-orange-50/70 p-2.5 text-left font-semibold hover:border-orange-400"
                >
                  ❄️ Split AC Photo (Copper Condenser)
                </button>
                <button
                  type="button"
                  disabled={xrayLoading}
                  onClick={() => runXrayCameraPreset("xray-split-ac-aluminum")}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 text-left font-semibold hover:border-slate-400"
                >
                  ❄️ Split AC Photo (Aluminium Fin)
                </button>
                <button
                  type="button"
                  disabled={xrayLoading}
                  onClick={() => runXrayCameraPreset("xray-smartphone")}
                  className="rounded-xl border border-blue-200 bg-blue-50/60 p-2.5 text-left font-semibold hover:border-blue-400"
                >
                  📱 5G Smartphone Handset Photo
                </button>
                <button
                  type="button"
                  disabled={xrayLoading}
                  onClick={() => runXrayCameraPreset("xray-laptop")}
                  className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-2.5 text-left font-semibold hover:border-indigo-400"
                >
                  💻 14&quot; Clamshell Laptop Photo
                </button>
                <button
                  type="button"
                  disabled={xrayLoading}
                  onClick={() => runXrayCameraPreset("xray-ceiling-fan")}
                  className="rounded-xl border border-amber-200 bg-amber-50/60 p-2.5 text-left font-semibold hover:border-amber-400"
                >
                  🌀 Ceiling Fan Stator Motor Photo
                </button>
                <button
                  type="button"
                  disabled={xrayLoading}
                  onClick={() => runXrayCameraPreset("xray-washing-machine")}
                  className="rounded-xl border border-cyan-200 bg-cyan-50/60 p-2.5 text-left font-semibold hover:border-cyan-400"
                >
                  🧺 Twin-Tub Washing Machine Photo
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Or Search Model By Text (Fallback / Manual Override)
              </label>
              <input
                value={deviceQuery}
                onChange={(e) => setDeviceQuery(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Physical Condition
              </label>
              <select
                value={deviceCondition}
                onChange={(e) =>
                  setDeviceCondition(e.target.value as typeof deviceCondition)
                }
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="POWERS_ON_INTACT">Powers On · Screen Intact</option>
                <option value="CRACKED_SCREEN_BOOTS">Cracked Glass · Mainboard Boots</option>
                <option value="DEAD_BOOT_INTACT_BODY">Dead Boot · Intact Internal Parts</option>
                <option value="HEAVILY_DAMAGED_SCRAP">Heavily Smashed · Pure Scrap Floor</option>
              </select>
            </div>

            <button
              type="button"
              disabled={xrayLoading}
              onClick={() => runDeviceXray()}
              className="w-full rounded-xl bg-emerald-700 py-2.5 text-sm font-bold text-white hover:bg-emerald-800"
            >
              {xrayLoading ? "Running Multi-Head X-Ray..." : "Run Text Model X-Ray"}
            </button>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7">
            {!xrayResult ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center text-slate-500">
                <Cpu className="mb-3 h-10 w-10 text-emerald-600" />
                <p className="text-sm font-semibold text-slate-800">
                  Click any Camera Photo X-Ray preset on the left or upload your own appliance photo
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start gap-4">
                  {xrayPreviewUrl && (
                    <img
                      src={xrayPreviewUrl}
                      alt="Appliance camera frame"
                      className="h-24 w-24 rounded-xl border border-slate-200 object-cover shadow-sm"
                    />
                  )}
                  <div className="flex-1">
                    <div className="flex flex-wrap gap-1.5 text-[11px] font-bold">
                      <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-indigo-950">
                        {String(xrayResult.inferenceMode ?? "CATALOG")} ·{" "}
                        {Math.round(Number(xrayResult.confidence ?? 0.85) * 100)}% Conf
                      </span>
                      {Boolean((xrayResult.matchedDevice as Record<string, unknown>)?.coilType) && (
                        <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-950">
                          Coil Winding:{" "}
                          {String((xrayResult.matchedDevice as Record<string, unknown>)?.coilType)}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-1.5 text-lg font-bold text-slate-900">
                      {String((xrayResult.matchedDevice as Record<string, unknown>)?.modelName)}
                    </h3>
                  </div>
                </div>

                {Boolean(xrayResult.cnnXrayInference) &&
                  (() => {
                    const cnn = xrayResult.cnnXrayInference as Record<string, unknown>;
                    return (
                      <div className="rounded-xl bg-slate-900 p-3.5 font-mono text-[11px] text-indigo-200">
                        <div className="flex flex-wrap justify-between gap-2 font-bold text-white">
                          <span>🧠 Multi-Task 2D CNN ({String(cnn.modelVersion)})</span>
                          <span>
                            Visual Coil Head: {String(cnn.predictedCoilType)} (
                            {Math.round(Number(cnn.coilConfidence) * 100)}%)
                          </span>
                        </div>
                        <div className="mt-1 text-slate-400 truncate">
                          Weights SHA-256: {String(cnn.modelSha256)}
                        </div>
                      </div>
                    );
                  })()}

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="text-[11px] font-bold uppercase text-slate-500">
                      1. Scrap Floor
                    </div>
                    <div className="mt-1 text-base font-extrabold">
                      {String(
                        (
                          (xrayResult.indicativePathways as Record<string, unknown>)
                            .scrapMaterialFloor as Record<string, unknown>
                        ).displayRangeInr
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border-2 border-emerald-500 bg-emerald-50/70 p-3">
                    <div className="text-[11px] font-bold uppercase text-emerald-800">
                      2. Parts Harvest
                    </div>
                    <div className="mt-1 text-base font-extrabold text-emerald-900">
                      {String(
                        (
                          (xrayResult.indicativePathways as Record<string, unknown>)
                            .partsHarvest as Record<string, unknown>
                        ).displayRangeInr
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-purple-200 bg-purple-50/70 p-3">
                    <div className="text-[11px] font-bold uppercase text-purple-900">
                      3. Repair / Refurbish
                    </div>
                    <div className="mt-1 text-base font-extrabold text-purple-950">
                      {String(
                        (
                          (xrayResult.indicativePathways as Record<string, unknown>)
                            .refurbishRepair as Record<string, unknown>
                        ).displayRangeInr
                      )}
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {(
                    xrayResult.internalComponentsXray as Array<{
                      label: string;
                      grams: number;
                      indicativeValueInr: string;
                      liveMandiDisplayInr?: string;
                    }>
                  ).map((c, i) => (
                    <div key={i} className="flex justify-between px-3.5 py-2.5 text-xs">
                      <span>
                        <strong>{c.label}</strong> ({c.grams} g)
                      </span>
                      <span className="font-bold text-emerald-800">
                        ₹{c.indicativeValueInr}
                        {c.liveMandiDisplayInr ? ` (Live Mandi: ${c.liveMandiDisplayInr})` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-MODE 4: MULTILINGUAL NEURAL VOICE & CHAT KABADI ASSISTANT       */}
      {/* =================================================================== */}
      {subMode === "assistant" && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-950">
                <MessageSquare className="h-3.5 w-3.5" /> Self-Hosted Neural NLU (HI/PA/MR/EN)
              </span>
              <span className="font-mono text-[11px] text-slate-400">
                vernacular_intent_nlu_v2.onnx
              </span>
            </div>
            <h2 className="text-lg font-bold text-slate-900">
              Speak or Ask Naturally in Hindi, Punjabi, Marathi, Hinglish or English
            </h2>
            <textarea
              rows={3}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              className="w-full rounded-xl border border-slate-300 p-3 text-sm"
              placeholder="Ask about scrap rates, AC/phone valuation, mandi forecast, best buyer, or safety..."
            />

            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                disabled={chatLoading}
                onClick={() => runAssistantQuery(undefined, false)}
                className="rounded-xl bg-emerald-700 py-2.5 font-bold text-white hover:bg-emerald-800"
              >
                {chatLoading ? "Running ONNX NLU..." : "Ask AI Assistant"}
              </button>
              <button
                type="button"
                onClick={startVoiceMicInput}
                className={`inline-flex items-center justify-center gap-1.5 rounded-xl border py-2.5 font-bold ${
                  listeningMic
                    ? "border-rose-500 bg-rose-600 text-white"
                    : "border-slate-300 bg-slate-900 text-white hover:bg-slate-800"
                }`}
              >
                <Mic className="h-4 w-4 text-emerald-400" />
                {listeningMic ? "Listening..." : `Speak (${lang})`}
              </button>
            </div>

            <div className="space-y-1.5 border-t border-slate-100 pt-3 text-xs">
              <div className="font-bold text-slate-700">1-Click Multilingual Prompts:</div>
              {[
                "Mere paas 2 purane AC aur 15 kg tamba hai Ludhiana mein kitna milega?",
                "ਮੇਰੇ ਕੋਲ 20 ਕਿਲੋ ਤਾਂਬਾ ਅਤੇ 50 ਕਿਲੋ ਲੋਹਾ ਹੈ ਅੱਜ ਕੀ ਭਾਅ ਮਿਲੇਗਾ?",
                "माझ्याकडे १० किलो तांबे आणि २५ किलो रद्दी पुठ्ठा आहे किती पैसे मिळतील?",
                "Aaj copper bechun ya agle hafte ruku mandi rate badhega kya?",
                "Mera 120 kg copper stock kis dukandar ya recycler ko bechun sabse zyada paisa kaun dega?",
              ].map((sample) => (
                <button
                  key={sample}
                  type="button"
                  onClick={() => runAssistantQuery(sample, false)}
                  className="block w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-800 hover:border-emerald-400 hover:bg-emerald-50"
                >
                  “{sample}”
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-7">
            {!chatResult ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center text-slate-500">
                <MessageSquare className="mb-3 h-10 w-10 text-emerald-600" />
                <p className="text-sm font-bold text-slate-800">
                  Ask in Hinglish, हिन्दी, ਪੰਜਾਬੀ, मराठी, or English — zero external LLM API required!
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border-2 border-emerald-500 bg-emerald-50/80 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-emerald-900">
                    <span>
                      🧠 Intent: {String(chatResult.intent)} (
                      {Math.round(Number(chatResult.intentConfidence) * 100)}%) · Script:{" "}
                      {String(chatResult.detectedLanguage)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onSpeak(String(chatResult.replyText), "verified")}
                      className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold shadow-sm"
                    >
                      <Volume2 className="h-3.5 w-3.5 text-emerald-700" /> Replay Voice
                    </button>
                  </div>
                  <p className="mt-2 text-sm font-bold leading-relaxed text-slate-900">
                    {String(chatResult.replyText)}
                  </p>
                </div>

                {(() => {
                  const val = (chatResult.liveValuation ?? {}) as Record<string, unknown>;
                  const topBuyer = val.topBuyerMatch as Record<string, unknown> | null;
                  return (
                    <div className="grid gap-3 sm:grid-cols-2 text-xs">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                        <div className="font-bold uppercase text-slate-500">
                          Estimated Lot Value
                        </div>
                        <div className="mt-1 text-lg font-extrabold text-emerald-800">
                          {String(val.combinedDisplayInr ?? "-")}
                        </div>
                      </div>
                      {topBuyer && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5">
                          <div className="font-bold uppercase text-slate-500">
                            Top Matched Verified Buyer
                          </div>
                          <div className="mt-1 font-extrabold text-slate-900">
                            {String(topBuyer.shopTitle)} ({String(topBuyer.tier)})
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {hasUser && (
                  <button
                    type="button"
                    disabled={chatLoading}
                    onClick={() => runAssistantQuery(chatInput, true)}
                    className="w-full rounded-xl bg-slate-900 py-2.5 text-xs font-bold text-white hover:bg-slate-800"
                  >
                    🚀 Create Live Broadcast Pickup Listing Directly From This AI Valuation
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* SUB-MODE 5: NEURAL MANDI FORECASTER & SMART UPWARD BUYER MATCHER    */}
      {/* =================================================================== */}
      {subMode === "mandi" && (
        <div className="space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-950">
                  <TrendingUp className="h-3.5 w-3.5" /> mandi_price_forecaster_v2.onnx + Smart Tier Matcher
                </span>
                <h2 className="mt-1.5 text-lg font-bold text-slate-900">
                  7-Day & 14-Day Mandi Rate Forecast + Multi-Tier Smart Buyer Matching
                </h2>
              </div>

              <div className="flex flex-wrap items-end gap-2 text-xs">
                <div>
                  <label className="block font-bold text-slate-600">Material</label>
                  <select
                    value={matchSlug}
                    onChange={(e) => setMatchSlug(e.target.value)}
                    className="mt-1 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold"
                  >
                    <option value="metal-copper-bright">Clean Copper Wire (Tamba)</option>
                    <option value="ewaste-pcb-grade-a">Grade-A Telecom PCBs</option>
                    <option value="metal-aluminium-utensil">Clean Aluminium Coil</option>
                    <option value="metal-heavy-iron">Heavy Iron & Steel (Loha)</option>
                    <option value="paper-cardboard">Corrugated Cardboard (Gatta)</option>
                    <option value="battery-inverter-lead">Lead-Acid / UPS Battery</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-600">Lot Weight (kg)</label>
                  <input
                    type="number"
                    value={matchKg}
                    onChange={(e) => setMatchKg(e.target.value)}
                    className="mt-1 w-24 rounded-xl border border-slate-300 px-3 py-2 font-mono text-xs font-bold"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-600">City</label>
                  <input
                    value={intelCity}
                    onChange={(e) => setIntelCity(e.target.value)}
                    className="mt-1 w-28 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold"
                  />
                </div>
                <button
                  type="button"
                  disabled={intelLoading}
                  onClick={loadMandiAndSmartMatch}
                  className="rounded-xl bg-emerald-700 px-4 py-2 font-bold text-white hover:bg-emerald-800"
                >
                  {intelLoading ? "Running ONNX..." : "Forecast & Match"}
                </button>
              </div>
            </div>

            {Boolean(marketIntel?.forecasts) && (
              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {((marketIntel!.forecasts ?? []) as Array<Record<string, unknown>>).map(
                  (f) => (
                    <div
                      key={String(f.materialSlug)}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <strong className="text-slate-900">{String(f.nameEn)}</strong>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            f.tradingAction === "HOLD_STOCK_FOR_UPSIDE"
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-amber-100 text-amber-900"
                          }`}
                        >
                          {String(f.tradingAction).replace(/_/g, " ")}
                        </span>
                      </div>
                      <div className="mt-2 flex justify-between font-mono">
                        <span>Now: {String(f.currentAvgRateInr)}</span>
                        <span className="font-bold text-emerald-800">
                          7d: {String(f.predicted7dRateInr)} (
                          {Number(f.predicted7dDeltaPct) >= 0 ? "+" : ""}
                          {String(f.predicted7dDeltaPct)}%)
                        </span>
                      </div>
                      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                        <span>Tier Spread: {String(f.tierSpreadInr)}</span>
                        <span>14d: {String(f.predicted14dRateInr)}</span>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}

            {Boolean(smartMatchResult?.rankedBuyers) && (
              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between text-xs font-bold text-slate-800">
                  <span>
                    Smart Multi-Tier Buyer Ranking ({matchKg} kg) — Extra Margin vs Street:{" "}
                    <span className="text-emerald-700">
                      +{String(smartMatchResult!.extraGainVsStreetCollectorInr)}
                    </span>
                  </span>
                </div>
                <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-xs">
                  {(
                    (smartMatchResult!.rankedBuyers ?? []) as Array<
                      Record<string, unknown>
                    >
                  ).map((b) => (
                    <div
                      key={String(b.storefrontId)}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                    >
                      <div>
                        <span className="font-bold text-slate-900">
                          {String(b.shopTitle)}
                        </span>{" "}
                        <span className="text-slate-500">
                          ({String(b.tier)} · {String(b.verificationLevel)})
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px]">
                          Match Score {String(b.matchScore)}/100
                        </span>
                        <span className="text-sm font-extrabold text-emerald-800">
                          {String(b.estimatedTotalPayoutInr)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
