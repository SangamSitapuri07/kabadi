import sharp from "sharp";
import { sha256Hex } from "../../lib/security";
import {
  OnnxScrapHeapPrediction,
  RealPhotoGatePrediction,
  runRealDataTrashnetInference,
  runScaleGlyphOnnxInference,
  runScrapHeapOnnxInference,
} from "./onnx.engine";

export const VISION_MODEL_VERSION = "kc-hybrid-onnx-forensics-v3.0.0";
export const SCALE_OCR_MODEL_VERSION = "kc-hybrid-onnx-lcd-ocr-v3.0.0";

export interface ImageQualityForensics {
  width: number;
  height: number;
  format: string;
  fileSizeBytes: number;
  imageSha256: string;
  perceptualHash64: string;
  meanLuminance: number;
  laplacianSharpness: number;
  qualityWarnings: string[];
}

export interface PixelMaterialClassification {
  materialSlug: string;
  materialSubtypeLabel: string;
  confidence: number;
  uncertaintyReason: string | null;
  coilMetalVerdict:
    | "COPPER_VERIFIED_SIGNATURE"
    | "ALUMINUM_SILVERY_SIGNATURE"
    | "NOT_APPLICABLE";
  adulterationFlags: string[];
  spectralMetrics: {
    warmCopperPixelPct: number;
    pcbGreenPixelPct: number;
    goldFingerPixelPct: number;
    cobaltBluePixelPct: number;
    kraftCardboardPixelPct: number;
    silveryNeutralPixelPct: number;
    darkCharSootPixelPct: number;
    meanSaturation: number;
  };
  onnxInference: OnnxScrapHeapPrediction;
  /** Independent CNN trained on 2,527 REAL photographs — corroborates/disputes the spectral verdict. */
  realPhotoGate: RealPhotoGatePrediction;
  /** True when the real-photo gate strongly contradicts the spectral verdict (human review advised). */
  realPhotoGateDisagrees: boolean;
}

export interface ScaleOcrPixelResult {
  readable: boolean;
  displayMode: "RED_LED" | "GREEN_LED" | "REFLECTIVE_LCD_SLIP" | "UNREADABLE";
  rawDigitsText: string | null;
  scaleReadGrams: number | null;
  confidence: number;
  detectedGlyphs: number;
  onnxModelSha256?: string;
}

export function hammingDistanceHex64(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    let xor = (parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)) & 0xf;
    while (xor > 0) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

export async function analyzeImageForensics(
  buffer: Buffer
): Promise<ImageQualityForensics> {
  const imageSha256 = sha256Hex(buffer);
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const format = meta.format ?? "unknown";

  const dhashBuf = await sharp(buffer)
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();

  let hexHash = "";
  let nibble = 0;
  let bitIdx = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = dhashBuf[y * 9 + x] ?? 0;
      const right = dhashBuf[y * 9 + x + 1] ?? 0;
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bitIdx++;
      if (bitIdx === 4) {
        hexHash += nibble.toString(16);
        nibble = 0;
        bitIdx = 0;
      }
    }
  }

  const gray128 = await sharp(buffer)
    .rotate()
    .grayscale()
    .resize(128, 128, { fit: "fill" })
    .raw()
    .toBuffer();

  let sumLum = 0;
  for (let i = 0; i < gray128.length; i++) {
    sumLum += gray128[i] ?? 0;
  }
  const meanLuminance = Number((sumLum / gray128.length).toFixed(2));

  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = 1; y < 127; y++) {
    for (let x = 1; x < 127; x++) {
      const c = gray128[y * 128 + x]!;
      const n = gray128[(y - 1) * 128 + x]!;
      const s = gray128[(y + 1) * 128 + x]!;
      const w = gray128[y * 128 + (x - 1)]!;
      const e = gray128[y * 128 + (x + 1)]!;
      const lap = n + s + w + e - 4 * c;
      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }
  const lapMean = lapSum / count;
  const laplacianSharpness = Number(
    Math.max(0, lapSqSum / count - lapMean * lapMean).toFixed(2)
  );

  const qualityWarnings: string[] = [];
  if (width < 120 || height < 90) {
    qualityWarnings.push("LOW_RESOLUTION_FRAME");
  }
  if (meanLuminance < 18) {
    qualityWarnings.push("EXTREME_UNDEREXPOSURE");
  } else if (meanLuminance > 246) {
    qualityWarnings.push("EXTREME_OVEREXPOSURE_GLARE");
  }
  if (laplacianSharpness < 14) {
    qualityWarnings.push("SEVERE_MOTION_OR_FOCUS_BLUR");
  }

  return {
    width,
    height,
    format,
    fileSizeBytes: buffer.length,
    imageSha256,
    perceptualHash64: hexHash,
    meanLuminance,
    laplacianSharpness,
    qualityWarnings,
  };
}

function rgbToHsv(
  r: number,
  g: number,
  b: number
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, v: max };
}

function computePatchFeature8d(
  data: Buffer,
  imgW: number,
  x0: number,
  y0: number,
  pw: number,
  ph: number
) {
  let warmCopper = 0;
  let pcbGreen = 0;
  let goldFinger = 0;
  let cobaltBlue = 0;
  let kraftCardboard = 0;
  let silveryBright = 0;
  let darkCharSoot = 0;
  let dampDarkPatch = 0;
  let satSum = 0;
  const total = pw * ph;

  for (let y = y0; y < y0 + ph; y++) {
    for (let x = x0; x < x0 + pw; x++) {
      const idx = (y * imgW + x) * 3;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      const { h, s, v } = rgbToHsv(r, g, b);
      satSum += s;

      if (h >= 8 && h <= 27 && s >= 0.45 && v >= 0.35 && r > b * 1.8) {
        warmCopper++;
      }
      if (h >= 92 && h <= 168 && s >= 0.28 && v >= 0.18) {
        pcbGreen++;
      }
      if (h >= 38 && h <= 58 && s >= 0.45 && v >= 0.48) {
        goldFinger++;
      }
      if (h >= 195 && h <= 275 && s >= 0.32 && v >= 0.25) {
        cobaltBlue++;
      }
      if (
        h >= 28 &&
        h <= 46 &&
        s >= 0.18 &&
        s <= 0.65 &&
        v >= 0.3 &&
        v <= 0.85
      ) {
        kraftCardboard++;
      }
      if (s < 0.12 && v >= 0.55 && v <= 0.94) {
        silveryBright++;
      }
      if (v < 0.13 && s < 0.2) {
        darkCharSoot++;
      }
      if (h >= 18 && h <= 45 && v >= 0.13 && v < 0.31 && s >= 0.18) {
        dampDarkPatch++;
      }
    }
  }

  return {
    counts: {
      warmCopper,
      pcbGreen,
      goldFinger,
      cobaltBlue,
      kraftCardboard,
      silveryBright,
      darkCharSoot,
      dampDarkPatch,
      satSum,
      total,
    },
    vec8: new Float32Array([
      warmCopper / total,
      pcbGreen / total,
      goldFinger / total,
      cobaltBlue / total,
      kraftCardboard / total,
      silveryBright / total,
      darkCharSoot / total,
      satSum / total,
    ]),
  };
}

export async function extractRgbChw64Tensor(buffer: Buffer): Promise<Float32Array> {
  const raw = await sharp(buffer)
    .rotate()
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const chw = new Float32Array(3 * 64 * 64);
  const hw = 64 * 64;
  for (let i = 0; i < hw; i++) {
    chw[i] = (raw[i * 3] ?? 0) / 255.0;
    chw[hw + i] = (raw[i * 3 + 1] ?? 0) / 255.0;
    chw[2 * hw + i] = (raw[i * 3 + 2] ?? 0) / 255.0;
  }
  return chw;
}

async function extractFiveRegionCnnCrops64(buffer: Buffer): Promise<Float32Array[]> {
  const meta = await sharp(buffer).metadata();
  const w = Math.max(64, meta.width ?? 128);
  const h = Math.max(64, meta.height ?? 128);
  const halfW = Math.max(32, Math.floor(w / 2));
  const halfH = Math.max(32, Math.floor(h / 2));

  const regions = [
    null,
    { left: 0, top: 0, width: halfW, height: halfH },
    { left: w - halfW, top: 0, width: halfW, height: halfH },
    { left: 0, top: h - halfH, width: halfW, height: halfH },
    { left: w - halfW, top: h - halfH, width: halfW, height: halfH },
  ];

  const crops: Float32Array[] = [];
  for (const reg of regions) {
    let pipe = sharp(buffer).rotate();
    if (reg && w >= 64 && h >= 64) {
      pipe = pipe.extract(reg);
    }
    const raw = await pipe.resize(64, 64, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const chw = new Float32Array(3 * 64 * 64);
    const hw = 64 * 64;
    for (let i = 0; i < hw; i++) {
      chw[i] = (raw[i * 3] ?? 0) / 255.0;
      chw[hw + i] = (raw[i * 3 + 1] ?? 0) / 255.0;
      chw[2 * hw + i] = (raw[i * 3 + 2] ?? 0) / 255.0;
    }
    crops.push(chw);
  }
  return crops;
}

/**
 * Public entry point: runs the synthetic-pretrained hybrid forensics AND the
 * real-photo-trained TrashNet gate in parallel, then reconciles them.
 */
export async function classifyMaterialPixels(
  buffer: Buffer
): Promise<PixelMaterialClassification> {
  const [core, gate] = await Promise.all([
    classifyMaterialPixelsCore(buffer),
    extractRgbChw64Tensor(buffer).then((t) => runRealDataTrashnetInference(t)),
  ]);

  const mapped = gate.mappedMaterialSlug;
  const realPhotoGateDisagrees = Boolean(
    mapped !== null && mapped !== core.materialSlug && gate.confidence >= 0.72
  );

  return { ...core, realPhotoGate: gate, realPhotoGateDisagrees };
}

/** Hybrid 2D-CNN + ONNX Multi-Patch Neural Inference + Spectral Adulteration Forensics */
async function classifyMaterialPixelsCore(
  buffer: Buffer
): Promise<Omit<PixelMaterialClassification, "realPhotoGate" | "realPhotoGateDisagrees">> {
  const [{ data, info }, cnnCrops64] = await Promise.all([
    sharp(buffer).rotate().resize(150, 150, { fit: "cover" }).removeAlpha().raw().toBuffer({
      resolveWithObject: true,
    }),
    extractFiveRegionCnnCrops64(buffer),
  ]);

  const full = computePatchFeature8d(data, info.width, 0, 0, 150, 150);
  const patches8d: Float32Array[] = [];
  for (let py = 0; py < 3; py++) {
    for (let px = 0; px < 3; px++) {
      patches8d.push(
        computePatchFeature8d(data, info.width, px * 50, py * 50, 50, 50).vec8
      );
    }
  }
  const onnxInference = await runScrapHeapOnnxInference(patches8d, cnnCrops64);

  const totalPx = full.counts.total;
  const pct = (n: number) => Number(((n / totalPx) * 100).toFixed(2));
  const spectralMetrics = {
    warmCopperPixelPct: pct(full.counts.warmCopper),
    pcbGreenPixelPct: pct(full.counts.pcbGreen),
    goldFingerPixelPct: pct(full.counts.goldFinger),
    cobaltBluePixelPct: pct(full.counts.cobaltBlue),
    kraftCardboardPixelPct: pct(full.counts.kraftCardboard),
    silveryNeutralPixelPct: pct(full.counts.silveryBright),
    darkCharSootPixelPct: pct(full.counts.darkCharSoot),
    meanSaturation: Number((full.counts.satSum / totalPx).toFixed(3)),
  };

  const adulterationFlags: string[] = [];
  if (onnxInference.multiMaterialHeapDetected) {
    adulterationFlags.push("MIXED_MULTI_MATERIAL_HEAP_SEGREGATION_ADVISORY");
  }

  if (spectralMetrics.pcbGreenPixelPct >= 16) {
    const highGold = spectralMetrics.goldFingerPixelPct >= 3.0;
    return {
      materialSlug: "ewaste-pcb-grade-a",
      materialSubtypeLabel: highGold
        ? "High-Gold Telecom / Server Logic PCB (Grade A+)"
        : "Populated Electronic Circuit Board (Grade A/B)",
      confidence: Number(
        Math.max(highGold ? 0.91 : 0.84, onnxInference.onnxConfidence).toFixed(2)
      ),
      uncertaintyReason:
        "Back-side heatsink weight and transformer iron attachments must be verified before Grade-A settlement.",
      coilMetalVerdict: "NOT_APPLICABLE",
      adulterationFlags,
      spectralMetrics,
      onnxInference,
    };
  }

  if (spectralMetrics.warmCopperPixelPct >= 15) {
    if (spectralMetrics.darkCharSootPixelPct >= 22) {
      adulterationFlags.push("ILLEGAL_OPEN_BURNING_SOOT_RESIDUE");
    }
    return {
      materialSlug: "metal-copper-bright",
      materialSubtypeLabel: onnxInference.multiMaterialHeapDetected
        ? "Mixed Heap: Bright Copper + Secondary Scrap (Segregate Before Weighing)"
        : adulterationFlags.includes("ILLEGAL_OPEN_BURNING_SOOT_RESIDUE")
        ? "Burnt / Ash-Contaminated Copper Wire (Downgraded & Flagged)"
        : "Bright Unburnt Electrolytic Copper Wire / Coil (99% Cu)",
      confidence: Number(
        Math.max(
          adulterationFlags.length > 0 ? 0.86 : 0.92,
          onnxInference.onnxConfidence
        ).toFixed(2)
      ),
      uncertaintyReason:
        "Scratch-check thick windings with a file to rule out copper-clad aluminium (CCA) core.",
      coilMetalVerdict: "COPPER_VERIFIED_SIGNATURE",
      adulterationFlags,
      spectralMetrics,
      onnxInference,
    };
  }

  if (spectralMetrics.cobaltBluePixelPct >= 18) {
    if (spectralMetrics.darkCharSootPixelPct >= 18) {
      adulterationFlags.push("THERMAL_SCORCH_OR_SWELLING_RISK");
    }
    return {
      materialSlug: "battery-inverter-lead",
      materialSubtypeLabel: "Regulated Battery Pack / Inverter Cell Stream",
      confidence: 0.85,
      uncertaintyReason:
        "Regulated battery stream — verify intact casing and route strictly to authorised recycler.",
      coilMetalVerdict: "NOT_APPLICABLE",
      adulterationFlags,
      spectralMetrics,
      onnxInference,
    };
  }

  if (spectralMetrics.kraftCardboardPixelPct >= 22) {
    if ((full.counts.dampDarkPatch / totalPx) * 100 >= 18) {
      adulterationFlags.push("MOISTURE_WATER_WEIGHT_ADULTERATION");
    }
    return {
      materialSlug: "paper-cardboard",
      materialSubtypeLabel: adulterationFlags.includes(
        "MOISTURE_WATER_WEIGHT_ADULTERATION"
      )
        ? "Moisture-Heavy Corrugated Cardboard (Dampness Deduction Advisory)"
        : "Dry Corrugated Kraft Cardboard (Clean Gatta)",
      confidence: 0.87,
      uncertaintyReason: adulterationFlags.includes(
        "MOISTURE_WATER_WEIGHT_ADULTERATION"
      )
        ? "High dark-moisture absorption detected in kraft fibres — split bundle to check inner water weight."
        : "Confirm zero mud/oil inner core before baling.",
      coilMetalVerdict: "NOT_APPLICABLE",
      adulterationFlags,
      spectralMetrics,
      onnxInference,
    };
  }

  if (spectralMetrics.silveryNeutralPixelPct >= 28) {
    return {
      materialSlug: "metal-aluminium-utensil",
      materialSubtypeLabel: "Silvery Aluminium Coil / Fin / Sheet (Non-Copper)",
      confidence: 0.88,
      uncertaintyReason:
        "Confirmed silvery neutral reflectance (NOT reddish copper). Test with magnet to separate stainless steel screws.",
      coilMetalVerdict: "ALUMINUM_SILVERY_SIGNATURE",
      adulterationFlags,
      spectralMetrics,
      onnxInference,
    };
  }

  return {
    materialSlug: onnxInference.dominantMaterialSlug || "metal-heavy-iron",
    materialSubtypeLabel: "Mixed Ferrous / Heavy Structural Scrap",
    confidence: 0.74,
    uncertaintyReason:
      "Mixed or low-chroma surface reflectance — confirm magnetic ferrous grade on physical inspection.",
    coilMetalVerdict: "NOT_APPLICABLE",
    adulterationFlags,
    spectralMetrics,
    onnxInference,
  };
}

const SEVEN_SEG_MAP: Array<{ digit: string; mask: number }> = [
  { digit: "0", mask: 0b1111110 },
  { digit: "1", mask: 0b0110000 },
  { digit: "2", mask: 0b1101101 },
  { digit: "3", mask: 0b1111001 },
  { digit: "4", mask: 0b0110011 },
  { digit: "5", mask: 0b1011011 },
  { digit: "6", mask: 0b1011111 },
  { digit: "7", mask: 0b1110000 },
  { digit: "8", mask: 0b1111111 },
  { digit: "9", mask: 0b1111011 },
];

/**
 * Hybrid ONNX + 7-Segment Scale & Non-Illuminated LCD / Printed Slip Reader.
 * Supports:
 *   1. Self-illuminated Red & Green LED scales (`RED_LED`, `GREEN_LED`)
 *   2. Non-illuminated reflective monochrome LCD screens & printed thermal weight slips (`REFLECTIVE_LCD_SLIP`)
 *      decoded via `lcd_scale_ocr_v1.onnx` (`onnxruntime-web`).
 */
export async function readDigitalScalePixels(
  buffer: Buffer
): Promise<ScaleOcrPixelResult> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: 640, withoutEnlargement: false })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width;
  const H = info.height;
  const redMask = new Uint8Array(W * H);
  const greenMask = new Uint8Array(W * H);
  const darkInkMask = new Uint8Array(W * H);
  let redCount = 0;
  let greenCount = 0;
  let darkInkCount = 0;

  // Inner viewport window [14%..86% X, 24%..76% Y] isolates LCD / printed ticket window cleanly from bezel borders
  const vx0 = Math.floor(W * 0.14);
  const vx1 = Math.ceil(W * 0.86);
  const vy0 = Math.floor(H * 0.24);
  const vy1 = Math.ceil(H * 0.76);
  let viewportBrightBgCount = 0;
  const viewportArea = Math.max(1, (vx1 - vx0) * (vy1 - vy0));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      const r = data[p * 3]!;
      const g = data[p * 3 + 1]!;
      const b = data[p * 3 + 2]!;
      if (r >= 170 && r - Math.max(g, b) >= 65) {
        redMask[p] = 1;
        redCount++;
      }
      if (g >= 170 && g - Math.max(r, b) >= 60) {
        greenMask[p] = 1;
        greenCount++;
      }
      if (x >= vx0 && x < vx1 && y >= vy0 && y < vy1) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= 135) {
          viewportBrightBgCount++;
        } else if (lum <= 72) {
          darkInkMask[p] = 1;
          darkInkCount++;
        }
      }
    }
  }

  let displayMode:
    | "RED_LED"
    | "GREEN_LED"
    | "REFLECTIVE_LCD_SLIP"
    | "UNREADABLE" = "UNREADABLE";
  let mask = redMask;

  const activeLedCount = Math.max(redCount, greenCount);
  if (activeLedCount >= 80 && activeLedCount <= W * H * 0.35) {
    if (redCount >= greenCount) {
      displayMode = "RED_LED";
      mask = redMask;
    } else {
      displayMode = "GREEN_LED";
      mask = greenMask;
    }
  } else if (
    viewportBrightBgCount / viewportArea >= 0.45 &&
    darkInkCount >= 80 &&
    darkInkCount <= viewportArea * 0.4
  ) {
    displayMode = "REFLECTIVE_LCD_SLIP";
    mask = darkInkMask;
  } else {
    return {
      readable: false,
      displayMode: "UNREADABLE",
      rawDigitsText: null,
      scaleReadGrams: null,
      confidence: 0.15,
      detectedGlyphs: 0,
    };
  }

  const rowCounts = new Int32Array(H);
  let peakRow = 0;
  let peakY = 0;
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) c += mask[y * W + x]!;
    rowCounts[y] = c;
    if (c > peakRow) {
      peakRow = c;
      peakY = y;
    }
  }

  const rowThresh = Math.max(2, Math.floor(peakRow * 0.06));
  let topY = peakY;
  while (topY > 0 && rowCounts[topY - 1]! >= rowThresh) topY--;
  let botY = peakY;
  while (botY < H - 1 && rowCounts[botY + 1]! >= rowThresh) botY++;

  const bandH = botY - topY + 1;
  if (bandH < 18) {
    return {
      readable: false,
      displayMode,
      rawDigitsText: null,
      scaleReadGrams: null,
      confidence: 0.2,
      detectedGlyphs: 0,
    };
  }

  const colCounts = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = topY; y <= botY; y++) c += mask[y * W + x]!;
    colCounts[x] = c;
  }

  const blobs: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  let x = 0;
  while (x < W) {
    if (colCounts[x]! >= 2) {
      const x0 = x;
      while (x + 1 < W && colCounts[x + 1]! >= 2) x++;
      const x1 = x;
      let y0 = botY;
      let y1 = topY;
      for (let yy = topY; yy <= botY; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (mask[yy * W + xx]) {
            if (yy < y0) y0 = yy;
            if (yy > y1) y1 = yy;
          }
        }
      }
      blobs.push({ x0, x1, y0, y1 });
    }
    x++;
  }

  const regionLit = (
    bx0: number,
    bx1: number,
    ry0: number,
    ry1: number,
    rx0: number,
    rx1: number
  ): number => {
    const sx0 = Math.max(bx0, Math.floor(bx0 + (bx1 - bx0 + 1) * rx0));
    const sx1 = Math.min(bx1, Math.ceil(bx0 + (bx1 - bx0 + 1) * rx1));
    const sy0 = Math.max(topY, Math.floor(topY + bandH * ry0));
    const sy1 = Math.min(botY, Math.ceil(topY + bandH * ry1));
    let lit = 0;
    let area = 0;
    for (let yy = sy0; yy <= sy1; yy++) {
      for (let xx = sx0; xx <= sx1; xx++) {
        area++;
        if (mask[yy * W + xx]) lit++;
      }
    }
    return area > 0 && lit / area >= 0.22 ? 1 : 0;
  };

  type TokenSlot =
    | { kind: "DOT" }
    | { kind: "ONE" }
    | { kind: "GLYPH"; feat42: Float32Array; fallbackDigit: string; penalty: number };

  const tokens: TokenSlot[] = [];

  for (const b of blobs) {
    const bw = b.x1 - b.x0 + 1;
    const bh = b.y1 - b.y0 + 1;

    if (bh <= bandH * 0.28 && bw <= bandH * 0.28 && b.y0 >= topY + bandH * 0.65) {
      tokens.push({ kind: "DOT" });
      continue;
    }

    if (bh < bandH * 0.55) continue;

    if (bw < bandH * 0.3) {
      tokens.push({ kind: "ONE" });
      continue;
    }

    const segA = regionLit(b.x0, b.x1, 0.0, 0.16, 0.3, 0.7);
    const segB = regionLit(b.x0, b.x1, 0.17, 0.41, 0.74, 1.0);
    const segC = regionLit(b.x0, b.x1, 0.59, 0.83, 0.74, 1.0);
    const segD = regionLit(b.x0, b.x1, 0.84, 1.0, 0.3, 0.7);
    const segE = regionLit(b.x0, b.x1, 0.59, 0.83, 0.0, 0.26);
    const segF = regionLit(b.x0, b.x1, 0.17, 0.41, 0.0, 0.26);
    const segG = regionLit(b.x0, b.x1, 0.42, 0.58, 0.3, 0.7);

    // Extract normalized 7x5 glyph density grid + 7 topological segments -> 42D ONNX input vector
    const feat42 = new Float32Array(42);
    for (let gr = 0; gr < 7; gr++) {
      const gy0 = Math.floor(topY + (bandH * gr) / 7);
      const gy1 = Math.max(gy0, Math.floor(topY + (bandH * (gr + 1)) / 7) - 1);
      for (let gc = 0; gc < 5; gc++) {
        const gx0 = Math.floor(b.x0 + (bw * gc) / 5);
        const gx1 = Math.max(gx0, Math.floor(b.x0 + (bw * (gc + 1)) / 5) - 1);
        let lit = 0;
        let area = 0;
        for (let yy = gy0; yy <= gy1; yy++) {
          for (let xx = gx0; xx <= gx1; xx++) {
            area++;
            if (mask[yy * W + xx]) lit++;
          }
        }
        feat42[gr * 5 + gc] = area > 0 && lit / area >= 0.2 ? 1.0 : 0.0;
      }
    }
    feat42[35] = segA;
    feat42[36] = segB;
    feat42[37] = segC;
    feat42[38] = segD;
    feat42[39] = segE;
    feat42[40] = segF;
    feat42[41] = segG;

    const observedMask =
      (segA << 6) |
      (segB << 5) |
      (segC << 4) |
      (segD << 3) |
      (segE << 2) |
      (segF << 1) |
      segG;

    let bestDigit = "?";
    let bestDist = 99;
    for (const cand of SEVEN_SEG_MAP) {
      let xor = observedMask ^ cand.mask;
      let d = 0;
      while (xor > 0) {
        d += xor & 1;
        xor >>= 1;
      }
      if (d < bestDist) {
        bestDist = d;
        bestDigit = cand.digit;
      }
    }

    tokens.push({ kind: "GLYPH", feat42, fallbackDigit: bestDigit, penalty: bestDist });
  }

  const glyphBatch = tokens
    .filter((t): t is Extract<TokenSlot, { kind: "GLYPH" }> => t.kind === "GLYPH")
    .map((g) => g.feat42);

  const onnxOut = await runScaleGlyphOnnxInference(glyphBatch);

  let parsed = "";
  let digitCount = 0;
  let glyphIdx = 0;
  let confSum = 0;

  for (const tok of tokens) {
    if (tok.kind === "DOT") {
      parsed += ".";
    } else if (tok.kind === "ONE") {
      parsed += "1";
      digitCount++;
      confSum += 0.97;
    } else {
      const pred = onnxOut.predictions[glyphIdx++];
      if (pred && pred.confidence >= 0.55 && tok.penalty <= 2) {
        parsed += pred.digit;
        digitCount++;
        confSum += pred.confidence;
      } else if (tok.penalty <= 1) {
        parsed += tok.fallbackDigit;
        digitCount++;
        confSum += 0.88;
      }
    }
  }

  const numeric = Number(parsed);
  if (digitCount === 0 || !Number.isFinite(numeric) || numeric <= 0) {
    return {
      readable: false,
      displayMode,
      rawDigitsText: parsed || null,
      scaleReadGrams: null,
      confidence: 0.25,
      detectedGlyphs: blobs.length,
      onnxModelSha256: onnxOut.modelSha256,
    };
  }

  const confidence = Number(
    Math.max(0.6, Math.min(0.99, confSum / digitCount)).toFixed(2)
  );

  return {
    readable: true,
    displayMode,
    rawDigitsText: parsed,
    scaleReadGrams: Math.round(numeric * 1000),
    confidence,
    detectedGlyphs: blobs.length,
    onnxModelSha256: onnxOut.modelSha256,
  };
}

export async function generateScalePlatePng(
  weightKgFormatted: string,
  displayStyle: "RED" | "GREEN" | "LCD" | "PAPER_SLIP" = "RED"
): Promise<Buffer> {
  const isLcd = displayStyle === "LCD";
  const isPaper = displayStyle === "PAPER_SLIP";
  const screenBg = isPaper
    ? "#f8fafc"
    : isLcd
    ? "#a7b89c"
    : "#0d1117";
  const glyphFill = isPaper
    ? "#111827"
    : isLcd
    ? "#1e2923"
    : displayStyle === "RED"
    ? "#ff2424"
    : "#18f26a";

  const digitW = 64;
  const digitH = 116;
  const thick = 12;

  const segRectsForChar = (ch: string, ox: number, oy: number): string => {
    if (ch === ".") {
      return `<rect x="${ox}" y="${
        oy + digitH - 16
      }" width="16" height="16" rx="3" fill="${glyphFill}" />`;
    }
    const entry = SEVEN_SEG_MAP.find((m) => m.digit === ch);
    if (!entry) return "";
    const m = entry.mask;
    const parts: string[] = [];
    if (m & (1 << 6))
      parts.push(
        `<rect x="${ox + thick}" y="${oy}" width="${
          digitW - 2 * thick
        }" height="${thick}" rx="2" fill="${glyphFill}"/>`
      );
    if (m & (1 << 5))
      parts.push(
        `<rect x="${ox + digitW - thick}" y="${oy + 2}" width="${thick}" height="${
          digitH / 2 - 4
        }" rx="2" fill="${glyphFill}"/>`
      );
    if (m & (1 << 4))
      parts.push(
        `<rect x="${ox + digitW - thick}" y="${
          oy + digitH / 2 + 2
        }" width="${thick}" height="${
          digitH / 2 - 4
        }" rx="2" fill="${glyphFill}"/>`
      );
    if (m & (1 << 3))
      parts.push(
        `<rect x="${ox + thick}" y="${oy + digitH - thick}" width="${
          digitW - 2 * thick
        }" height="${thick}" rx="2" fill="${glyphFill}"/>`
      );
    if (m & (1 << 2))
      parts.push(
        `<rect x="${ox}" y="${oy + digitH / 2 + 2}" width="${thick}" height="${
          digitH / 2 - 4
        }" rx="2" fill="${glyphFill}"/>`
      );
    if (m & (1 << 1))
      parts.push(
        `<rect x="${ox}" y="${oy + 2}" width="${thick}" height="${
          digitH / 2 - 4
        }" rx="2" fill="${glyphFill}"/>`
      );
    if (m & 1)
      parts.push(
        `<rect x="${ox + thick}" y="${
          oy + digitH / 2 - thick / 2
        }" width="${digitW - 2 * thick}" height="${thick}" rx="2" fill="${glyphFill}"/>`
      );
    return parts.join("");
  };

  let cursorX = 95;
  const glyphsSvg: string[] = [];
  for (const ch of weightKgFormatted) {
    if (ch === ".") {
      glyphsSvg.push(segRectsForChar(".", cursorX, 92));
      cursorX += 30;
    } else if (ch >= "0" && ch <= "9") {
      glyphsSvg.push(segRectsForChar(ch, cursorX, 92));
      cursorX += digitW + 20;
    }
  }

  const svg = `
    <svg width="560" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="560" height="300" fill="#2d3748"/>
      <rect x="26" y="24" width="508" height="252" rx="22" fill="#4a5568" stroke="#718096" stroke-width="4"/>
      <rect x="60" y="64" width="440" height="172" rx="12" fill="${screenBg}" stroke="#1a202c" stroke-width="5"/>
      ${glyphsSvg.join("\n")}
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function generateMaterialSamplePng(
  preset:
    | "copper-clean"
    | "copper-burnt-fraud"
    | "aluminum-coil"
    | "pcb-grade-a"
    | "cardboard-wet-fraud"
    | "battery-pack"
    | "mixed-copper-aluminum"
): Promise<Buffer> {
  let svgBody = "";
  switch (preset) {
    case "copper-clean":
      svgBody = `
        <rect width="400" height="300" fill="#4a2518"/>
        ${Array.from({ length: 18 })
          .map(
            (_, i) =>
              `<line x1="20" y1="${20 + i * 15}" x2="380" y2="${
                32 + i * 14
              }" stroke="${
                i % 2 === 0 ? "#d96b38" : "#e8844f"
              }" stroke-width="10"/>`
          )
          .join("")}
      `;
      break;
    case "copper-burnt-fraud":
      svgBody = `
        <rect width="400" height="300" fill="#121214"/>
        ${Array.from({ length: 15 })
          .map(
            (_, i) =>
              `<line x1="30" y1="${25 + i * 17}" x2="370" y2="${
                35 + i * 16
              }" stroke="#c85c2d" stroke-width="9"/>`
          )
          .join("")}
        <circle cx="110" cy="120" r="55" fill="#0b0b0c"/>
        <circle cx="290" cy="195" r="65" fill="#0e0e10"/>
      `;
      break;
    case "aluminum-coil":
      svgBody = `
        <rect width="400" height="300" fill="#9ca3af"/>
        ${Array.from({ length: 20 })
          .map(
            (_, i) =>
              `<rect x="${18 + i * 18}" y="25" width="11" height="250" fill="${
                i % 2 === 0 ? "#cbd5e1" : "#e2e8f0"
              }"/>`
          )
          .join("")}
      `;
      break;
    case "mixed-copper-aluminum":
      // Left 2/3 copper coils, right 1/3 silvery aluminium fins -> real mixed heap!
      svgBody = `
        <rect x="0" y="0" width="266" height="300" fill="#4a2518"/>
        ${Array.from({ length: 18 })
          .map(
            (_, i) =>
              `<line x1="10" y1="${18 + i * 15}" x2="256" y2="${
                24 + i * 15
              }" stroke="${
                i % 2 === 0 ? "#d96b38" : "#e8844f"
              }" stroke-width="10"/>`
          )
          .join("")}
        <rect x="266" y="0" width="134" height="300" fill="#9ca3af"/>
        ${Array.from({ length: 7 })
          .map(
            (_, i) =>
              `<rect x="${274 + i * 18}" y="15" width="11" height="270" fill="#e2e8f0"/>`
          )
          .join("")}
      `;
      break;
    case "pcb-grade-a":
      svgBody = `
        <rect width="400" height="300" fill="#0f7a4a"/>
        <rect x="45" y="45" width="95" height="95" fill="#1e242b" stroke="#eab308" stroke-width="4"/>
        <rect x="210" y="65" width="110" height="80" fill="#1a2027" stroke="#eab308" stroke-width="4"/>
        <rect x="30" y="250" width="340" height="28" fill="#eab308"/>
      `;
      break;
    case "cardboard-wet-fraud":
      svgBody = `
        <rect width="400" height="300" fill="#b88b58"/>
        <rect x="30" y="30" width="340" height="240" fill="#c29563" stroke="#9c6f3e" stroke-width="6"/>
        <ellipse cx="200" cy="165" rx="115" ry="78" fill="#4a3520"/>
      `;
      break;
    case "battery-pack":
      svgBody = `
        <rect width="400" height="300" fill="#1e293b"/>
        <rect x="55" y="45" width="290" height="210" rx="18" fill="#1d4ed8" stroke="#60a5fa" stroke-width="6"/>
        <circle cx="130" cy="95" r="18" fill="#94a3b8"/>
        <circle cx="270" cy="95" r="18" fill="#ef4444"/>
      `;
      break;
  }

  const svg = `<svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">${svgBody}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export type ApplianceXraySamplePreset =
  | "xray-split-ac-copper"
  | "xray-split-ac-aluminum"
  | "xray-smartphone"
  | "xray-laptop"
  | "xray-ceiling-fan"
  | "xray-washing-machine";

export async function generateApplianceXraySamplePng(
  preset: ApplianceXraySamplePreset
): Promise<Buffer> {
  // Coordinates defined in 64x64 viewBox scaled cleanly to 320x320 RGB camera frame
  let body = "";
  switch (preset) {
    case "xray-split-ac-copper":
      body = `
        <rect width="64" height="64" fill="#e2e8f0"/>
        <rect x="5" y="10" width="54" height="44" fill="#eef0f4" stroke="#64748b" stroke-width="2"/>
        <circle cx="22" cy="32" r="13" fill="#232934" stroke="#475569" stroke-width="2"/>
        <rect x="38" y="15" width="17" height="34" fill="#d06c34"/>
        ${[18, 22, 26, 30, 34, 38, 42, 46]
          .map((y) => `<line x1="38" y1="${y}" x2="55" y2="${y}" stroke="#783e1e" stroke-width="1"/>`)
          .join("")}
      `;
      break;
    case "xray-split-ac-aluminum":
      body = `
        <rect width="64" height="64" fill="#e2e8f0"/>
        <rect x="5" y="10" width="54" height="44" fill="#eef0f4" stroke="#64748b" stroke-width="2"/>
        <circle cx="22" cy="32" r="13" fill="#232934" stroke="#475569" stroke-width="2"/>
        <rect x="38" y="15" width="17" height="34" fill="#b6c0cc"/>
        ${[18, 22, 26, 30, 34, 38, 42, 46]
          .map((y) => `<line x1="38" y1="${y}" x2="55" y2="${y}" stroke="#87919e" stroke-width="1"/>`)
          .join("")}
      `;
      break;
    case "xray-smartphone":
      body = `
        <rect width="64" height="64" fill="#cdd6e2"/>
        <rect x="18" y="5" width="28" height="54" fill="#121826" stroke="#5e6c80" stroke-width="2"/>
        <rect x="21" y="8" width="11" height="14" fill="#2d3a4e"/>
        <circle cx="26" cy="12.5" r="2.8" fill="#60a5fa"/>
        <circle cx="26" cy="18.5" r="2.8" fill="#34d399"/>
      `;
      break;
    case "xray-laptop":
      body = `
        <rect width="64" height="64" fill="#d7dee8"/>
        <rect x="9" y="8" width="46" height="28" fill="#141c2c" stroke="#475569" stroke-width="2"/>
        <polygon points="5,37 59,37 62,55 2,55" fill="#a8b2c0"/>
        <rect x="12" y="40" width="40" height="9" fill="#2a303a"/>
      `;
      break;
    case "xray-ceiling-fan":
      body = `
        <rect width="64" height="64" fill="#ebe4d6"/>
        <line x1="32" y1="32" x2="6" y2="14" stroke="#915c3a" stroke-width="6"/>
        <line x1="32" y1="32" x2="58" y2="14" stroke="#915c3a" stroke-width="6"/>
        <line x1="32" y1="32" x2="32" y2="60" stroke="#915c3a" stroke-width="6"/>
        <circle cx="32" cy="32" r="11" fill="#c66830" stroke="#5c3218" stroke-width="2"/>
      `;
      break;
    case "xray-washing-machine":
      body = `
        <rect width="64" height="64" fill="#dce8f6"/>
        <rect x="7" y="8" width="50" height="49" fill="#f5f7fa" stroke="#64748b" stroke-width="2"/>
        <rect x="7" y="8" width="50" height="9" fill="#1d4ed8"/>
        <rect x="10" y="20" width="22" height="19" fill="#bfdbfe"/>
        <rect x="35" y="20" width="19" height="19" fill="#93c5fd"/>
      `;
      break;
  }

  const svg = `<svg width="320" height="320" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
