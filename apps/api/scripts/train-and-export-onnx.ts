import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as ort from "onnxruntime-web";

/**
 * Minimal, self-contained ONNX IR v8 (Opset 13) binary Protobuf encoder +
 * Deterministic Neural Network trainer producing authentic `.onnx` weight files:
 *   1. `apps/api/models/scrap_material_classifier_v1.onnx` (8 -> 24 -> 6 MLP + Softmax)
 *   2. `apps/api/models/lcd_scale_ocr_v1.onnx` (42 -> 36 -> 10 MLP + Softmax)
 */

// ── Wire-level Protobuf primitives ────────────────────────────────────────────
function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let v = val >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function pbTag(fieldNum: number, wireType: 0 | 2): Buffer {
  return encodeVarint((fieldNum << 3) | wireType);
}

function pbUint64(fieldNum: number, val: number): Buffer {
  return Buffer.concat([pbTag(fieldNum, 0), encodeVarint(val)]);
}

function pbBytes(fieldNum: number, buf: Buffer): Buffer {
  return Buffer.concat([pbTag(fieldNum, 2), encodeVarint(buf.length), buf]);
}

function pbString(fieldNum: number, str: string): Buffer {
  return pbBytes(fieldNum, Buffer.from(str, "utf8"));
}

// ONNX TensorProto (FLOAT = 1): dims=1(rep int64), data_type=2(int32), name=8(str), raw_data=9(bytes)
function encodeFloatTensorProto(
  name: string,
  dims: number[],
  values: Float32Array
): Buffer {
  const parts: Buffer[] = [];
  for (const d of dims) {
    parts.push(pbUint64(1, d));
  }
  parts.push(pbUint64(2, 1)); // TensorProto.FLOAT = 1
  parts.push(pbString(8, name));
  parts.push(
    pbBytes(
      9,
      Buffer.from(values.buffer, values.byteOffset, values.byteLength)
    )
  );
  return Buffer.concat(parts);
}

// ONNX ValueInfoProto: name=1, type=2(TypeProto{tensor_type=1: Tensor{elem_type=1, shape=2}})
function encodeFloatValueInfo(name: string, dims: Array<number | string>): Buffer {
  const dimMsgs = dims.map((d) =>
    typeof d === "number" ? pbUint64(1, d) : pbString(2, d)
  );
  const shapeProto = Buffer.concat(dimMsgs.map((dm) => pbBytes(1, dm)));
  const tensorTypeProto = Buffer.concat([
    pbUint64(1, 1), // elem_type = FLOAT (1)
    pbBytes(2, shapeProto),
  ]);
  const typeProto = pbBytes(1, tensorTypeProto);
  return Buffer.concat([pbString(1, name), pbBytes(2, typeProto)]);
}

// ONNX NodeProto: input=1(rep str), output=2(rep str), name=3(str), op_type=4(str), attribute=5(rep AttributeProto)
function encodeAxisIntAttribute(name: string, intVal: number): Buffer {
  // AttributeProto: name=1, i=3(varint), type=20(INT=2)
  return Buffer.concat([
    pbString(1, name),
    pbUint64(3, intVal),
    pbUint64(20, 2),
  ]);
}

function encodeNodeProto(
  opType: string,
  nodeName: string,
  inputs: string[],
  outputs: string[],
  attrs: Buffer[] = []
): Buffer {
  const parts: Buffer[] = [];
  for (const inp of inputs) parts.push(pbString(1, inp));
  for (const out of outputs) parts.push(pbString(2, out));
  parts.push(pbString(3, nodeName));
  parts.push(pbString(4, opType));
  for (const a of attrs) parts.push(pbBytes(5, a));
  return Buffer.concat(parts);
}

function serializeTwoLayerMlpOnnx(params: {
  graphName: string;
  docString: string;
  inDim: number;
  hiddenDim: number;
  outDim: number;
  w1: Float32Array; // [inDim, hiddenDim]
  b1: Float32Array; // [hiddenDim]
  w2: Float32Array; // [hiddenDim, outDim]
  b2: Float32Array; // [outDim]
}): Buffer {
  const nodes = [
    encodeNodeProto("Gemm", "fc1", ["input", "W1", "B1"], ["h1_pre"]),
    encodeNodeProto("Relu", "relu1", ["h1_pre"], ["h1"]),
    encodeNodeProto("Gemm", "fc2", ["h1", "W2", "B2"], ["logits"]),
    encodeNodeProto(
      "Softmax",
      "softmax_out",
      ["logits"],
      ["probs"],
      [encodeAxisIntAttribute("axis", 1)]
    ),
  ];

  const initializers = [
    encodeFloatTensorProto("W1", [params.inDim, params.hiddenDim], params.w1),
    encodeFloatTensorProto("B1", [params.hiddenDim], params.b1),
    encodeFloatTensorProto("W2", [params.hiddenDim, params.outDim], params.w2),
    encodeFloatTensorProto("B2", [params.outDim], params.b2),
  ];

  // GraphProto: node=1, name=2, initializer=5, doc_string=10, input=11, output=12
  const graphParts: Buffer[] = [];
  for (const n of nodes) graphParts.push(pbBytes(1, n));
  graphParts.push(pbString(2, params.graphName));
  for (const init of initializers) graphParts.push(pbBytes(5, init));
  graphParts.push(pbString(10, params.docString));
  graphParts.push(
    pbBytes(11, encodeFloatValueInfo("input", ["batch", params.inDim]))
  );
  graphParts.push(
    pbBytes(12, encodeFloatValueInfo("probs", ["batch", params.outDim]))
  );
  const graphProto = Buffer.concat(graphParts);

  // OperatorSetIdProto: domain=1(""), version=2(13)
  const opsetProto = Buffer.concat([pbString(1, ""), pbUint64(2, 13)]);

  // ModelProto: ir_version=1(8), producer_name=2, model_version=5, graph=7, opset_import=8
  return Buffer.concat([
    pbUint64(1, 8),
    pbString(2, "kabadiwala-connect-onnx-trainer"),
    pbUint64(5, 1),
    pbBytes(7, graphProto),
    pbBytes(8, opsetProto),
  ]);
}

// ── Deterministic PRNG & Two-Layer MLP Cross-Entropy Trainer ─────────────────
function createRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function trainTwoLayerMlp(
  inDim: number,
  hiddenDim: number,
  outDim: number,
  samples: Array<{ x: Float32Array; y: number }>,
  epochs: number,
  lr: number
) {
  const rand = createRng(20261023);
  const w1 = new Float32Array(inDim * hiddenDim);
  const b1 = new Float32Array(hiddenDim);
  const w2 = new Float32Array(hiddenDim * outDim);
  const b2 = new Float32Array(outDim);

  const scale1 = Math.sqrt(2 / inDim);
  const scale2 = Math.sqrt(2 / hiddenDim);
  for (let i = 0; i < w1.length; i++) w1[i] = (rand() * 2 - 1) * scale1;
  for (let i = 0; i < w2.length; i++) w2[i] = (rand() * 2 - 1) * scale2;

  const hPre = new Float32Array(hiddenDim);
  const hAct = new Float32Array(hiddenDim);
  const logits = new Float32Array(outDim);
  const probs = new Float32Array(outDim);
  const dLogits = new Float32Array(outDim);
  const dHidden = new Float32Array(hiddenDim);

  for (let ep = 0; ep < epochs; ep++) {
    for (const sample of samples) {
      const { x, y } = sample;
      // Forward
      for (let j = 0; j < hiddenDim; j++) {
        let sum = b1[j]!;
        for (let i = 0; i < inDim; i++) sum += x[i]! * w1[i * hiddenDim + j]!;
        hPre[j] = sum;
        hAct[j] = sum > 0 ? sum : 0;
      }
      let maxL = -Infinity;
      for (let k = 0; k < outDim; k++) {
        let sum = b2[k]!;
        for (let j = 0; j < hiddenDim; j++) sum += hAct[j]! * w2[j * outDim + k]!;
        logits[k] = sum;
        if (sum > maxL) maxL = sum;
      }
      let expSum = 0;
      for (let k = 0; k < outDim; k++) {
        probs[k] = Math.exp(logits[k]! - maxL);
        expSum += probs[k]!;
      }
      for (let k = 0; k < outDim; k++) {
        probs[k] = probs[k]! / expSum;
        dLogits[k] = probs[k]! - (k === y ? 1 : 0);
      }

      // Backward
      for (let j = 0; j < hiddenDim; j++) {
        let grad = 0;
        for (let k = 0; k < outDim; k++) {
          grad += dLogits[k]! * w2[j * outDim + k]!;
          w2[j * outDim + k] = w2[j * outDim + k]! - lr * hAct[j]! * dLogits[k]!;
        }
        dHidden[j] = hPre[j]! > 0 ? grad : 0;
      }
      for (let k = 0; k < outDim; k++) {
        b2[k] = b2[k]! - lr * dLogits[k]!;
      }
      for (let i = 0; i < inDim; i++) {
        for (let j = 0; j < hiddenDim; j++) {
          w1[i * hiddenDim + j] =
            w1[i * hiddenDim + j]! - lr * x[i]! * dHidden[j]!;
        }
      }
      for (let j = 0; j < hiddenDim; j++) {
        b1[j] = b1[j]! - lr * dHidden[j]!;
      }
    }
  }

  return { w1, b1, w2, b2 };
}

// ── 1. Train Scrap Material Classifier (6 classes, 8 spectral features) ──────
const SCRAP_PROTOTYPES: Array<{ slug: string; proto: number[] }> = [
  // [warmCopper, pcbGreen, goldFinger, cobaltBlue, kraftBoard, silveryNeutral, darkCharSoot, meanSat]
  { slug: "metal-copper-bright", proto: [0.55, 0.0, 0.01, 0.0, 0.03, 0.02, 0.18, 0.62] },
  { slug: "ewaste-pcb-grade-a", proto: [0.02, 0.48, 0.14, 0.01, 0.02, 0.05, 0.15, 0.68] },
  { slug: "battery-inverter-lead", proto: [0.02, 0.01, 0.01, 0.45, 0.01, 0.12, 0.22, 0.58] },
  { slug: "paper-cardboard", proto: [0.02, 0.0, 0.02, 0.0, 0.62, 0.02, 0.08, 0.42] },
  { slug: "metal-aluminium-utensil", proto: [0.01, 0.0, 0.0, 0.01, 0.01, 0.72, 0.04, 0.06] },
  { slug: "metal-heavy-iron", proto: [0.03, 0.01, 0.01, 0.02, 0.04, 0.14, 0.45, 0.12] },
];

// ── 2. Train LCD & Printed Scale Digit Classifier (10 classes '0'..'9', 42 features) ─
const DIGIT_SEG_MASKS = [
  0b1111110, // 0
  0b0110000, // 1
  0b1101101, // 2
  0b1111001, // 3
  0b0110011, // 4
  0b1011011, // 5
  0b1011111, // 6
  0b1110000, // 7
  0b1111111, // 8
  0b1111011, // 9
];

function canonicalGlyphFeatures42(digit: number): Float32Array {
  const mask = DIGIT_SEG_MASKS[digit]!;
  const grid = new Float32Array(42);
  // Render 7x5 idealized grid matching 7-segment & block printed numerals + 7 topological segment features
  const segCells: Array<[number, Array<[number, number]>]> = [
    [6, [[0, 1], [0, 2], [0, 3]]], // A top
    [5, [[1, 4], [2, 4]]],         // B upper-right
    [4, [[4, 4], [5, 4]]],         // C lower-right
    [3, [[6, 1], [6, 2], [6, 3]]], // D bottom
    [2, [[4, 0], [5, 0]]],         // E lower-left
    [1, [[1, 0], [2, 0]]],         // F upper-left
    [0, [[3, 1], [3, 2], [3, 3]]], // G middle
  ];
  for (let s = 0; s < segCells.length; s++) {
    const [bit, coords] = segCells[s]!;
    const active = (mask >> bit) & 1;
    grid[35 + s] = active;
    if (active) {
      for (const [r, c] of coords) {
        grid[r * 5 + c] = 1.0;
      }
    }
  }
  return grid;
}

async function main() {
  const rand = createRng(991177);

  // Build noisy synthetic training corpus for Scrap Material MLP
  const scrapSamples: Array<{ x: Float32Array; y: number }> = [];
  for (let cls = 0; cls < SCRAP_PROTOTYPES.length; cls++) {
    const base = SCRAP_PROTOTYPES[cls]!.proto;
    for (let n = 0; n < 240; n++) {
      const x = new Float32Array(8);
      for (let f = 0; f < 8; f++) {
        x[f] = Math.max(0, Math.min(1, base[f]! + (rand() * 2 - 1) * 0.14));
      }
      // Also include burnt-copper high-soot variations under class 0
      if (cls === 0 && n % 3 === 0) {
        x[0] = 0.24 + rand() * 0.15;
        x[6] = 0.35 + rand() * 0.30;
      }
      // Include damp dark-patch cardboard variations under class 3
      if (cls === 3 && n % 3 === 0) {
        x[4] = 0.34 + rand() * 0.20;
        x[6] = 0.25 + rand() * 0.20;
      }
      scrapSamples.push({ x, y: cls });
    }
  }

  const scrapWeights = trainTwoLayerMlp(8, 24, 6, scrapSamples, 90, 0.06);
  const scrapOnnxBytes = serializeTwoLayerMlpOnnx({
    graphName: "kc_scrap_material_classifier_v1",
    docString:
      "Kabadiwala Connect 6-Class Scrap Stream & Heap Patch MLP Classifier (IR v8 Opset 13)",
    inDim: 8,
    hiddenDim: 24,
    outDim: 6,
    ...scrapWeights,
  });

  // Build noisy synthetic training corpus for LCD / Printed Scale Digit OCR MLP
  const ocrSamples: Array<{ x: Float32Array; y: number }> = [];
  for (let d = 0; d < 10; d++) {
    const proto = canonicalGlyphFeatures42(d);
    for (let n = 0; n < 200; n++) {
      const x = new Float32Array(42);
      for (let f = 0; f < 42; f++) {
        x[f] = Math.max(0, Math.min(1, proto[f]! + (rand() * 2 - 1) * 0.16));
      }
      ocrSamples.push({ x, y: d });
    }
  }

  const ocrWeights = trainTwoLayerMlp(42, 36, 10, ocrSamples, 110, 0.05);
  const ocrOnnxBytes = serializeTwoLayerMlpOnnx({
    graphName: "kc_lcd_scale_ocr_v1",
    docString:
      "Kabadiwala Connect 10-Digit Reflective LCD & LED Scale Glyph OCR Classifier (IR v8 Opset 13)",
    inDim: 42,
    hiddenDim: 36,
    outDim: 10,
    ...ocrWeights,
  });

  const modelsDir = path.resolve(__dirname, "..", "models");
  fs.mkdirSync(modelsDir, { recursive: true });

  const scrapPath = path.join(modelsDir, "scrap_material_classifier_v1.onnx");
  const ocrPath = path.join(modelsDir, "lcd_scale_ocr_v1.onnx");
  fs.writeFileSync(scrapPath, scrapOnnxBytes);
  fs.writeFileSync(ocrPath, ocrOnnxBytes);

  // Immediately verify both binary .onnx files inside genuine ONNX Runtime C++/WASM session!
  ort.env.wasm.numThreads = 1;
  const scrapSession = await ort.InferenceSession.create(scrapOnnxBytes);
  const ocrSession = await ort.InferenceSession.create(ocrOnnxBytes);

  const testCopper = new ort.Tensor(
    "float32",
    new Float32Array(SCRAP_PROTOTYPES[0]!.proto),
    [1, 8]
  );
  const scrapOut = await scrapSession.run({ input: testCopper });
  const scrapProbs = scrapOut.probs!.data as Float32Array;

  const testEight = new ort.Tensor("float32", canonicalGlyphFeatures42(8), [
    1,
    42,
  ]);
  const ocrOut = await ocrSession.run({ input: testEight });
  const ocrProbs = ocrOut.probs!.data as Float32Array;

  const manifest = {
    generatedAt: new Date().toISOString(),
    irVersion: 8,
    opsetVersion: 13,
    models: {
      scrapMaterialClassifier: {
        file: "scrap_material_classifier_v1.onnx",
        bytes: scrapOnnxBytes.length,
        sha256: crypto.createHash("sha256").update(scrapOnnxBytes).digest("hex"),
        classes: SCRAP_PROTOTYPES.map((p) => p.slug),
        selfTestCopperConfidence: Number(scrapProbs[0]!.toFixed(4)),
      },
      lcdScaleDigitOcr: {
        file: "lcd_scale_ocr_v1.onnx",
        bytes: ocrOnnxBytes.length,
        sha256: crypto.createHash("sha256").update(ocrOnnxBytes).digest("hex"),
        classes: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
        selfTestDigit8Confidence: Number(ocrProbs[8]!.toFixed(4)),
      },
    },
  };

  fs.writeFileSync(
    path.join(modelsDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log("ONNX Training & Runtime Self-Test Succeeded:", manifest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
