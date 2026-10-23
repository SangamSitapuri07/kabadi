import React, { useCallback, useEffect, useState } from "react";
import {
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { paiseToInrString, SupportedLanguage } from "@kabadi/shared";
import { MobileActorProfile, MobileApiClient } from "../api/mobileClient";
import { MOBILE_STRINGS, speakNativeVernacular } from "../i18n/vernacular";

interface Props {
  client: MobileApiClient;
  actor: MobileActorProfile | null;
  lang: SupportedLanguage;
}

export function BinsKhataOrdersScreen({ client, actor, lang }: Props) {
  const t = MOBILE_STRINGS[lang];
  const [bins, setBins] = useState<Array<Record<string, unknown>>>([]);
  const [storefronts, setStorefronts] = useState<Array<Record<string, unknown>>>([]);
  const [khataEntries, setKhataEntries] = useState<Array<Record<string, unknown>>>([]);
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [selectedBuyerSfId, setSelectedBuyerSfId] = useState<string>("");
  const [activeSlip, setActiveSlip] = useState<{
    slipNumber: string;
    upiIntentUri: string;
    grossAmountPaise: number;
    khataAdvanceOffsetPaise: number;
    netPayablePaise: number;
    receiptDigestSha256: string;
  } | null>(null);
  const [verifiedKgInput, setVerifiedKgInput] = useState("10.0");
  const [feedback, setFeedback] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const sfRes = await client.listStorefronts();
    if (sfRes.ok && sfRes.data?.storefronts) {
      setStorefronts(sfRes.data.storefronts);
      if (!selectedBuyerSfId && sfRes.data.storefronts.length > 0) {
        setSelectedBuyerSfId(String(sfRes.data.storefronts[0]!.id));
      }
    }
    if (!actor) return;

    const [binsRes, khataRes, ordersRes] = await Promise.all([
      client.listBins(),
      client.listKhataEntries(),
      client.listOrders(),
    ]);
    if (binsRes.ok && binsRes.data?.bins) setBins(binsRes.data.bins);
    if (khataRes.ok && khataRes.data?.entries) {
      setKhataEntries(khataRes.data.entries);
    }
    if (ordersRes.ok && ordersRes.data?.orders) setOrders(ordersRes.data.orders);
  }, [actor, client, selectedBuyerSfId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleSellBin(bin: Record<string, unknown>) {
    const availGrams = Number(bin.availableGrams ?? 0);
    if (!selectedBuyerSfId || availGrams <= 0) return;
    const res = await client.sellBinUpward({
      binId: String(bin.id),
      sellGrams: availGrams,
      targetStorefrontId: selectedBuyerSfId,
      fulfillmentMode: "SELLER_DROPOFF",
    });
    if (res.ok) {
      setFeedback("Stock bin sold upward with automatic BatchLineage genealogy!");
      await reload();
    } else {
      setFeedback(`Upward sale rejected: ${res.errorMessage}`);
    }
  }

  async function handleWeighAndSettle(order: Record<string, unknown>) {
    const orderId = String(order.id);
    const items = (order.items as Array<Record<string, unknown>> | undefined) ?? [];
    if (items.length === 0) return;

    const actualGrams = Math.max(
      100,
      Math.round((parseFloat(verifiedKgInput) || 10) * 1000)
    );
    await client.acceptOrder(orderId).catch(() => undefined);

    const res = await client.weighAndSettleOrder({
      orderId,
      items: [{ orderItemId: String(items[0]!.id), actualGrams }],
      adjustmentPaise: 0,
      autoOffsetKhataAdvance: true,
    });
    if (res.ok) {
      await handleViewSlip(orderId);
      setFeedback("Order weighed & settled with automatic Peshgi Khata offset!");
      await reload();
    } else {
      setFeedback(`Weigh & settle error: ${res.errorMessage}`);
    }
  }

  async function handleViewSlip(orderId: string) {
    const slipRes = await client.getSettlementSlip(orderId);
    if (slipRes.ok && slipRes.data?.slip) {
      const s = slipRes.data.slip;
      setActiveSlip({
        slipNumber: s.slipNumber,
        upiIntentUri: s.upi.upiIntentUri,
        grossAmountPaise: s.totals.grossAmountPaise,
        khataAdvanceOffsetPaise: s.totals.khataAdvanceOffsetPaise,
        netPayablePaise: s.totals.netPayablePaise,
        receiptDigestSha256: s.receiptDigestSha256,
      });
      await speakNativeVernacular(
        `Net payout ${s.totals.netPayableExactInr} rupees ready via UPI.`,
        lang
      );
    } else {
      setFeedback(`Slip error: ${slipRes.errorMessage}`);
    }
  }

  if (!actor) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Sign In Required for Bins, Khata & Orders</Text>
        <Text style={styles.meta}>
          Switch to the Account tab and tap any Tier (T0–T4) or sign in via Mobile
          OTP to manage stock bins, peshgi advances, and UPI settlement slips.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {feedback ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{feedback}</Text>
        </View>
      ) : null}

      {activeSlip ? (
        <View
          style={[
            styles.card,
            { backgroundColor: "#0f172a", borderColor: "#10b981" },
          ]}
        >
          <Text style={styles.slipBadge}>
            THERMAL HANDOVER SLIP · {activeSlip.slipNumber}
          </Text>
          <Text style={styles.slipAmount}>
            Net Payable: {paiseToInrString(activeSlip.netPayablePaise)}
          </Text>
          <Text style={styles.slipMeta}>
            Gross {paiseToInrString(activeSlip.grossAmountPaise)} − Khata Offset{" "}
            {paiseToInrString(activeSlip.khataAdvanceOffsetPaise)}
          </Text>
          <Text style={styles.upiCode} selectable>
            {activeSlip.upiIntentUri}
          </Text>
          <Pressable
            onPress={() =>
              Linking.openURL(activeSlip.upiIntentUri).catch(() => {})
            }
            style={styles.upiBtn}
          >
            <Text style={styles.upiBtnText}>
              ⚡ {t.openUpiBtn} (GPay / PhonePe / BHIM)
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* 1. Stock Bins & Upward Sale */}
      <View style={styles.card}>
        <Text style={styles.title}>Segregated Stock Bins ({bins.length})</Text>
        <View style={styles.sfChipWrap}>
          {storefronts.map((sf) => {
            const id = String(sf.id);
            const active = id === selectedBuyerSfId;
            return (
              <Pressable
                key={id}
                onPress={() => setSelectedBuyerSfId(id)}
                style={[styles.sfChip, active ? styles.sfChipActive : undefined]}
              >
                <Text
                  style={[
                    styles.sfChipText,
                    active ? { color: "#ffffff" } : undefined,
                  ]}
                >
                  {String(sf.shopTitle ?? "Storefront")}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {bins.map((bin) => (
          <View key={String(bin.id)} style={styles.subCard}>
            <Text style={styles.itemTitle}>
              {String(
                ((bin.material as Record<string, unknown> | undefined)
                  ?.nameEn as string) ?? "Stock Bin"
              )}{" "}
              · {(Number(bin.availableGrams ?? 0) / 1000).toFixed(2)} kg available
            </Text>
            <Pressable
              onPress={() => handleSellBin(bin)}
              style={styles.primaryBtn}
            >
              <Text style={styles.btnText}>Sell Upward to Selected Buyer</Text>
            </Pressable>
          </View>
        ))}
      </View>

      {/* 2. Morning Peshgi Khata Ledger */}
      <View style={styles.card}>
        <Text style={styles.title}>
          Morning Peshgi Khata Ledger ({khataEntries.length})
        </Text>
        {khataEntries.slice(0, 5).map((entry) => (
          <View key={String(entry.id)} style={styles.subCard}>
            <Text style={styles.itemTitle}>
              {String(entry.entryType ?? "ENTRY")} ·{" "}
              {paiseToInrString(Number(entry.amountPaise ?? 0))}
            </Text>
            <Text style={styles.meta}>
              Running Balance:{" "}
              {paiseToInrString(Number(entry.balanceAfterPaise ?? 0))}
            </Text>
          </View>
        ))}
      </View>

      {/* 3. Active Orders & UPI Handover Slips */}
      <View style={styles.card}>
        <Text style={styles.title}>
          Orders, Weighing & UPI Slips ({orders.length})
        </Text>
        <View style={styles.row}>
          <Text style={styles.meta}>Actual Scale Weight (kg):</Text>
          <TextInput
            value={verifiedKgInput}
            onChangeText={setVerifiedKgInput}
            keyboardType="decimal-pad"
            style={styles.smallInput}
          />
        </View>
        {orders.slice(0, 8).map((ord) => {
          const ordId = String(ord.id);
          const status = String(ord.status ?? "");
          return (
            <View key={ordId} style={styles.subCard}>
              <Text style={styles.itemTitle}>
                {String(ord.orderNumber ?? ordId.slice(0, 8))} · {status}
              </Text>
              <Text style={styles.meta}>
                Final/Agreed:{" "}
                {paiseToInrString(
                  Number(ord.finalTotalPaise ?? ord.agreedTotalPaise ?? 0)
                )}
              </Text>
              {status === "COMPLETED" ? (
                <Pressable
                  onPress={() => handleViewSlip(ordId)}
                  style={styles.darkBtn}
                >
                  <Text style={styles.btnText}>Open UPI Settlement Slip</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => handleWeighAndSettle(ord)}
                  style={styles.primaryBtn}
                >
                  <Text style={styles.btnText}>
                    {t.weighSettleBtn} ({verifiedKgInput} kg)
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 14 },
  banner: {
    backgroundColor: "#ecfdf5",
    borderWidth: 1,
    borderColor: "#6ee7b7",
    borderRadius: 12,
    padding: 12,
  },
  bannerText: { color: "#065f46", fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 10,
  },
  subCard: {
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    padding: 11,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 6,
  },
  title: { fontSize: 15, fontWeight: "800", color: "#0f172a" },
  itemTitle: { fontSize: 13, fontWeight: "800", color: "#1e293b" },
  meta: { fontSize: 12, color: "#64748b", fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  smallInput: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 75,
    fontWeight: "700",
    backgroundColor: "#f8fafc",
  },
  sfChipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  sfChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#f8fafc",
  },
  sfChipActive: { backgroundColor: "#047857", borderColor: "#047857" },
  sfChipText: { fontSize: 11, fontWeight: "700", color: "#334155" },
  primaryBtn: {
    backgroundColor: "#047857",
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: "center",
  },
  darkBtn: {
    backgroundColor: "#0f172a",
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: "center",
  },
  btnText: { color: "#ffffff", fontWeight: "800", fontSize: 12 },
  slipBadge: {
    color: "#34d399",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  slipAmount: { color: "#ffffff", fontSize: 20, fontWeight: "900" },
  slipMeta: { color: "#cbd5e1", fontSize: 12 },
  upiCode: {
    color: "#fde68a",
    fontSize: 11,
    fontFamily: "monospace",
    backgroundColor: "#1e293b",
    padding: 8,
    borderRadius: 8,
  },
  upiBtn: {
    backgroundColor: "#10b981",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  upiBtnText: { color: "#022c22", fontWeight: "900", fontSize: 13 },
});
