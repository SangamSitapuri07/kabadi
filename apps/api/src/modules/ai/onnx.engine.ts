import fs from "fs";
import path from "path";
import * as ort from "onnxruntime-web";
import { WORKSPACE_ROOT } from "../../lib/paths";
import { sha256Hex } from "../../lib/security";

ort.env.wasm.numThreads = 1;

export const SCRAP_ONNX_CLASSES = [
  "metal-copper-bright",
  "ewaste-pcb-grade-a",
  "battery-inverter-lead",
  "paper-cardboard",
  "metal-aluminium-utensil",
  "metal-heavy-iron",
] as const;

export const SCRAP_CNN_V2_CLASSES = [
  "metal-copper-bright",
  "metal-copper-burnt",
  "metal-aluminium-utensil",
  "ewaste-pcb-grade-a",
  "battery-inverter-lead",
  "paper-cardboard",
] as const;

export const DEVICE_XRAY_V2_CLASSES = [
  "split-ac-15ton-copper",
  "split-ac-15ton-aluminum",
  "smartphone-midrange-android",
  "laptop-business-14",
  "ceiling-fan-copper-motor",
  "washing-machine-twin-tub",
] as const;

export const DEVICE_COIL_V2_CLASSES = ["COPPER", "ALUMINUM"] as const;

export const DEVICE_CONDITION_V2_CLASSES = [
  "POWERS_ON_INTACT",
  "CRACKED_SCREEN_BOOTS",
  "DEAD_BOOT_INTACT_BODY",
  "HEAVILY_DAMAGED_SCRAP",
] as const;

export const VERNACULAR_INTENT_V2_CLASSES = [
  "VALUATE_AND_RATES",
  "PRICE_FORECAST_TIMING",
  "SMART_BUYER_MATCH",
  "BOOK_PICKUP_LISTING",
  "SCALE_DISPUTE_FRAUD_HELP",
  "SAFETY_HAZARD_COMPLIANCE",
] as const;

/** Trained on 2,527 REAL photographs (TrashNet, MIT) — not synthetic renders. */
export const REAL_TRASHNET_V1_CLASSES = [
  "cardboard",
  "glass",
  "metal",
  "paper",
  "plastic",
  "trash",
] as const;

export type RealTrashnetClass = (typeof REAL_TRASHNET_V1_CLASSES)[number];

/** Maps a real-photo coarse stream to a Kabadiwala catalogue material slug where 1:1. */
export const REAL_TRASHNET_TO_MATERIAL_SLUG: Record<RealTrashnetClass, string | null> = {
  cardboard: "paper-cardboard",
  glass: null,
  metal: null,
  paper: "paper-newspaper",
  plastic: "plastic-pet-clear",
  trash: null,
};

export type VernacularAiIntent = (typeof VERNACULAR_INTENT_V2_CLASSES)[number];

export interface OnnxHeapCompositionEntry {
  materialSlug: string;
  patchCount: number;
  patchSharePct: number;
  meanConfidence: number;
}

export interface OnnxCnnCropSummary {
  modelVersion: string;
  modelSha256: string;
  dominantCnnClass: string;
  cnnConfidence: number;
  quadrantPredictions: Array<{
    region: "FULL_FRAME" | "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT";
    predictedClass: string;
    confidence: number;
  }>;
}

export interface OnnxScrapHeapPrediction {
  modelVersion: string;
  modelSha256: string;
  runtimeBackend: "onnxruntime-wasm-cpu";
  dominantMaterialSlug: string;
  onnxConfidence: number;
  multiMaterialHeapDetected: boolean;
  heapComposition: OnnxHeapCompositionEntry[];
  cnn2dInference?: OnnxCnnCropSummary;
}

export interface OnnxScaleDigitPrediction {
  digit: string;
  confidence: number;
}

export interface OnnxDeviceXrayPrediction {
  modelVersion: string;
  modelSha256: string;
  runtimeBackend: "onnxruntime-wasm-cpu";
  predictedBomSlug: (typeof DEVICE_XRAY_V2_CLASSES)[number];
  deviceConfidence: number;
  topCandidates: Array<{ slug: string; probability: number }>;
  predictedCoilType: "COPPER" | "ALUMINUM";
  coilConfidence: number;
  predictedVisualCondition: (typeof DEVICE_CONDITION_V2_CLASSES)[number];
  conditionConfidence: number;
}

const MODELS_DIR = path.join(WORKSPACE_ROOT, "apps", "api", "models");
const SCRAP_MODEL_PATH = path.join(MODELS_DIR, "scrap_material_classifier_v1.onnx");
const OCR_MODEL_PATH = path.join(MODELS_DIR, "lcd_scale_ocr_v1.onnx");
const SCRAP_CNN_V2_PATH = path.join(MODELS_DIR, "scrap_vision_cnn_v2.onnx");
const DEVICE_XRAY_CNN_V2_PATH = path.join(MODELS_DIR, "device_xray_cnn_v2.onnx");
const SCALE_CNN_V2_PATH = path.join(MODELS_DIR, "scale_crnn_ocr_v2.onnx");
const VERNACULAR_NLU_V2_PATH = path.join(MODELS_DIR, "vernacular_intent_nlu_v2.onnx");
const MANDI_FORECAST_V2_PATH = path.join(MODELS_DIR, "mandi_price_forecaster_v2.onnx");
const REAL_TRASHNET_PATH = path.join(MODELS_DIR, "real_trashnet_cnn_v1.onnx");

interface LoadedSession {
  session: ort.InferenceSession;
  sha256: string;
}

const sessionCache = new Map<string, Promise<LoadedSession>>();

function loadCachedSession(filePath: string): Promise<LoadedSession> {
  let cached = sessionCache.get(filePath);
  if (!cached) {
    cached = (async () => {
      const buf = fs.readFileSync(filePath);
      const session = await ort.InferenceSession.create(buf);
      return { session, sha256: sha256Hex(buf) };
    })();
    sessionCache.set(filePath, cached);
  }
  return cached;
}

export function getOnnxEngineHealth() {
  const v2Files = {
    scrapVisionCnn: "scrap_vision_cnn_v2.onnx",
    deviceXrayCnn: "device_xray_cnn_v2.onnx",
    scaleCrnnOcr: "scale_crnn_ocr_v2.onnx",
    vernacularIntentNlu: "vernacular_intent_nlu_v2.onnx",
    mandiPriceForecaster: "mandi_price_forecaster_v2.onnx",
  };
  const allPresent =
    fs.existsSync(SCRAP_MODEL_PATH) &&
    fs.existsSync(OCR_MODEL_PATH) &&
    fs.existsSync(SCRAP_CNN_V2_PATH) &&
    fs.existsSync(DEVICE_XRAY_CNN_V2_PATH) &&
    fs.existsSync(SCALE_CNN_V2_PATH) &&
    fs.existsSync(VERNACULAR_NLU_V2_PATH) &&
    fs.existsSync(MANDI_FORECAST_V2_PATH) &&
    fs.existsSync(REAL_TRASHNET_PATH);

  return {
    modelsPresentOnDisk: allPresent,
    scrapClassifierFile: "scrap_material_classifier_v1.onnx",
    scaleOcrFile: "lcd_scale_ocr_v1.onnx",
    v2SelfHostedSuite: v2Files,
    realDataModels: {
      realTrashnetCnn: {
        file: "real_trashnet_cnn_v1.onnx",
        trainedOn: "REAL_PHOTOS",
        dataset: "TrashNet (MIT) — 2,527 real photographs",
        classes: [...REAL_TRASHNET_V1_CLASSES],
      },
    },
  };
}

/**
 * Runs 2D CNN `scrap_vision_cnn_v2.onnx` across 5 `[3, 64, 64]` spatial crops
 * (`FULL_FRAME` + 4 quadrants) in a single batched `[5, 3, 64, 64]` WASM forward pass.
 */
export async function runScrapVisionCnnV2Inference(
  cropsChw64: Float32Array[]
): Promise<OnnxCnnCropSummary> {
  const { session, sha256 } = await loadCachedSession(SCRAP_CNN_V2_PATH);
  const regionNames: Array<
    "FULL_FRAME" | "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT"
  > = ["FULL_FRAME", "TOP_LEFT", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_RIGHT"];

  const batch = cropsChw64.length;
  const planeElems = 3 * 64 * 64;
  const flat = new Float32Array(batch * planeElems);
  for (let b = 0; b < batch; b++) {
    flat.set(cropsChw64[b]!, b * planeElems);
  }

  const tensor = new ort.Tensor("float32", flat, [batch, 3, 64, 64]);
  const outputs = await session.run({ input_rgb: tensor });
  const probs = outputs.probabilities!.data as Float32Array;
  const nCls = SCRAP_CNN_V2_CLASSES.length;

  const quadrantPredictions: OnnxCnnCropSummary["quadrantPredictions"] = [];
  for (let b = 0; b < batch; b++) {
    let bestIdx = 0;
    let bestProb = -1;
    for (let k = 0; k < nCls; k++) {
      const p = probs[b * nCls + k]!;
      if (p > bestProb) {
        bestProb = p;
        bestIdx = k;
      }
    }
    quadrantPredictions.push({
      region: regionNames[b] ?? "FULL_FRAME",
      predictedClass: SCRAP_CNN_V2_CLASSES[bestIdx]!,
      confidence: Number(bestProb.toFixed(4)),
    });
  }

  const full = quadrantPredictions[0]!;
  return {
    modelVersion: "kc-scrap-cnn2d-v2.0.0",
    modelSha256: sha256,
    dominantCnnClass: full.predictedClass,
    cnnConfidence: full.confidence,
    quadrantPredictions,
  };
}

/**
 * Multi-Task 2D CNN Camera Photo Device X-Ray (`device_xray_cnn_v2.onnx`):
 * Simultaneously predicts appliance class, internal Copper vs Aluminum coil probability,
 * and exterior physical condition from a single `[1, 3, 64, 64]` RGB tensor.
 */
export async function runDeviceXrayCnnV2Inference(
  imageChw64: Float32Array
): Promise<OnnxDeviceXrayPrediction> {
  const { session, sha256 } = await loadCachedSession(DEVICE_XRAY_CNN_V2_PATH);
  const tensor = new ort.Tensor("float32", imageChw64, [1, 3, 64, 64]);
  const outputs = await session.run({ input_rgb: tensor });

  const devProbs = outputs.device_probs!.data as Float32Array;
  const coilProbs = outputs.coil_probs!.data as Float32Array;
  const condProbs = outputs.condition_probs!.data as Float32Array;

  const candidates = DEVICE_XRAY_V2_CLASSES.map((slug, idx) => ({
    slug,
    probability: Number((devProbs[idx] ?? 0).toFixed(4)),
  })).sort((a, b) => b.probability - a.probability);

  const topDev = candidates[0]!;
  const coilIdx = (coilProbs[0] ?? 0) >= (coilProbs[1] ?? 0) ? 0 : 1;

  let bestCondIdx = 0;
  let bestCondProb = -1;
  for (let i = 0; i < DEVICE_CONDITION_V2_CLASSES.length; i++) {
    const p = condProbs[i] ?? 0;
    if (p > bestCondProb) {
      bestCondProb = p;
      bestCondIdx = i;
    }
  }

  return {
    modelVersion: "kc-device-xray-cnn2d-v2.0.0",
    modelSha256: sha256,
    runtimeBackend: "onnxruntime-wasm-cpu",
    predictedBomSlug: topDev.slug,
    deviceConfidence: topDev.probability,
    topCandidates: candidates.slice(0, 3),
    predictedCoilType: DEVICE_COIL_V2_CLASSES[coilIdx]!,
    coilConfidence: Number((coilProbs[coilIdx] ?? 0.5).toFixed(4)),
    predictedVisualCondition: DEVICE_CONDITION_V2_CLASSES[bestCondIdx]!,
    conditionConfidence: Number(bestCondProb.toFixed(4)),
  };
}

/**
 * Runs 2D CNN `scale_crnn_ocr_v2.onnx` on tight `[N, 1, 32, 20]` normalized digit crops.
 */
export async function runScaleCnnV2GlyphInference(
  glyphTensors32x20: Float32Array[]
): Promise<{
  predictions: OnnxScaleDigitPrediction[];
  modelSha256: string;
}> {
  const { session, sha256 } = await loadCachedSession(SCALE_CNN_V2_PATH);
  if (glyphTensors32x20.length === 0) {
    return { predictions: [], modelSha256: sha256 };
  }
  const n = glyphTensors32x20.length;
  const flat = new Float32Array(n * 32 * 20);
  for (let i = 0; i < n; i++) {
    flat.set(glyphTensors32x20[i]!, i * 640);
  }
  const tensor = new ort.Tensor("float32", flat, [n, 1, 32, 20]);
  const outputs = await session.run({ glyph_gray: tensor });
  const probs = outputs.digit_probs!.data as Float32Array;

  const predictions: OnnxScaleDigitPrediction[] = [];
  for (let b = 0; b < n; b++) {
    let bestDigit = 0;
    let bestProb = -1;
    for (let d = 0; d < 10; d++) {
      const p = probs[b * 10 + d]!;
      if (p > bestProb) {
        bestProb = p;
        bestDigit = d;
      }
    }
    predictions.push({
      digit: String(bestDigit),
      confidence: Number(bestProb.toFixed(4)),
    });
  }
  return { predictions, modelSha256: sha256 };
}

/**
 * Bit-for-bit IEEE-754 match with Python `vectorize_multilingual_text_512` in `ml/train_all.py`.
 */
export function fnv1aU32(str: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(str, "utf8")) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function vectorizeMultilingualText512(text: string): Float32Array {
  const vec = new Float32Array(512);
  const cleaned = text.toLowerCase().trim().replace(/\s+/g, " ");
  const tokens = cleaned.split(" ").filter((t) => t.length > 0);

  for (const tok of tokens) {
    const h = fnv1aU32(`w:${tok}`);
    vec[h % 512]! += ((h >>> 16) & 1) === 0 ? 1.0 : -1.0;
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const h = fnv1aU32(`b:${tokens[i]}_${tokens[i + 1]}`);
    vec[h % 512]! += ((h >>> 16) & 1) === 0 ? 1.0 : -1.0;
  }
  const padded = `<${cleaned}>`;
  const chars = Array.from(padded);
  for (const n of [3, 4]) {
    for (let i = 0; i + n <= chars.length; i++) {
      const gram = chars.slice(i, i + n).join("");
      const h = fnv1aU32(gram);
      vec[h % 512]! += ((h >>> 16) & 1) === 0 ? 0.5 : -0.5;
    }
  }

  let sq = 0;
  for (let i = 0; i < 512; i++) sq += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sq);
  if (norm > 1e-6) {
    for (let i = 0; i < 512; i++) vec[i]! /= norm;
  }
  return vec;
}

export async function runVernacularIntentOnnxInference(utterance: string): Promise<{
  intent: VernacularAiIntent;
  confidence: number;
  allScores: Record<VernacularAiIntent, number>;
  modelVersion: string;
  modelSha256: string;
}> {
  const { session, sha256 } = await loadCachedSession(VERNACULAR_NLU_V2_PATH);
  const vec = vectorizeMultilingualText512(utterance);
  const tensor = new ort.Tensor("float32", vec, [1, 512]);
  const outputs = await session.run({ text_features: tensor });
  const probs = outputs.intent_probs!.data as Float32Array;

  let bestIdx = 0;
  let bestP = -1;
  const scores = {} as Record<VernacularAiIntent, number>;
  for (let i = 0; i < VERNACULAR_INTENT_V2_CLASSES.length; i++) {
    const cls = VERNACULAR_INTENT_V2_CLASSES[i]!;
    const p = Number((probs[i] ?? 0).toFixed(4));
    scores[cls] = p;
    if (p > bestP) {
      bestP = p;
      bestIdx = i;
    }
  }

  return {
    intent: VERNACULAR_INTENT_V2_CLASSES[bestIdx]!,
    confidence: bestP,
    allScores: scores,
    modelVersion: "kc-vernacular-nlu-v2.0.0",
    modelSha256: sha256,
  };
}

export async function runMandiForecasterOnnxInference(
  seriesBatch8d: Float32Array[]
): Promise<{
  forecasts: Array<{
    predicted7dDeltaPct: number;
    predicted14dDeltaPct: number;
    confidence: number;
  }>;
  modelVersion: string;
  modelSha256: string;
}> {
  const { session, sha256 } = await loadCachedSession(MANDI_FORECAST_V2_PATH);
  const n = seriesBatch8d.length;
  if (n === 0) {
    return {
      forecasts: [],
      modelVersion: "kc-mandi-forecaster-v2.0.0",
      modelSha256: sha256,
    };
  }
  const flat = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) flat.set(seriesBatch8d[i]!, i * 8);
  const tensor = new ort.Tensor("float32", flat, [n, 8]);
  const outputs = await session.run({ series_features: tensor });
  const raw = outputs.forecast_out!.data as Float32Array;

  const forecasts = [];
  for (let i = 0; i < n; i++) {
    forecasts.push({
      predicted7dDeltaPct: Number((raw[i * 3] ?? 0).toFixed(2)),
      predicted14dDeltaPct: Number((raw[i * 3 + 1] ?? 0).toFixed(2)),
      confidence: Number(
        Math.min(0.98, Math.max(0.5, raw[i * 3 + 2] ?? 0.82)).toFixed(4)
      ),
    });
  }
  return {
    forecasts,
    modelVersion: "kc-mandi-forecaster-v2.0.0",
    modelSha256: sha256,
  };
}

export interface RealPhotoGatePrediction {
  trainedOn: "REAL_PHOTOS";
  dataset: string;
  heldoutRealPhotoAccuracy: number;
  modelVersion: string;
  modelSha256: string;
  predictedClass: RealTrashnetClass;
  confidence: number;
  mappedMaterialSlug: string | null;
  topCandidates: Array<{ className: string; probability: number }>;
}

/** Real-photo benchmark exported by `ml/train_real.py` (honest held-out accuracy). */
export function getRealDataBenchmark(): {
  heldoutAccuracy: number;
  heldoutRealPhotos: number;
  trainRealPhotos: number;
} {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(MODELS_DIR, "real_data_benchmark.json"), "utf8")
    ) as Record<string, unknown>;
    return {
      heldoutAccuracy: Number(raw.heldoutAccuracy ?? 0),
      heldoutRealPhotos: Number(raw.heldoutRealPhotos ?? 0),
      trainRealPhotos: Number(raw.trainPhotos ?? 0),
    };
  } catch {
    return { heldoutAccuracy: 0, heldoutRealPhotos: 0, trainRealPhotos: 0 };
  }
}

/**
 * Runs `real_trashnet_cnn_v1.onnx` — trained on 2,527 REAL photographs (TrashNet, MIT) —
 * over a `[1, 3, 64, 64]` RGB frame. Used as an independent real-photo sanity gate
 * that corroborates (or disputes) the synthetic-trained spectral verdict.
 */
export async function runRealDataTrashnetInference(
  imageChw64: Float32Array
): Promise<RealPhotoGatePrediction> {
  const { session, sha256 } = await loadCachedSession(REAL_TRASHNET_PATH);
  const tensor = new ort.Tensor("float32", imageChw64, [1, 3, 64, 64]);
  const outputs = await session.run({ input_rgb: tensor });
  const probs = outputs.probabilities!.data as Float32Array;

  const candidates = REAL_TRASHNET_V1_CLASSES.map((className, idx) => ({
    className,
    probability: Number((probs[idx] ?? 0).toFixed(4)),
  })).sort((a, b) => b.probability - a.probability);

  const top = candidates[0]!;
  const bench = getRealDataBenchmark();
  return {
    trainedOn: "REAL_PHOTOS",
    dataset: "TrashNet (MIT) — 2,527 real photographs",
    heldoutRealPhotoAccuracy: Number(bench.heldoutAccuracy.toFixed(4)),
    modelVersion: "kc-real-trashnet-cnn-v1.0.0",
    modelSha256: sha256,
    predictedClass: top.className as RealTrashnetClass,
    confidence: top.probability,
    mappedMaterialSlug: REAL_TRASHNET_TO_MATERIAL_SLUG[top.className as RealTrashnetClass] ?? null,
    topCandidates: candidates.slice(0, 3),
  };
}

/**
 * Runs a batched `[N, 8]` forward pass through `scrap_material_classifier_v1.onnx` across
 * all `3x3 = 9` spatial patches of a camera frame to classify messy multi-material scrap heaps.
 */
export async function runScrapHeapOnnxInference(
  patches8d: Float32Array[],
  cnnCrops64?: Float32Array[]
): Promise<OnnxScrapHeapPrediction> {
  const { session, sha256 } = await loadCachedSession(SCRAP_MODEL_PATH);
  const batchSize = patches8d.length;
  const flat = new Float32Array(batchSize * 8);
  for (let b = 0; b < batchSize; b++) {
    flat.set(patches8d[b]!, b * 8);
  }

  const tensor = new ort.Tensor("float32", flat, [batchSize, 8]);
  const outputs = await session.run({ input: tensor });
  const probs = outputs.probs!.data as Float32Array;
  const numClasses = SCRAP_ONNX_CLASSES.length;

  const classPatchCounts = new Array<number>(numClasses).fill(0);
  const classProbSums = new Array<number>(numClasses).fill(0);

  for (let b = 0; b < batchSize; b++) {
    let bestK = 0;
    let bestP = -1;
    for (let k = 0; k < numClasses; k++) {
      const p = probs[b * numClasses + k]!;
      classProbSums[k] = classProbSums[k]! + p;
      if (p > bestP) {
        bestP = p;
        bestK = k;
      }
    }
    classPatchCounts[bestK] = classPatchCounts[bestK]! + 1;
  }

  const heapComposition: OnnxHeapCompositionEntry[] = [];
  for (let k = 0; k < numClasses; k++) {
    const count = classPatchCounts[k]!;
    if (count > 0) {
      heapComposition.push({
        materialSlug: SCRAP_ONNX_CLASSES[k]!,
        patchCount: count,
        patchSharePct: Number(((count / batchSize) * 100).toFixed(1)),
        meanConfidence: Number((classProbSums[k]! / batchSize).toFixed(4)),
      });
    }
  }
  heapComposition.sort(
    (a, b) => b.patchCount - a.patchCount || b.meanConfidence - a.meanConfidence
  );

  const significantStreams = heapComposition.filter((c) => c.patchCount >= 2);
  const multiMaterialHeapDetected = significantStreams.length >= 2;

  const top = heapComposition[0] ?? {
    materialSlug: "metal-heavy-iron",
    meanConfidence: 0.5,
  };

  const cnn2dInference = cnnCrops64
    ? await runScrapVisionCnnV2Inference(cnnCrops64)
    : undefined;

  return {
    modelVersion: "kc-onnx-scrapnet-v2.0-hybrid-cnn",
    modelSha256: sha256,
    runtimeBackend: "onnxruntime-wasm-cpu",
    dominantMaterialSlug: top.materialSlug,
    onnxConfidence: top.meanConfidence,
    multiMaterialHeapDetected,
    heapComposition,
    cnn2dInference,
  };
}

/**
 * Runs a batched `[N, 42]` forward pass through `lcd_scale_ocr_v1.onnx` to recognize
 * non-illuminated reflective LCD & dark-ink printed weighbridge scale numerals.
 */
export async function runScaleGlyphOnnxInference(
  glyphFeatures42: Float32Array[]
): Promise<{
  predictions: OnnxScaleDigitPrediction[];
  modelSha256: string;
}> {
  const { session, sha256 } = await loadCachedSession(OCR_MODEL_PATH);
  if (glyphFeatures42.length === 0) {
    return { predictions: [], modelSha256: sha256 };
  }

  const batchSize = glyphFeatures42.length;
  const flat = new Float32Array(batchSize * 42);
  for (let b = 0; b < batchSize; b++) {
    flat.set(glyphFeatures42[b]!, b * 42);
  }

  const tensor = new ort.Tensor("float32", flat, [batchSize, 42]);
  const inName = session.inputNames[0] ?? "input";
  const outName = session.outputNames[0] ?? "probs";
  const outputs = await session.run({ [inName]: tensor });
  const probs = outputs[outName]!.data as Float32Array;

  const predictions: OnnxScaleDigitPrediction[] = [];
  for (let b = 0; b < batchSize; b++) {
    let bestDigit = 0;
    let bestProb = -1;
    for (let d = 0; d < 10; d++) {
      const p = probs[b * 10 + d]!;
      if (p > bestProb) {
        bestProb = p;
        bestDigit = d;
      }
    }
    predictions.push({
      digit: String(bestDigit),
      confidence: Number(bestProb.toFixed(4)),
    });
  }

  return { predictions, modelSha256: sha256 };
}
