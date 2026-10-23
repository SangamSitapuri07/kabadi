import React, { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SupportedLanguage } from "@kabadi/shared";
import { MobileActorProfile, MobileApiClient } from "../api/mobileClient";

interface AuthScreenProps {
  client: MobileApiClient;
  actor: MobileActorProfile | null;
  lang: SupportedLanguage;
  onAuthenticated: (profile: MobileActorProfile) => void;
  onLoggedOut: () => void;
}

const DEMO_ACCOUNTS: Array<{ label: string; identifier: string; tier: string }> = [
  {
    label: "Tier 0 Household (Customer)",
    identifier: "customer@kabadiwala.local",
    tier: "T0",
  },
  {
    label: "Tier 1 Local Collector (Raju Ward 4)",
    identifier: "collector@kabadiwala.local",
    tier: "T1",
  },
  {
    label: "Tier 2 Area Kabadi Shop (Gill Road)",
    identifier: "shop@kabadiwala.local",
    tier: "T2",
  },
  {
    label: "Tier 3 Wholesale Mandi (Aggregator)",
    identifier: "wholesale@kabadiwala.local",
    tier: "T3",
  },
  {
    label: "Tier 4 CPCB Authorized Recycler",
    identifier: "recycler@kabadiwala.local",
    tier: "T4",
  },
];

export function AuthScreen({
  client,
  actor,
  onAuthenticated,
  onLoggedOut,
}: AuthScreenProps) {
  const [phone, setPhone] = useState("+919815000101");
  const [otpCode, setOtpCode] = useState("");
  const [identifier, setIdentifier] = useState("collector@kabadiwala.local");
  const [password, setPassword] = useState("KabadiPass123");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleRequestOtp() {
    setBusy(true);
    setStatusMsg(null);
    const res = await client.requestPhoneOtpLogin(phone);
    setBusy(false);
    if (res.ok && res.data) {
      if (res.data.devPreviewOtp) {
        setOtpCode(res.data.devPreviewOtp);
        setStatusMsg(
          `OTP sent (Sandbox preview code auto-filled: ${res.data.devPreviewOtp})`
        );
      } else {
        setStatusMsg(`6-digit OTP sent to ${phone} (if registered & active).`);
      }
    } else {
      setStatusMsg(`OTP error: ${res.errorMessage ?? "Network unreachable"}`);
    }
  }

  async function handleVerifyOtp() {
    setBusy(true);
    setStatusMsg(null);
    const res = await client.verifyPhoneOtpLogin(phone, otpCode.trim());
    setBusy(false);
    if (res.ok && res.data?.user) {
      onAuthenticated(res.data.user);
      setStatusMsg(
        `Signed in via Mobile OTP (${res.data.user.platformCode}) — Android Keystore active!`
      );
    } else {
      setStatusMsg(`OTP verify failed: ${res.errorMessage ?? "Invalid code"}`);
    }
  }

  async function handleCredentialsLogin(targetId = identifier) {
    setBusy(true);
    setStatusMsg(null);
    const res = await client.loginWithCredentials(targetId, password);
    setBusy(false);
    if (res.ok && res.data?.user) {
      setIdentifier(targetId);
      onAuthenticated(res.data.user);
      setStatusMsg(
        `Signed in as ${
          res.data.user.profile?.displayName ?? res.data.user.platformCode
        } (${res.data.user.tier}) — SecureStore active!`
      );
    } else {
      setStatusMsg(`Sign-in failed: ${res.errorMessage ?? "Check API URL"}`);
    }
  }

  return (
    <View style={styles.wrap}>
      {actor ? (
        <View
          style={[
            styles.card,
            { borderColor: "#86efac", backgroundColor: "#f0fdf4" },
          ]}
        >
          <Text style={styles.badge}>ANDROID KEYSTORE SESSION ACTIVE</Text>
          <Text style={styles.actorName}>
            {actor.profile?.displayName ?? actor.platformCode}
          </Text>
          <Text style={styles.meta}>
            {actor.tier} · {actor.platformCode} · {actor.verificationLevel}
          </Text>
          <Text style={styles.metaSmall}>
            Access & Refresh tokens encrypted via expo-secure-store
            (WHEN_UNLOCKED_THIS_DEVICE_ONLY) with automatic HTTP 401 rotation.
          </Text>
          <Pressable
            onPress={async () => {
              await client.logout();
              onLoggedOut();
              setStatusMsg("Hardware Keystore session revoked & wiped.");
            }}
            style={styles.logoutBtn}
          >
            <Text style={styles.logoutText}>Sign Out & Wipe Keystore Tokens</Text>
          </Pressable>
        </View>
      ) : null}

      {statusMsg ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{statusMsg}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          1. Passwordless Mobile Phone OTP Login
        </Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="+919815000101"
          keyboardType="phone-pad"
          style={styles.input}
        />
        <View style={styles.row}>
          <Pressable
            disabled={busy}
            onPress={handleRequestOtp}
            style={styles.secondaryBtn}
          >
            <Text style={styles.secondaryBtnText}>Send 6-Digit OTP</Text>
          </Pressable>
          <TextInput
            value={otpCode}
            onChangeText={setOtpCode}
            placeholder="6-digit OTP"
            keyboardType="number-pad"
            maxLength={6}
            style={[styles.input, { flex: 1 }]}
          />
        </View>
        <Pressable
          disabled={busy || otpCode.trim().length < 6}
          onPress={handleVerifyOtp}
          style={[
            styles.primaryBtn,
            otpCode.trim().length < 6 ? { opacity: 0.55 } : undefined,
          ]}
        >
          <Text style={styles.primaryBtnText}>Verify OTP & Unlock Keystore</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>
          2. Instant 5-Tier Supply-Chain Switcher (T0 → T4)
        </Text>
        <View style={styles.tierGrid}>
          {DEMO_ACCOUNTS.map((acct) => (
            <Pressable
              key={acct.identifier}
              disabled={busy}
              onPress={() => handleCredentialsLogin(acct.identifier)}
              style={styles.tierBtn}
            >
              <Text style={styles.tierPill}>{acct.tier}</Text>
              <Text style={styles.tierLabel}>{acct.label}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          value={identifier}
          onChangeText={setIdentifier}
          autoCapitalize="none"
          placeholder="Email or +91 Phone"
          style={styles.input}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Password"
          style={styles.input}
        />
        <Pressable
          disabled={busy}
          onPress={() => handleCredentialsLogin(identifier)}
          style={styles.darkBtn}
        >
          <Text style={styles.primaryBtnText}>Sign In with Credentials</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 10,
  },
  badge: {
    fontSize: 10,
    fontWeight: "800",
    color: "#15803d",
    letterSpacing: 0.6,
  },
  actorName: { fontSize: 18, fontWeight: "800", color: "#0f172a" },
  meta: { fontSize: 12, fontWeight: "700", color: "#334155" },
  metaSmall: { fontSize: 12, color: "#64748b", lineHeight: 17 },
  sectionTitle: { fontSize: 15, fontWeight: "800", color: "#0f172a" },
  input: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#0f172a",
    backgroundColor: "#f8fafc",
  },
  row: { flexDirection: "row", gap: 8, alignItems: "center" },
  primaryBtn: {
    backgroundColor: "#047857",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  darkBtn: {
    backgroundColor: "#0f172a",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryBtnText: { color: "#ffffff", fontWeight: "800", fontSize: 14 },
  secondaryBtn: {
    backgroundColor: "#ecfdf5",
    borderWidth: 1,
    borderColor: "#6ee7b7",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  secondaryBtnText: { color: "#047857", fontWeight: "800", fontSize: 12 },
  logoutBtn: {
    backgroundColor: "#fee2e2",
    borderRadius: 10,
    paddingVertical: 9,
    alignItems: "center",
  },
  logoutText: { color: "#b91c1c", fontWeight: "800", fontSize: 12 },
  notice: {
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#93c5fd",
    borderRadius: 12,
    padding: 12,
  },
  noticeText: { color: "#1e3a8a", fontSize: 12, fontWeight: "600" },
  tierGrid: { gap: 7 },
  tierBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  tierPill: {
    backgroundColor: "#065f46",
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 11,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  tierLabel: { fontSize: 12, fontWeight: "700", color: "#1e293b", flexShrink: 1 },
});
