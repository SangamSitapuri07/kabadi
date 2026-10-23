import React, { useCallback, useEffect, useState } from "react";
import {
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

export function RatesAndBiddingScreen({ client, actor, lang }: Props) {
  const t = MOBILE_STRINGS[lang];
  const [storefronts, setStorefronts] = useState<Array<Record<string, unknown>>>([]);
  const [listings, setListings] = useState<Array<Record<string, unknown>>>([]);
  const [spreads, setSpreads] = useState<Array<Record<string, unknown>>>([]);
  const [weightKg, setWeightKg] = useState("12");
  const [offerTotalRupees, setOfferTotalRupees] = useState("7800");
  const [feedback, setFeedback] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [sfRes, trendRes] = await Promise.all([
      client.listStorefronts(),
      client.getPriceTrends("metal-copper-bright"),
    ]);
    if (sfRes.ok && sfRes.data?.storefronts) {
      setStorefronts(sfRes.data.storefronts);
    }
    if (trendRes.ok && trendRes.data?.tierArbitrageSpreads) {
      setSpreads(trendRes.data.tierArbitrageSpreads);
    }
    if (actor) {
      const openRes = await client.listOpenListings();
      if (openRes.ok && openRes.data?.listings) {
        setListings(openRes.data.listings);
      }
    }
  }, [actor, client]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function speakStorefrontRates(sf: Record<string, unknown>) {
    const sfId = String(sf.id);
    const speechRes = await client.getStorefrontSpeechScript(sfId, lang);
    if (speechRes.ok && speechRes.data?.script) {
      await speakNativeVernacular(speechRes.data.script, lang);
      setFeedback(`🔊 Speaking ${lang} rate card via native expo-speech!`);
      return;
    }

    const rates = (sf.rateItems as Array<Record<string, unknown>> | undefined) ?? [];
    const fallback = rates
      .slice(0, 3)
      .map((r) => {
        const mat = (r.material as Record<string, unknown> | undefined) ?? {};
        return `${String(mat.nameEn ?? "Scrap")} ${paiseToInrString(
          Number(r.dropoffRatePaise ?? 0)
        )} per kilo`;
      })
      .join(". ");
    await speakNativeVernacular(fallback, lang);
    setFeedback(`🔊 Speaking offline rate card via native expo-speech!`);
  }

  async function handleBookOrder(sfId: string, materialSlug: string) {
    if (!actor) {
      setFeedback("Sign in on the Account tab first to book a drop-off/pickup order.");
      return;
    }
    const grams = Math.max(500, Math.round((parseFloat(weightKg) || 10) * 1000));
    const res = await client.createListingOrOrder({
      title: `Mobile Field Lot (${(grams / 1000).toFixed(1)} kg ${materialSlug})`,
      pickupPincode: "141003",
      pickupAddressPrivate: "Field Collection Point, Ludhiana",
      preferredMode: "SELLER_DROPOFF",
      targetStorefrontId: sfId,
      items: [{ materialSlug, estimatedGrams: grams }],
    });
    if (res.ok && res.data?.order) {
      setFeedback(
        `Order booked! #${String(res.data.order.orderNumber ?? "CREATED")}`
      );
    } else {
      setFeedback(`Order error: ${res.errorMessage}`);
    }
  }

  async function handlePlaceOffer(listingId: string) {
    if (!actor) {
      setFeedback("Sign in as Tier 1–4 buyer to place competitive bids.");
      return;
    }
    const totalPaise = Math.round((parseFloat(offerTotalRupees) || 1000) * 100);
    const res = await client.placeOffer(
      listingId,
      totalPaise,
      "Instant mobile pickup offer"
    );
    if (res.ok) {
      setFeedback(`Offer submitted: ${paiseToInrString(totalPaise)} total!`);
      await reload();
    } else {
      setFeedback(`Offer rejected: ${res.errorMessage}`);
    }
  }

  return (
    <View style={styles.wrap}>
      {feedback ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{feedback}</Text>
        </View>
      ) : null}

      {spreads.length > 0 ? (
        <View style={styles.trendCard}>
          <Text style={styles.badge}>
            MULTI-TIER ARBITRAGE · BRIGHT COPPER WIRE
          </Text>
          {spreads.slice(0, 3).map((sp, idx) => (
            <Text key={idx} style={styles.trendText}>
              {String(sp.tier ?? `Tier ${idx + 1}`)}: Avg{" "}
              {paiseToInrString(Number(sp.avgDropoffRatePaise ?? sp.ratePaise ?? 0))}
              /kg
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.title}>
            Multi-Tier Storefronts ({storefronts.length})
          </Text>
          <Pressable onPress={reload} style={styles.refreshBtn}>
            <Text style={styles.refreshText}>Refresh</Text>
          </Pressable>
        </View>

        <View style={styles.row}>
          <Text style={styles.label}>Lot Weight (kg):</Text>
          <TextInput
            value={weightKg}
            onChangeText={setWeightKg}
            keyboardType="decimal-pad"
            style={styles.smallInput}
          />
        </View>

        {storefronts.map((sf) => {
          const sfId = String(sf.id);
          const org =
            (sf.organization as Record<string, unknown> | undefined) ?? {};
          const rates =
            (sf.rateItems as Array<Record<string, unknown>> | undefined) ?? [];
          return (
            <View key={sfId} style={styles.subCard}>
              <Text style={styles.shopTitle}>
                {String(sf.shopTitle ?? org.businessName ?? "Storefront")}
              </Text>
              <Text style={styles.meta}>
                {String(org.tier ?? "")} · {String(org.verificationLevel ?? "")} ·{" "}
                {String(org.city ?? "")}
              </Text>
              <Pressable
                onPress={() => speakStorefrontRates(sf)}
                style={styles.audioBtn}
              >
                <Text style={styles.audioBtnText}>🔊 {t.speakRatesBtn}</Text>
              </Pressable>

              {rates.slice(0, 4).map((r) => {
                const mat =
                  (r.material as Record<string, unknown> | undefined) ?? {};
                return (
                  <View key={String(r.id)} style={styles.rateRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.matName}>
                        {String(mat.nameEn ?? "Scrap")}
                      </Text>
                      <Text style={styles.rateMeta}>
                        Drop-off{" "}
                        {paiseToInrString(Number(r.dropoffRatePaise ?? 0))}/kg ·
                        Pickup{" "}
                        {paiseToInrString(Number(r.pickupRatePaise ?? 0))}/kg
                      </Text>
                    </View>
                    <Pressable
                      onPress={() =>
                        handleBookOrder(sfId, String(mat.slug ?? "metal-heavy-iron"))
                      }
                      style={styles.bookBtn}
                    >
                      <Text style={styles.bookBtnText}>{t.bookSellBtn}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>
          Open Broadcast Scrap Board ({listings.length})
        </Text>
        <View style={styles.row}>
          <Text style={styles.label}>Total Lot Bid (₹):</Text>
          <TextInput
            value={offerTotalRupees}
            onChangeText={setOfferTotalRupees}
            keyboardType="decimal-pad"
            style={styles.smallInput}
          />
        </View>
        {listings.map((lot) => {
          const lotId = String(lot.id);
          const offers =
            (lot.offers as Array<Record<string, unknown>> | undefined) ?? [];
          return (
            <View key={lotId} style={styles.subCard}>
              <Text style={styles.shopTitle}>{String(lot.title ?? "Scrap Lot")}</Text>
              <Text style={styles.meta}>
                Pincode {String(lot.pickupPincode ?? "")} ·{" "}
                {offers.length} offer(s) · Private street hidden pre-acceptance
              </Text>
              <Pressable
                onPress={() => handlePlaceOffer(lotId)}
                style={styles.darkBtn}
              >
                <Text style={styles.bookBtnText}>
                  Submit Bid (₹{offerTotalRupees})
                </Text>
              </Pressable>
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
  trendCard: {
    backgroundColor: "#0f172a",
    borderRadius: 14,
    padding: 14,
    gap: 4,
  },
  badge: {
    color: "#34d399",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  trendText: { color: "#f8fafc", fontSize: 12, fontWeight: "700" },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 12,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 15, fontWeight: "800", color: "#0f172a" },
  label: { fontSize: 12, fontWeight: "700", color: "#475569" },
  smallInput: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 80,
    fontWeight: "700",
    backgroundColor: "#f8fafc",
  },
  refreshBtn: {
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  refreshText: { fontSize: 12, fontWeight: "700", color: "#334155" },
  subCard: {
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 8,
  },
  shopTitle: { fontSize: 14, fontWeight: "800", color: "#0f172a" },
  meta: { fontSize: 11, color: "#64748b", fontWeight: "600" },
  audioBtn: {
    backgroundColor: "#eff6ff",
    borderWidth: 1,
    borderColor: "#93c5fd",
    borderRadius: 9,
    paddingVertical: 8,
    alignItems: "center",
  },
  audioBtnText: { color: "#1d4ed8", fontWeight: "800", fontSize: 12 },
  rateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
  },
  matName: { fontSize: 13, fontWeight: "700", color: "#1e293b" },
  rateMeta: { fontSize: 11, color: "#047857", fontWeight: "700" },
  bookBtn: {
    backgroundColor: "#047857",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  darkBtn: {
    backgroundColor: "#0f172a",
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: "center",
  },
  bookBtnText: { color: "#ffffff", fontWeight: "800", fontSize: 11 },
});
