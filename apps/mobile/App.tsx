import React, { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SUPPORTED_LANGUAGES, SupportedLanguage } from "@kabadi/shared";
import { MobileActorProfile, MobileApiClient } from "./src/api/mobileClient";
import { MOBILE_STRINGS } from "./src/i18n/vernacular";
import { OfflineSyncQueue, QueuedSyncOperation } from "./src/offline/syncQueue";
import { AuthScreen } from "./src/screens/AuthScreen";
import { RatesAndBiddingScreen } from "./src/screens/RatesAndBiddingScreen";
import { BinsKhataOrdersScreen } from "./src/screens/BinsKhataOrdersScreen";
import { CameraAndQrScannerScreen } from "./src/screens/CameraAndQrScannerScreen";
import { OfflineSyncScreen } from "./src/screens/OfflineSyncScreen";

type BottomTab = "AUTH" | "MARKET" | "OPS" | "CAMERA" | "SYNC";

const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:4000";

export default function App() {
  const [lang, setLang] = useState<SupportedLanguage>("EN");
  const [tab, setTab] = useState<BottomTab>("MARKET");
  const [apiBaseUrl, setApiBaseUrl] = useState<string>(DEFAULT_API_URL);
  const [actor, setActor] = useState<MobileActorProfile | null>(null);
  const [pendingCount, setPendingCount] = useState<number>(0);

  const client = useMemo(() => new MobileApiClient(apiBaseUrl), [apiBaseUrl]);
  const sqliteQueue = useMemo(() => new OfflineSyncQueue(), []);

  useEffect(() => {
    sqliteQueue.hydrateFromDisk().then((items) => {
      setPendingCount(items.filter((i) => i.syncStatus === "PENDING").length);
    });
    client.getMe().then((res) => {
      if (res.ok && res.data?.user) {
        setActor(res.data.user);
      }
    });
  }, [client, sqliteQueue]);

  const t = MOBILE_STRINGS[lang];

  function handleQueueChanged(items: readonly QueuedSyncOperation[]) {
    setPendingCount(items.filter((i) => i.syncStatus === "PENDING").length);
  }

  return (
    <SafeAreaView style={styles.root}>
      {/* Top Vernacular Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.brand}>{t.appName}</Text>
            <Text style={styles.subBrand}>{t.tagline}</Text>
          </View>
          <View style={styles.langRow}>
            {SUPPORTED_LANGUAGES.map((code) => (
              <Pressable
                key={code}
                onPress={() => setLang(code)}
                style={[styles.langBtn, lang === code && styles.langBtnActive]}
              >
                <Text
                  style={[
                    styles.langText,
                    lang === code && styles.langTextActive,
                  ]}
                >
                  {code}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View style={styles.endpointBar}>
          <Text style={styles.endpointLabel}>API:</Text>
          <TextInput
            value={apiBaseUrl}
            onChangeText={(next) => {
              setApiBaseUrl(next);
              client.setApiBaseUrl(next);
            }}
            autoCapitalize="none"
            style={styles.endpointInput}
          />
          <Text style={styles.userChip}>
            {actor ? `${actor.role.slice(0, 6)} ✓` : "Guest"}
          </Text>
        </View>
      </View>

      {/* Active Screen Viewport */}
      <ScrollView contentContainerStyle={styles.content}>
        {tab === "AUTH" ? (
          <AuthScreen
            client={client}
            actor={actor}
            lang={lang}
            onAuthenticated={(profile) => {
              setActor(profile);
              setTab("MARKET");
            }}
            onLoggedOut={() => setActor(null)}
          />
        ) : null}

        {tab === "MARKET" ? (
          <RatesAndBiddingScreen client={client} actor={actor} lang={lang} />
        ) : null}

        {tab === "OPS" ? (
          <BinsKhataOrdersScreen client={client} actor={actor} lang={lang} />
        ) : null}

        {tab === "CAMERA" ? (
          <CameraAndQrScannerScreen client={client} actor={actor} lang={lang} />
        ) : null}

        {tab === "SYNC" ? (
          <OfflineSyncScreen
            queue={sqliteQueue}
            apiBaseUrl={apiBaseUrl}
            actor={actor}
            lang={lang}
            onQueueChanged={handleQueueChanged}
          />
        ) : null}
      </ScrollView>

      {/* Bottom 5-Tab Field Navigation Bar */}
      <View style={styles.bottomBar}>
        {(
          [
            ["AUTH", "🔐", t.navAuth],
            ["MARKET", "⚖️", t.navMarket],
            ["OPS", "🧾", t.navOps],
            ["CAMERA", "📷", t.navCamera],
            [
              "SYNC",
              "⚡",
              pendingCount > 0 ? `${t.navSync} (${pendingCount})` : t.navSync,
            ],
          ] as Array<[BottomTab, string, string]>
        ).map(([id, icon, label]) => {
          const active = tab === id;
          return (
            <Pressable
              key={id}
              onPress={() => setTab(id)}
              style={[styles.navItem, active && styles.navItemActive]}
            >
              <Text style={styles.navIcon}>{icon}</Text>
              <Text style={[styles.navLabel, active && styles.navLabelActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f1f5f9" },
  header: {
    backgroundColor: "#065f46",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  brand: { color: "#ffffff", fontSize: 16, fontWeight: "800" },
  subBrand: { color: "#a7f3d0", fontSize: 10 },
  langRow: { flexDirection: "row", gap: 4 },
  langBtn: {
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#047857",
  },
  langBtnActive: { backgroundColor: "#ffffff" },
  langText: { color: "#ecfdf5", fontSize: 10, fontWeight: "800" },
  langTextActive: { color: "#065f46" },
  endpointBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#047857",
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  endpointLabel: { color: "#a7f3d0", fontSize: 10, fontWeight: "800" },
  endpointInput: {
    flex: 1,
    color: "#ffffff",
    fontSize: 11,
    paddingVertical: 2,
  },
  userChip: {
    backgroundColor: "#022c22",
    color: "#6ee7b7",
    fontSize: 10,
    fontWeight: "800",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  content: { padding: 14, paddingBottom: 28 },
  bottomBar: {
    flexDirection: "row",
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#cbd5e1",
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 5,
    borderRadius: 10,
  },
  navItemActive: { backgroundColor: "#ecfdf5" },
  navIcon: { fontSize: 15 },
  navLabel: { fontSize: 10, fontWeight: "700", color: "#64748b", marginTop: 2 },
  navLabelActive: { color: "#047857", fontWeight: "800" },
});
