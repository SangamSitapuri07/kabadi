import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SupportedLanguage } from "@kabadi/shared";
import { MobileActorProfile } from "../api/mobileClient";
import { OfflineSyncQueue, QueuedSyncOperation } from "../offline/syncQueue";
import { getMobileAccessToken } from "../security/secureSession";
import { MOBILE_STRINGS, speakNativeVernacular } from "../i18n/vernacular";

interface Props {
  queue: OfflineSyncQueue;
  apiBaseUrl: string;
  actor: MobileActorProfile | null;
  lang: SupportedLanguage;
  onQueueChanged: (items: readonly QueuedSyncOperation[]) => void;
}

export function OfflineSyncScreen({
  queue,
  apiBaseUrl,
  actor,
  lang,
  onQueueChanged,
}: Props) {
  const t = MOBILE_STRINGS[lang];
  const [items, setItems] = useState<readonly QueuedSyncOperation[]>(queue.getAll());
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  useEffect(() => {
    queue.hydrateFromDisk().then((loaded) => {
      setItems([...loaded]);
      onQueueChanged(loaded);
    });
  }, [onQueueChanged, queue]);

  async function queueDraftCollection() {
    const uid = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    await queue.enqueue({
      idempotencyKey: `sqlite-draft-${uid}`,
      clientEntityId: `field-lot-${uid}`,
      operationType: "DRAFT_LISTING_CREATE",
      createdAtIso: new Date().toISOString(),
      payload: {
        title: "Offline Field Collection: 18.5 kg Sorted Heavy Iron",
        pickupPincode: "141003",
        pickupAddressPrivate: "Gill Road Basement Shed, Ludhiana",
        preferredMode: "SELLER_DROPOFF",
        items: [{ materialSlug: "metal-heavy-iron", estimatedGrams: 18500 }],
      },
    });
    const next = [...queue.getAll()];
    setItems(next);
    onQueueChanged(next);
    setStatusBanner("Saved offline collection lot to SQLite `offline_sync_queue`!");
  }

  async function queueOfflineKhataAdvance() {
    const uid = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    await queue.enqueue({
      idempotencyKey: `sqlite-khata-${uid}`,
      clientEntityId: `field-khata-${uid}`,
      operationType: "KHATA_ADVANCE_RECORD",
      createdAtIso: new Date().toISOString(),
      payload: {
        borrowerPlatformCode: "KC-COL-100101",
        amountPaise: 40000,
        entryType: "CASH_ADVANCE_GIVEN",
        notes: "Morning pheri cycle advance recorded offline in SQLite",
      },
    });
    const next = [...queue.getAll()];
    setItems(next);
    onQueueChanged(next);
    setStatusBanner("Saved ₹400.00 Peshgi advance to SQLite `offline_sync_queue`!");
  }

  async function simulateColdRestartReload() {
    const reloaded = await queue.hydrateFromDisk();
    setItems([...reloaded]);
    onQueueChanged(reloaded);
    setStatusBanner(
      `Reloaded ${reloaded.length} row(s) from on-device SQLite WAL database!`
    );
  }

  async function flushSqliteQueueNow() {
    const token = await getMobileAccessToken();
    if (!token || !actor) {
      setStatusBanner(
        "Sign in on the Account tab first so bearer JWT authenticates /sync/batch."
      );
      return;
    }
    const result = await queue.flushBatchToServer(
      apiBaseUrl,
      token,
      "Expo Android SQLite Queue"
    );
    const updated = [...queue.getAll()];
    setItems(updated);
    onQueueChanged(updated);
    const msg = `SQLite Sync Complete: ${result.applied} applied, ${result.skippedIdempotent} idempotent skipped, ${result.rejected} flagged.`;
    setStatusBanner(msg);
    await speakNativeVernacular(msg, lang);
  }

  return (
    <View style={styles.wrap}>
      {statusBanner ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{statusBanner}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.badge}>
          ⚡ {t.offlineSavedBadge.toUpperCase()} (kabadiwala_field_v1.db)
        </Text>
        <Text style={styles.title}>
          ACID SQLite Offline Sync Engine ({items.length} row
          {items.length === 1 ? "" : "s"})
        </Text>
        <Text style={styles.meta}>
          Persists pending collection lots, morning peshgi advances, and dismantling
          logs on SQLite WAL flash storage. KYC files and bearer tokens are strictly
          excluded per Architecture §8.9.
        </Text>

        <Pressable onPress={queueDraftCollection} style={styles.primaryBtn}>
          <Text style={styles.btnText}>
            + Queue Offline Scrap Collection Lot (18.5 kg)
          </Text>
        </Pressable>

        <Pressable onPress={queueOfflineKhataAdvance} style={styles.amberBtn}>
          <Text style={styles.btnText}>
            + Queue Offline Morning Peshgi Advance (₹400)
          </Text>
        </Pressable>

        <View style={styles.row}>
          <Pressable
            onPress={simulateColdRestartReload}
            style={[styles.secondaryBtn, { flex: 1 }]}
          >
            <Text style={styles.secondaryText}>↻ Reload SQLite Disk</Text>
          </Pressable>
          <Pressable
            onPress={flushSqliteQueueNow}
            style={[styles.darkBtn, { flex: 1 }]}
          >
            <Text style={styles.btnText}>☁️ Flush Batch to Server</Text>
          </Pressable>
        </View>

        <Pressable
          onPress={async () => {
            const rem = await queue.clearCompleted();
            setItems([...rem]);
            onQueueChanged(rem);
          }}
          style={styles.clearBtn}
        >
          <Text style={styles.clearText}>Prune Synced SQLite Rows</Text>
        </Pressable>
      </View>

      {items.map((item) => (
        <View key={item.idempotencyKey} style={styles.rowCard}>
          <Text style={styles.rowTitle}>
            {item.operationType} · {item.syncStatus}
          </Text>
          <Text style={styles.meta}>Idempotency Key: {item.idempotencyKey}</Text>
          <Text style={styles.meta}>
            Created: {item.createdAtIso} · Retries: {item.retryCount}
          </Text>
        </View>
      ))}
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
  badge: {
    fontSize: 10,
    fontWeight: "800",
    color: "#047857",
    letterSpacing: 0.5,
  },
  title: { fontSize: 15, fontWeight: "800", color: "#0f172a" },
  meta: { fontSize: 12, color: "#64748b", lineHeight: 17 },
  row: { flexDirection: "row", gap: 8 },
  primaryBtn: {
    backgroundColor: "#047857",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  amberBtn: {
    backgroundColor: "#b45309",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  darkBtn: {
    backgroundColor: "#0f172a",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryBtn: {
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  secondaryText: { color: "#1e293b", fontWeight: "800", fontSize: 12 },
  btnText: { color: "#ffffff", fontWeight: "800", fontSize: 12 },
  clearBtn: { alignItems: "center", paddingVertical: 6 },
  clearText: { fontSize: 11, fontWeight: "700", color: "#64748b" },
  rowCard: {
    backgroundColor: "#ffffff",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    gap: 4,
  },
  rowTitle: { fontSize: 13, fontWeight: "800", color: "#0f172a" },
});
