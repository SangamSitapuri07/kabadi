import React, { useRef, useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { paiseToInrString, SupportedLanguage } from "@kabadi/shared";
import {
  MobileActorProfile,
  MobileApiClient,
  QrResolutionResult,
} from "../api/mobileClient";
import { MOBILE_STRINGS, speakNativeVernacular } from "../i18n/vernacular";

interface Props {
  client: MobileApiClient;
  actor: MobileActorProfile | null;
  lang: SupportedLanguage;
}

type CamSubTab = "MATERIAL" | "SCALE" | "XRAY" | "AI_CHAT" | "QR";

export function CameraAndQrScannerScreen({ client, actor, lang }: Props) {
  const t = MOBILE_STRINGS[lang];
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [subTab, setSubTab] = useState<CamSubTab>("MATERIAL");
  const [liveCameraOpen, setLiveCameraOpen] = useState(false);

  const [estimatedKg, setEstimatedKg] = useState("15");
  const [declaredScaleKg, setDeclaredScaleKg] = useState("12.45");
  const [city, setCity] = useState("Ludhiana");
  const [visionResult, setVisionResult] = useState<Record<string, unknown> | null>(
    null
  );
  const [scaleResult, setScaleResult] = useState<Record<string, unknown> | null>(
    null
  );

  const [manualQrInput, setManualQrInput] = useState(
    "https://kabadiwala.local/verify/KC-COL-100101"
  );
  const [qrResult, setQrResult] = useState<QrResolutionResult | null>(null);
  const [xrayResult, setXrayResult] = useState<Record<string, unknown> | null>(
    null
  );
  const [assistantPrompt, setAssistantPrompt] = useState(
    "Mere paas 2 purane AC aur 15 kg tamba hai Ludhiana mein kitna milega?"
  );
  const [assistantReply, setAssistantReply] = useState<
    Record<string, unknown> | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [statusNote, setStatusNote] = useState<string | null>(null);

  async function processBase64Frame(base64Frame: string) {
    if (!actor) {
      setStatusNote(
        "Please sign in on the Account tab first (ai:scan capability required)."
      );
      return;
    }
    setBusy(true);
    setStatusNote(null);

    if (subTab === "MATERIAL") {
      const estGrams = Math.max(
        100,
        Math.round((parseFloat(estimatedKg) || 10) * 1000)
      );
      const res = await client.scanMaterialBase64({
        imageBase64: base64Frame,
        estimatedGrams: estGrams,
        city,
        language: lang,
      });
      setBusy(false);
      if (res.ok && res.data) {
        setVisionResult(res.data);
        const scripts =
          (res.data.vernacularAudioScripts as Record<string, string> | undefined) ??
          {};
        const script = scripts[lang] ?? scripts.EN;
        if (script) {
          await speakNativeVernacular(script, lang);
        }
      } else {
        setStatusNote(`Vision scan error: ${res.errorMessage}`);
      }
      return;
    }

    if (subTab === "XRAY") {
      const res = await client.scanApplianceXrayBase64({
        imageBase64: base64Frame,
      });
      setBusy(false);
      if (res.ok && res.data) {
        setXrayResult(res.data);
        const dev =
          (res.data.matchedDevice as Record<string, unknown> | undefined) ?? {};
        await speakNativeVernacular(
          `X-Ray matched ${String(dev.modelName ?? "device")}`,
          lang
        );
      } else {
        setStatusNote(`Appliance X-Ray error: ${res.errorMessage}`);
      }
      return;
    }

    if (subTab === "SCALE") {
      const declGrams = Math.max(
        50,
        Math.round((parseFloat(declaredScaleKg) || 12.45) * 1000)
      );
      const res = await client.scanScaleOcrBase64({
        imageBase64: base64Frame,
        declaredGrams: declGrams,
        language: lang,
      });
      setBusy(false);
      if (res.ok && res.data) {
        setScaleResult(res.data);
        const scripts =
          (res.data.vernacularAudioScripts as Record<string, string> | undefined) ??
          {};
        const script = scripts[lang] ?? scripts.EN;
        if (script) {
          await speakNativeVernacular(script, lang);
        }
      } else {
        setStatusNote(`Scale OCR error: ${res.errorMessage}`);
      }
    }
  }

  async function handleSnapFromNativeCamera() {
    if (!cameraRef.current) return;
    const photo = await cameraRef.current.takePictureAsync({
      quality: 0.72,
      base64: true,
    });
    if (photo?.base64) {
      setLiveCameraOpen(false);
      await processBase64Frame(photo.base64);
    }
  }

  async function handlePickFromGallery() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setStatusNote("Gallery permission is required to select a saved photo.");
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.75,
      base64: true,
    });
    if (!picked.canceled && picked.assets[0]?.base64) {
      await processBase64Frame(picked.assets[0].base64);
    }
  }

  async function handleHardwareSamplePreset(query: string) {
    setBusy(true);
    try {
      const b64 = await client.fetchSampleFrameBase64(query);
      await processBase64Frame(b64);
    } catch {
      setBusy(false);
      setStatusNote("Failed to fetch sample frame from API server.");
    }
  }

  async function handleResolveQr(rawData: string) {
    setBusy(true);
    const resolved = await client.resolveScannedQrPayload(rawData);
    setQrResult(resolved);
    setBusy(false);
    setLiveCameraOpen(false);
    await speakNativeVernacular(
      `QR scanned: ${resolved.kind.replace(/_/g, " ")} ${resolved.extractedKey}`,
      lang
    );
  }

  const detectedMat =
    (visionResult?.detectedMaterial as Record<string, unknown> | undefined) ?? {};
  const indicativeRange =
    (visionResult?.indicativeRange as Record<string, unknown> | undefined) ?? {};
  const antiFraud =
    (visionResult?.antiFraudForensics as Record<string, unknown> | undefined) ??
    {};

  return (
    <View style={styles.wrap}>
      <View style={styles.tabRow}>
        {(
          [
            ["MATERIAL", t.scanMaterialTab],
            ["SCALE", t.scanScaleTab],
            ["XRAY", "X-Ray"],
            ["AI_CHAT", "AI Chat"],
            ["QR", t.scanQrTab],
          ] as Array<[CamSubTab, string]>
        ).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setSubTab(key)}
            style={[styles.tabBtn, subTab === key ? styles.tabBtnActive : undefined]}
          >
            <Text
              style={[
                styles.tabText,
                subTab === key ? { color: "#ffffff" } : undefined,
              ]}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {statusNote ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{statusNote}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.title}>
          Native Android Camera & QR Lens ({subTab})
        </Text>
        {!liveCameraOpen ? (
          <View style={styles.row}>
            <Pressable
              onPress={async () => {
                if (!permission?.granted) {
                  await requestPermission();
                }
                setLiveCameraOpen(true);
              }}
              style={[styles.primaryBtn, { flex: 1 }]}
            >
              <Text style={styles.btnText}>📷 Open Live CameraView</Text>
            </Pressable>
            {subTab !== "QR" ? (
              <Pressable
                onPress={handlePickFromGallery}
                style={[styles.darkBtn, { flex: 1 }]}
              >
                <Text style={styles.btnText}>🖼️ Pick Photo</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <View style={styles.cameraContainer}>
            <CameraView
              ref={cameraRef}
              style={styles.cameraPreview}
              facing="back"
              barcodeScannerSettings={
                subTab === "QR" ? { barcodeTypes: ["qr"] } : undefined
              }
              onBarcodeScanned={
                subTab === "QR"
                  ? (scanningResult) => {
                      if (!busy && scanningResult.data) {
                        handleResolveQr(scanningResult.data);
                      }
                    }
                  : undefined
              }
            />
            <View style={styles.row}>
              {subTab !== "QR" ? (
                <Pressable
                  disabled={busy}
                  onPress={handleSnapFromNativeCamera}
                  style={[styles.primaryBtn, { flex: 1 }]}
                >
                  <Text style={styles.btnText}>Capture & Verify Frame</Text>
                </Pressable>
              ) : (
                <Text style={styles.meta}>
                  Point lens at any Kabadiwala QR sticker…
                </Text>
              )}
              <Pressable
                onPress={() => setLiveCameraOpen(false)}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryText}>Close Lens</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {subTab === "MATERIAL" ? (
        <View style={styles.card}>
          <Text style={styles.title}>
            Scrap Purity Forensics & Multi-Tier Valuation
          </Text>
          <View style={styles.row}>
            <TextInput
              value={estimatedKg}
              onChangeText={setEstimatedKg}
              keyboardType="decimal-pad"
              placeholder="Est kg"
              style={[styles.input, { flex: 1 }]}
            />
            <TextInput
              value={city}
              onChangeText={setCity}
              placeholder="City"
              style={[styles.input, { flex: 1 }]}
            />
          </View>
          <View style={styles.presetWrap}>
            {(
              [
                ["Clean Copper", "kind=copper-clean"],
                ["Mixed Cu+Al Heap (.onnx)", "kind=mixed-copper-aluminum"],
                ["Burnt Wire Fraud", "kind=copper-burnt-fraud"],
                ["Grade-A PCB", "kind=pcb-grade-a"],
                ["Wet Cardboard", "kind=cardboard-wet-fraud"],
              ] as Array<[string, string]>
            ).map(([label, q]) => (
              <Pressable
                key={q}
                disabled={busy}
                onPress={() => handleHardwareSamplePreset(q)}
                style={styles.presetChip}
              >
                <Text style={styles.presetText}>{label}</Text>
              </Pressable>
            ))}
          </View>

          {visionResult ? (
            <View style={styles.resultBox}>
              <Text style={styles.resultTitle}>
                {String(detectedMat.nameEn ?? detectedMat.slug ?? "Material")} (
                {String(detectedMat.coilMetalVerdict ?? "INSPECTED")})
              </Text>
              <Text style={styles.resultHighlight}>
                Indicative Estimate:{" "}
                {paiseToInrString(Number(indicativeRange.minPaise ?? 0))} –{" "}
                {paiseToInrString(Number(indicativeRange.maxPaise ?? 0))}
              </Text>
              <Text style={styles.meta}>
                Forensic Flags:{" "}
                {((antiFraud.fraudFlags as string[] | undefined) ?? []).join(
                  ", "
                ) || "CLEAN (No Adulteration / Replay)"}
              </Text>
              <Pressable
                onPress={async () => {
                  await client.confirmScan(String(visionResult.scanId));
                  setStatusNote("Human confirmation recorded on AIScanRecord!");
                }}
                style={styles.primaryBtn}
              >
                <Text style={styles.btnText}>
                  ✓ Human-Confirm Indicative Scan
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {subTab === "SCALE" ? (
        <View style={styles.card}>
          <Text style={styles.title}>7-Segment Digital Scale Anti-Fraud OCR</Text>
          <View style={styles.row}>
            <Text style={styles.meta}>Declared Weight (kg):</Text>
            <TextInput
              value={declaredScaleKg}
              onChangeText={setDeclaredScaleKg}
              keyboardType="decimal-pad"
              style={[styles.input, { flex: 1 }]}
            />
          </View>
          <View style={styles.presetWrap}>
            <Pressable
              disabled={busy}
              onPress={() =>
                handleHardwareSamplePreset("kind=scale&kg=12.45&led=RED")
              }
              style={styles.presetChip}
            >
              <Text style={styles.presetText}>Scan Honest 12.45 kg LED</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() =>
                handleHardwareSamplePreset("kind=scale&kg=12.45&led=LCD")
              }
              style={styles.presetChip}
            >
              <Text style={styles.presetText}>Monochrome LCD (.onnx)</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() =>
                handleHardwareSamplePreset("kind=scale&kg=12.45&led=PAPER_SLIP")
              }
              style={styles.presetChip}
            >
              <Text style={styles.presetText}>Thermal Slip (.onnx)</Text>
            </Pressable>
            <Pressable
              disabled={busy}
              onPress={() =>
                handleHardwareSamplePreset("kind=scale&kg=09.80&led=GREEN")
              }
              style={styles.presetChip}
            >
              <Text style={styles.presetText}>Scan Tampered 09.80 kg LED</Text>
            </Pressable>
          </View>

          {scaleResult ? (
            <View style={styles.resultBox}>
              <Text style={styles.resultTitle}>
                Scale Readout:{" "}
                {(Number(scaleResult.scaleReadGrams ?? 0) / 1000).toFixed(2)} kg (
                {String(scaleResult.verdictStatus ?? "")})
              </Text>
              <Text
                style={[
                  styles.resultHighlight,
                  scaleResult.ocrDiscrepancyFlag ? { color: "#b91c1c" } : undefined,
                ]}
              >
                {scaleResult.ocrDiscrepancyFlag
                  ? "⚠️ SCALE WEIGHT MISMATCH FLAGGED!"
                  : "✅ VERIFIED: Scale Display Matches Declared Weight"}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {subTab === "XRAY" ? (
        <View style={styles.card}>
          <Text style={styles.title}>
            Multi-Task 2D CNN Camera Appliance X-Ray (.onnx)
          </Text>
          <View style={styles.presetWrap}>
            {(
              [
                ["Split AC (Copper)", "kind=xray-split-ac-copper"],
                ["Split AC (Alum)", "kind=xray-split-ac-aluminum"],
                ["5G Smartphone", "kind=xray-smartphone"],
                ["14in Laptop", "kind=xray-laptop"],
                ["Ceiling Fan", "kind=xray-ceiling-fan"],
              ] as Array<[string, string]>
            ).map(([lbl, q]) => (
              <Pressable
                key={q}
                disabled={busy}
                onPress={() => handleHardwareSamplePreset(q)}
                style={styles.presetChip}
              >
                <Text style={styles.presetText}>{lbl}</Text>
              </Pressable>
            ))}
          </View>
          {xrayResult ? (
            <View style={styles.resultBox}>
              <Text style={styles.resultTitle}>
                {String(
                  (xrayResult.matchedDevice as Record<string, unknown>)
                    ?.modelName ?? ""
                )}
              </Text>
              <Text style={styles.resultHighlight}>
                Parts Harvest:{" "}
                {String(
                  (
                    (xrayResult.indicativePathways as Record<string, unknown>)
                      ?.partsHarvest as Record<string, unknown>
                  )?.displayRangeInr ?? ""
                )}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {subTab === "AI_CHAT" ? (
        <View style={styles.card}>
          <Text style={styles.title}>
            Vernacular AI Kabadi Assistant (HI / PA / MR / EN)
          </Text>
          <TextInput
            value={assistantPrompt}
            onChangeText={setAssistantPrompt}
            multiline
            style={styles.input}
          />
          <Pressable
            disabled={busy}
            onPress={async () => {
              setBusy(true);
              const r = await client.askVernacularAssistant({
                message: assistantPrompt,
                language: lang,
              });
              setBusy(false);
              if (r.ok && r.data) {
                setAssistantReply(r.data);
                await speakNativeVernacular(
                  String(r.data.replyText ?? ""),
                  lang
                );
              }
            }}
            style={styles.primaryBtn}
          >
            <Text style={styles.btnText}>Ask Self-Hosted ONNX AI</Text>
          </Pressable>
          {assistantReply ? (
            <View style={styles.resultBox}>
              <Text style={styles.resultTitle}>
                Intent: {String(assistantReply.intent)} (
                {String(assistantReply.detectedLanguage)})
              </Text>
              <Text style={styles.meta}>
                {String(assistantReply.replyText ?? "")}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {subTab === "QR" ? (
        <View style={styles.card}>
          <Text style={styles.title}>Public QR Badge & Bale Lineage Scanner</Text>
          <TextInput
            value={manualQrInput}
            onChangeText={setManualQrInput}
            autoCapitalize="none"
            style={styles.input}
          />
          <View style={styles.presetWrap}>
            <Pressable
              onPress={() => handleResolveQr(manualQrInput)}
              style={styles.primaryBtn}
            >
              <Text style={[styles.btnText, { paddingHorizontal: 12 }]}>
                Resolve QR Payload Live
              </Text>
            </Pressable>
            <Pressable
              onPress={() =>
                handleResolveQr(
                  "upi://pay?pa=gillkabadi@upi&pn=Gill%20Kabadi&am=620.00&cu=INR"
                )
              }
              style={styles.presetChip}
            >
              <Text style={styles.presetText}>Test UPI QR</Text>
            </Pressable>
          </View>

          {qrResult ? (
            <View style={styles.resultBox}>
              <Text style={styles.resultTitle}>
                Type: {qrResult.kind} ({qrResult.extractedKey})
              </Text>
              {qrResult.upiUri ? (
                <Pressable
                  onPress={() =>
                    Linking.openURL(qrResult.upiUri!).catch(() => {})
                  }
                  style={styles.primaryBtn}
                >
                  <Text style={styles.btnText}>Launch UPI App</Text>
                </Pressable>
              ) : (
                <Text style={styles.codeBlock}>
                  {JSON.stringify(qrResult.serverData ?? {}, null, 2)}
                </Text>
              )}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  tabRow: { flexDirection: "row", gap: 6 },
  tabBtn: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: "center",
  },
  tabBtnActive: { backgroundColor: "#047857", borderColor: "#047857" },
  tabText: { fontSize: 11, fontWeight: "800", color: "#334155" },
  notice: {
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#93c5fd",
    borderRadius: 12,
    padding: 11,
  },
  noticeText: { color: "#1e3a8a", fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 10,
  },
  title: { fontSize: 15, fontWeight: "800", color: "#0f172a" },
  meta: { fontSize: 12, color: "#64748b", fontWeight: "600" },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: "#f8fafc",
  },
  cameraContainer: { gap: 8 },
  cameraPreview: {
    height: 220,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#0f172a",
  },
  primaryBtn: {
    backgroundColor: "#047857",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  darkBtn: {
    backgroundColor: "#0f172a",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryBtn: {
    backgroundColor: "#f1f5f9",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryText: { fontSize: 12, fontWeight: "700", color: "#334155" },
  btnText: { color: "#ffffff", fontWeight: "800", fontSize: 12 },
  presetWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  presetChip: {
    backgroundColor: "#ecfdf5",
    borderWidth: 1,
    borderColor: "#6ee7b7",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  presetText: { color: "#065f46", fontSize: 11, fontWeight: "800" },
  resultBox: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  resultTitle: { fontSize: 14, fontWeight: "800", color: "#0f172a" },
  resultHighlight: { fontSize: 15, fontWeight: "900", color: "#047857" },
  codeBlock: { fontSize: 11, fontFamily: "monospace", color: "#334155" },
});
