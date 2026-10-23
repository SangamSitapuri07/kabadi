"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ShieldCheck,
  Store,
  Cpu,
  Scale,
  ArrowUpRight,
  Volume2,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Layers,
  LogOut,
  UserCheck,
  RefreshCw,
  PackageCheck,
  Gavel,
  Wrench,
  Wallet,
  GitBranch,
  ExternalLink,
  Square,
  Bell,
  TrendingUp,
  Receipt,
} from "lucide-react";
import { CameraAiStudio } from "../components/CameraAiStudio";
import { OperationsHub } from "../components/OperationsHub";
import { QrMatrixCard } from "../components/QrMatrixCard";
import { KycVerificationPortal } from "../components/KycVerificationPortal";
import { SettlementSlipModal } from "../components/SettlementSlipModal";
import {
  AppLanguage,
  LANGUAGE_META,
  speakVernacularText,
  stopVernacularSpeech,
} from "../lib/vernacularAudio";

type Language = AppLanguage;

interface MaterialInfo {
  id?: string;
  slug: string;
  nameEn: string;
  nameHi: string;
  namePa: string;
  nameMr?: string;
  streamGroup: string;
  defaultUnit: "KG" | "PIECE";
  isRegulatedHazardous: boolean;
  handlingGuidance?: string;
}

interface RateItem {
  id: string;
  pickupRatePaise: number;
  dropoffRatePaise: number;
  minWeightGrams: number;
  purityGrade: string;
  version: number;
  material: MaterialInfo;
}

interface StorefrontCard {
  id: string;
  slug: string;
  shopTitle: string;
  tagline: string | null;
  isOpen: boolean;
  pickupAvailable: boolean;
  dropoffAvailable: boolean;
  minPickupGrams: number;
  servicePincodes: string[];
  ratingAvg: number;
  completedOrdersCnt: number;
  organization: {
    tier: string;
    platformCode: string;
    businessName: string;
    city: string;
    pincode: string;
    serviceRadiusKm: number;
    verificationLevel: string;
    recyclerRegistration?: {
      authorityName: string;
      registrationNumber: string;
      cpcbPortalChecked: boolean;
    } | null;
  };
  rateItems: RateItem[];
}

interface AuthenticatedUser {
  id: string;
  phone: string;
  email: string | null;
  role: "CUSTOMER" | "COLLECTOR" | "SCRAP_BUSINESS" | "AUTHORISED_RECYCLER" | "ADMIN";
  tier: string;
  accountStatus: string;
  verificationLevel: string;
  platformCode: string;
  platformIdDisclaimer: string;
  profile?: {
    displayName: string;
    preferredLanguage: string;
    city: string;
    pincode: string;
  } | null;
  organization?: {
    businessName: string;
    platformCode: string;
    tier: string;
  } | null;
}

interface OrderRecord {
  id: string;
  orderNumber: string;
  sellerId: string;
  buyerId: string;
  sellerTier: string;
  buyerTier: string;
  fulfillmentMode: string;
  status: string;
  indicativeTotalPaise: number;
  agreedTotalPaise: number;
  finalSettlementPaise: number | null;
  qrTraceToken: string;
  createdAt: string;
  storefront?: { shopTitle: string } | null;
  paymentRecords?: Array<{
    id: string;
    method: string;
    amountPaise: number;
    status: string;
  }>;
  items: Array<{
    id: string;
    lockedRatePaise: number;
    estimatedGrams: number;
    actualGrams: number | null;
    material: { slug: string; nameEn: string; defaultUnit: string };
  }>;
}

interface BinItem {
  id: string;
  availableGrams: number;
  weightedAvgCostPaise: number;
  material: MaterialInfo;
}

interface OpenBroadcastListing {
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  ownerPlatformCode: string;
  sellerTier: string;
  title: string;
  pickupCity: string;
  pickupPincode: string;
  pickupAddressPrivate?: string;
  indicativeEstimatePaise: number;
  status: string;
  items: Array<{
    id: string;
    estimatedGrams: number;
    material: MaterialInfo;
  }>;
  offers: Array<{
    id: string;
    buyerId: string;
    offeredTotalPaise: number;
    version: number;
    notes: string | null;
    status: string;
    buyer: {
      platformCode: string;
      tier: string;
      profile?: { displayName: string } | null;
      organization?: { businessName: string } | null;
    };
  }>;
}

interface KhataEntry {
  id: string;
  entryType: string;
  amountPaise: number;
  balanceAfterPaise: number;
  notes: string | null;
  createdAt: string;
  lender: { platformCode: string; profile?: { displayName: string } | null };
  borrower: { platformCode: string; profile?: { displayName: string } | null };
}

const TIER_RANK: Record<string, number> = {
  TIER_0_GENERATOR: 0,
  TIER_1_LOCAL_COLLECTOR: 1,
  TIER_2_AREA_SHOP: 2,
  TIER_3_WHOLESALE_AGGREGATOR: 3,
  TIER_4_AUTHORISED_RECYCLER: 4,
  PLATFORM_STAFF: 99,
};

const DEMO_ACCOUNTS = [
  {
    label: "Tier 0 · Customer",
    email: "customer@kabadiwala.local",
    pass: "KabadiPass123",
  },
  {
    label: "Tier 1 · Local Kabadi",
    email: "collector@kabadiwala.local",
    pass: "KabadiPass123",
  },
  {
    label: "Tier 2 · Area Shop",
    email: "shop@kabadiwala.local",
    pass: "KabadiPass123",
  },
  {
    label: "Tier 3 · Thok Mandi",
    email: "wholesale@kabadiwala.local",
    pass: "KabadiPass123",
  },
  {
    label: "Tier 4 · CPCB Recycler",
    email: "recycler@kabadiwala.local",
    pass: "KabadiPass123",
  },
  {
    label: "Security Admin",
    email: "admin@kabadiwala.local",
    pass: "AdminPass123",
  },
];

function formatInr(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function tierBadgeLabel(tier: string): { short: string; color: string } {
  switch (tier) {
    case "TIER_0_GENERATOR":
      return { short: "Tier 0 · Generator", color: "bg-slate-100 text-slate-800 border-slate-300" };
    case "TIER_1_LOCAL_COLLECTOR":
      return { short: "Tier 1 · Local Pheri", color: "bg-emerald-50 text-emerald-800 border-emerald-300" };
    case "TIER_2_AREA_SHOP":
      return { short: "Tier 2 · Area Scrap Shop", color: "bg-teal-50 text-teal-800 border-teal-300" };
    case "TIER_3_WHOLESALE_AGGREGATOR":
      return { short: "Tier 3 · Wholesale Mandi", color: "bg-indigo-50 text-indigo-800 border-indigo-300" };
    case "TIER_4_AUTHORISED_RECYCLER":
      return { short: "Tier 4 · Authorised Recycler", color: "bg-purple-50 text-purple-800 border-purple-300" };
    default:
      return { short: "Platform Staff", color: "bg-amber-50 text-amber-900 border-amber-300" };
  }
}

export default function KabadiwalaConnectApp() {
  const [activeTab, setActiveTab] = useState<
    "marketplace" | "bidding" | "xray" | "dashboard" | "operations" | "security"
  >("marketplace");
  const [lang, setLang] = useState<Language>("EN");
  const [tierFilter, setTierFilter] = useState<string>("ALL");

  const [currentUser, setCurrentUser] = useState<AuthenticatedUser | null>(null);
  const [accessToken, setAccessToken] = useState<string>("");
  const [storefronts, setStorefronts] = useState<StorefrontCard[]>([]);
  const [materials, setMaterials] = useState<MaterialInfo[]>([]);
  const [openListings, setOpenListings] = useState<OpenBroadcastListing[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [bins, setBins] = useState<BinItem[]>([]);
  const [khataEntries, setKhataEntries] = useState<KhataEntry[]>([]);
  const [notifications, setNotifications] = useState<
    Array<{ id: string; title: string; body: string; readAt: string | null; createdAt: string }>
  >([]);
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [showNotifs, setShowNotifs] = useState<boolean>(false);

  // Admin state
  const [adminCases, setAdminCases] = useState<Array<Record<string, unknown>>>([]);
  const [auditEvents, setAuditEvents] = useState<Array<Record<string, unknown>>>([]);
  const [adminMetrics, setAdminMetrics] = useState<Record<string, number> | null>(null);

  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [liveSpeechBar, setLiveSpeechBar] = useState<{
    lang: Language;
    text: string;
    active: boolean;
  } | null>(null);

  // Direct storefront order modal
  const [bookingStorefront, setBookingStorefront] = useState<StorefrontCard | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string>("paper-newspaper");
  const [estimatedKg, setEstimatedKg] = useState<string>("12");
  const [fulfillmentMode, setFulfillmentMode] = useState<"BUYER_PICKUP" | "SELLER_DROPOFF">(
    "BUYER_PICKUP"
  );

  // Upward bin sale modal
  const [upwardBin, setUpwardBin] = useState<BinItem | null>(null);
  const [upwardKg, setUpwardKg] = useState<string>("5");
  const [upwardStorefrontId, setUpwardStorefrontId] = useState<string>("");
  const [slipOrderId, setSlipOrderId] = useState<string | null>(null);

  // Open broadcast listing creator & offer inputs
  const [bcastTitle, setBcastTitle] = useState<string>(
    "Mixed Shop Batch: 15 kg Copper Cable + 10 kg Grade-A PCBs"
  );
  const [bcastSlug, setBcastSlug] = useState<string>("ewaste-pcb-grade-a");
  const [bcastKg, setBcastKg] = useState<string>("10");
  const [offerAmountsInr, setOfferAmountsInr] = useState<Record<string, string>>({});

  // Storefront rate publisher
  const [newRateSlug, setNewRateSlug] = useState<string>("metal-copper-bright");
  const [newPickupInr, setNewPickupInr] = useState<string>("615");
  const [newDropoffInr, setNewDropoffInr] = useState<string>("630");

  // Appliance dismantling form
  const [dismantleDesc, setDismantleDesc] = useState<string>("1x Dead 1.5T Copper Split AC");
  const [dismantleInputKg, setDismantleInputKg] = useState<string>("38");
  const [dismantleCopperKg, setDismantleCopperKg] = useState<string>("5.8");
  const [dismantlePcbKg, setDismantlePcbKg] = useState<string>("1.2");
  const [dismantleIronKg, setDismantleIronKg] = useState<string>("29.0");
  const [dismantleResidueKg, setDismantleResidueKg] = useState<string>("2.0");

  // Khata advance form
  const [khataBorrowerCode, setKhataBorrowerCode] = useState<string>("KC-COL-100101");
  const [khataAmountInr, setKhataAmountInr] = useState<string>("2000");
  const [khataNote, setKhataNote] = useState<string>("Morning Pheri Cash Advance (Peshgi)");

  // AI Device X-Ray Scanner state
  const [deviceQuery, setDeviceQuery] = useState<string>("Redmi Smartphone 5G");
  const [deviceCondition, setDeviceCondition] = useState<
    "POWERS_ON_INTACT" | "CRACKED_SCREEN_BOOTS" | "DEAD_BOOT_INTACT_BODY" | "HEAVILY_DAMAGED_SCRAP"
  >("DEAD_BOOT_INTACT_BODY");
  const [coilHint, setCoilHint] = useState<"UNKNOWN" | "COPPER" | "ALUMINUM">("UNKNOWN");
  const [xrayResult, setXrayResult] = useState<Record<string, unknown> | null>(null);
  const [xrayLoading, setXrayLoading] = useState<boolean>(false);

  // Registration / custom login form
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loginId, setLoginId] = useState<string>("collector@kabadiwala.local");
  const [loginPass, setLoginPass] = useState<string>("KabadiPass123");
  const [regName, setRegName] = useState<string>("");
  const [regPhone, setRegPhone] = useState<string>("");
  const [regRole, setRegRole] = useState<
    "CUSTOMER" | "COLLECTOR" | "SCRAP_BUSINESS" | "AUTHORISED_RECYCLER"
  >("COLLECTOR");
  const [regPass, setRegPass] = useState<string>("StrongPass123");

  const notify = (type: "ok" | "err", text: string) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 5500);
  };

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      if (!headers.has("Content-Type") && !(init?.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
      }
      if (accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
      }
      const res = await fetch(path, {
        ...init,
        headers,
        credentials: "include",
      });
      const json = await res.json();
      return { status: res.status, ok: res.ok, json };
    },
    [accessToken]
  );

  const loadPublicMarketplace = useCallback(async () => {
    const [sfRes, matRes] = await Promise.all([
      apiFetch(
        tierFilter === "ALL"
          ? "/api/v1/storefronts"
          : `/api/v1/storefronts?tier=${encodeURIComponent(tierFilter)}`
      ),
      apiFetch("/api/v1/materials"),
    ]);
    if (sfRes.ok) setStorefronts(sfRes.json.data.storefronts);
    if (matRes.ok) setMaterials(matRes.json.data.categories);
  }, [apiFetch, tierFilter]);

  const loadRoleWorkspace = useCallback(
    async (user: AuthenticatedUser | null, tokenOverride?: string) => {
      if (!user) return;
      const headers: Record<string, string> = {};
      const tok = tokenOverride ?? accessToken;
      if (tok) headers.Authorization = `Bearer ${tok}`;

      const [ordRes, binRes, openRes, khataRes, notifRes] = await Promise.all([
        fetch("/api/v1/orders", { headers, credentials: "include" }).then((r) => r.json()),
        fetch("/api/v1/inventory/bins", { headers, credentials: "include" }).then((r) =>
          r.json()
        ),
        fetch("/api/v1/listings/open", { headers, credentials: "include" }).then((r) =>
          r.json()
        ),
        fetch("/api/v1/khata", { headers, credentials: "include" }).then((r) => r.json()),
        fetch("/api/v1/notifications", { headers, credentials: "include" }).then((r) =>
          r.json()
        ),
      ]);
      if (ordRes.success) setOrders(ordRes.data.orders);
      if (binRes.success) setBins(binRes.data.bins);
      if (openRes.success) setOpenListings(openRes.data.listings);
      if (khataRes.success) setKhataEntries(khataRes.data.entries);
      if (notifRes.success) {
        setNotifications(notifRes.data.notifications);
        setUnreadCount(notifRes.data.unreadCount);
      }

      if (user.role === "ADMIN") {
        const [cRes, aRes, mRes] = await Promise.all([
          fetch("/api/v1/admin/verification/cases", {
            headers,
            credentials: "include",
          }).then((r) => r.json()),
          fetch("/api/v1/admin/audit-events?limit=35", {
            headers,
            credentials: "include",
          }).then((r) => r.json()),
          fetch("/api/v1/admin/metrics", {
            headers,
            credentials: "include",
          }).then((r) => r.json()),
        ]);
        if (cRes.success) setAdminCases(cRes.data.cases);
        if (aRes.success) setAuditEvents(aRes.data.events);
        if (mRes.success) setAdminMetrics(mRes.data.metrics);
      }
    },
    [accessToken]
  );

  useEffect(() => {
    loadPublicMarketplace();
  }, [loadPublicMarketplace]);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          identifier: "collector@kabadiwala.local",
          password: "KabadiPass123",
        }),
      });
      const json = await res.json();
      if (json.success) {
        setAccessToken(json.data.tokens.accessToken);
        setCurrentUser(json.data.user);
        await loadRoleWorkspace(json.data.user, json.data.tokens.accessToken);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleQuickSwitch = async (email: string, password: string) => {
    const res = await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ identifier: email, password }),
    });
    const json = await res.json();
    if (json.success) {
      setAccessToken(json.data.tokens.accessToken);
      setCurrentUser(json.data.user);
      await loadRoleWorkspace(json.data.user, json.data.tokens.accessToken);
      notify(
        "ok",
        `Switched session to ${json.data.user.profile?.displayName ?? json.data.user.role} (${
          json.data.user.platformCode
        })`
      );
      if (json.data.user.role === "ADMIN") {
        setActiveTab("security");
      }
    } else {
      notify("err", json.error?.message || "Sign-in failed");
    }
  };

  const handleCustomRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    const { ok, json } = await apiFetch("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({
        displayName: regName,
        phone: regPhone,
        password: regPass,
        role: regRole,
        city: "Ludhiana",
        pincode: "141001",
        preferredLanguage: lang,
      }),
    });
    if (ok) {
      setAccessToken(json.data.tokens.accessToken);
      setCurrentUser(json.data.user);
      await loadPublicMarketplace();
      await loadRoleWorkspace(json.data.user, json.data.tokens.accessToken);
      notify("ok", `Created account ${json.data.user.platformCode} with Argon2id security!`);
    } else {
      notify("err", json.error?.message || "Registration rejected by schema validator");
    }
  };

  const handleLogout = async () => {
    await apiFetch("/api/v1/auth/logout", { method: "POST" });
    setCurrentUser(null);
    setAccessToken("");
    setOrders([]);
    setBins([]);
    setKhataEntries([]);
    notify("ok", "Session family revoked on server and cookies cleared.");
  };

  const speakTextAloud = (
    text: string,
    tone: "verified" | "alert" | "info" = "info"
  ) => {
    setLiveSpeechBar({ lang, text, active: true });
    speakVernacularText(text, lang, tone, () => {
      setLiveSpeechBar((prev) => (prev ? { ...prev, active: false } : null));
    });
  };

  const speakStorefrontRateCard = async (sf: StorefrontCard) => {
    const { ok, json } = await apiFetch("/api/v1/ai/speech-script", {
      method: "POST",
      body: JSON.stringify({
        contextType: "STOREFRONT_RATES",
        language: lang,
        storefrontId: sf.id,
      }),
    });
    if (ok) {
      speakTextAloud(json.data.script, "info");
    }
  };

  const handleCreateOrderRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookingStorefront || !currentUser) {
      notify("err", "Sign in first to place a pickup or drop-off order");
      return;
    }
    const grams = Math.max(500, Math.round(Number(estimatedKg) * 1000));
    const { ok, json } = await apiFetch("/api/v1/listings", {
      method: "POST",
      body: JSON.stringify({
        title: `${currentUser.profile?.displayName ?? "Seller"} → ${
          bookingStorefront.shopTitle
        }`,
        pickupPincode: currentUser.profile?.pincode ?? "141001",
        pickupAddressPrivate: "Verified Pickup Point, Ludhiana",
        preferredMode: fulfillmentMode,
        targetStorefrontId: bookingStorefront.id,
        items: [{ materialSlug: selectedSlug, estimatedGrams: grams }],
      }),
    });
    if (ok) {
      setBookingStorefront(null);
      await loadRoleWorkspace(currentUser);
      setActiveTab("dashboard");
      notify(
        "ok",
        `Created Order ${json.data.order.orderNumber} (Indicative: ${formatInr(
          json.data.listing.indicativeEstimatePaise
        )})`
      );
    } else {
      notify("err", json.error?.message || "Could not create order");
    }
  };

  const handleCreateOpenBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    const { ok, json } = await apiFetch("/api/v1/listings", {
      method: "POST",
      body: JSON.stringify({
        title: bcastTitle,
        pickupPincode: currentUser.profile?.pincode ?? "141001",
        pickupAddressPrivate: "Private Address Hidden Until Bid Accepted",
        preferredMode: "BUYER_PICKUP",
        items: [
          {
            materialSlug: bcastSlug,
            estimatedGrams: Math.max(500, Math.round(Number(bcastKg) * 1000)),
          },
        ],
      }),
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      notify("ok", "Open broadcast listing posted — switch to any Buyer role to submit bids!");
    } else {
      notify("err", json.error?.message || "Failed to post broadcast lot");
    }
  };

  const handleSubmitBidOffer = async (listingId: string) => {
    const inrVal = Number(offerAmountsInr[listingId] || "0");
    if (!inrVal || inrVal <= 0) {
      notify("err", "Enter a positive offer amount in ₹");
      return;
    }
    const { ok, json } = await apiFetch(`/api/v1/listings/${listingId}/offers`, {
      method: "POST",
      body: JSON.stringify({
        offeredTotalPaise: Math.round(inrVal * 100),
        notes: "Verified digital scale & instant settlement",
      }),
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      notify("ok", `Submitted Purchase Offer v${json.data.offer.version} (${formatInr(json.data.offer.offeredTotalPaise)})!`);
    } else {
      notify("err", json.error?.message || "Offer rejected");
    }
  };

  const handleAcceptBidOffer = async (offerId: string) => {
    const { ok, json } = await apiFetch(`/api/v1/offers/${offerId}/accept`, {
      method: "POST",
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      setActiveTab("dashboard");
      notify(
        "ok",
        `Accepted offer! Created locked order ${json.data.order.orderNumber} (${formatInr(
          json.data.order.agreedTotalPaise
        )})`
      );
    } else {
      notify("err", json.error?.message || "Cannot accept offer");
    }
  };

  const handleOpenSellUpwardModal = (bin: BinItem) => {
    setUpwardBin(bin);
    setUpwardKg((bin.availableGrams / 1000).toFixed(1));
    const myRank = TIER_RANK[currentUser?.tier ?? "TIER_0_GENERATOR"] ?? 0;
    const eligibleHigher = storefronts.filter(
      (sf) =>
        (TIER_RANK[sf.organization.tier] ?? 0) > myRank &&
        sf.rateItems.some((r) => r.material.slug === bin.material.slug)
    );
    setUpwardStorefrontId(eligibleHigher[0]?.id ?? "");
  };

  const handleExecuteSellUpward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!upwardBin || !upwardStorefrontId) return;
    const grams = Math.round(Number(upwardKg) * 1000);
    const { ok, json } = await apiFetch(
      `/api/v1/inventory/bins/${upwardBin.id}/sell-upward`,
      {
        method: "POST",
        body: JSON.stringify({
          sellGrams: grams,
          targetStorefrontId: upwardStorefrontId,
          fulfillmentMode: "SELLER_DROPOFF",
        }),
      }
    );
    if (ok) {
      setUpwardBin(null);
      await loadRoleWorkspace(currentUser);
      notify(
        "ok",
        `Upward batch ${json.data.order.orderNumber} booked (${json.data.lineageLinksCreated} child lots linked in BatchLineage, projected margin ${formatInr(
          json.data.economics.projectedGrossMarginPaise
        )})!`
      );
    } else {
      notify("err", json.error?.message || "Upward batch sale rejected");
    }
  };

  const handleRecordDismantle = async (e: React.FormEvent) => {
    e.preventDefault();
    const { ok, json } = await apiFetch("/api/v1/inventory/dismantle", {
      method: "POST",
      body: JSON.stringify({
        inputDescription: dismantleDesc,
        inputGrams: Math.round(Number(dismantleInputKg) * 1000),
        residueGrams: Math.round(Number(dismantleResidueKg) * 1000),
        outputs: [
          {
            materialSlug: "metal-copper-bright",
            outputGrams: Math.round(Number(dismantleCopperKg) * 1000),
          },
          {
            materialSlug: "ewaste-pcb-grade-a",
            outputGrams: Math.round(Number(dismantlePcbKg) * 1000),
          },
          {
            materialSlug: "metal-heavy-iron",
            outputGrams: Math.round(Number(dismantleIronKg) * 1000),
          },
        ],
      }),
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      notify("ok", "Appliance dismantled & pure material weights added directly to your Stock Bins!");
    } else {
      notify("err", json.error?.message || "Dismantling mass-balance check failed");
    }
  };

  const handleIssueKhataAdvance = async (e: React.FormEvent) => {
    e.preventDefault();
    const { ok, json } = await apiFetch("/api/v1/khata/entries", {
      method: "POST",
      body: JSON.stringify({
        borrowerPlatformCode: khataBorrowerCode,
        amountPaise: Math.round(Number(khataAmountInr) * 100),
        entryType: "CASH_ADVANCE_GIVEN",
        notes: khataNote,
      }),
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      notify(
        "ok",
        `Recorded ${formatInr(
          json.data.entry.amountPaise
        )} cash advance — automatically deducted when supplier settles scrap!`
      );
    } else {
      notify("err", json.error?.message || "Could not log Khata entry");
    }
  };

  const handlePublishRate = async (e: React.FormEvent) => {
    e.preventDefault();
    const { ok, json } = await apiFetch("/api/v1/storefronts/my/rates", {
      method: "POST",
      body: JSON.stringify({
        materialSlug: newRateSlug,
        pickupRatePaise: Math.round(Number(newPickupInr) * 100),
        dropoffRatePaise: Math.round(Number(newDropoffInr) * 100),
        minWeightGrams: 2000,
        purityGrade: "CLEAN_SORTED",
      }),
    });
    if (ok) {
      await loadPublicMarketplace();
      notify(
        "ok",
        `Published Rate Card v${json.data.rateItem.version} (previous rate archived, never overwritten!)`
      );
    } else {
      notify("err", json.error?.message || "Failed to publish storefront rate");
    }
  };

  const handleAcceptOrder = async (orderId: string) => {
    const { ok, json } = await apiFetch(`/api/v1/orders/${orderId}/accept`, {
      method: "POST",
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      notify("ok", "Pickup request accepted & rate locked!");
    } else {
      notify("err", json.error?.message || "Not permitted");
    }
  };

  const handleWeighAndSettle = async (order: OrderRecord) => {
    const totalEst = order.items.reduce((s, i) => s + i.estimatedGrams, 0);
    const { ok, json } = await apiFetch(`/api/v1/orders/${order.id}/weigh-and-settle`, {
      method: "POST",
      body: JSON.stringify({
        items: order.items.map((it) => ({
          orderItemId: it.id,
          actualGrams: it.estimatedGrams,
        })),
        adjustmentPaise: 0,
        scaleOcrGrams: totalEst,
        autoOffsetKhataAdvance: true,
      }),
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      setSlipOrderId(order.id);
      notify(
        "ok",
        `Settled ${formatInr(
          json.data.order.finalSettlementPaise
        )} — opening Dynamic UPI QR & Thermal Slip!`
      );
    } else {
      notify("err", json.error?.message || "Settlement rejected");
    }
  };

  const handleRunXrayScan = async (
    presetQuery?: string,
    presetCoil?: "UNKNOWN" | "COPPER" | "ALUMINUM"
  ) => {
    if (!currentUser) {
      notify("err", "Please select a role account first to run AI scans");
      return;
    }
    setXrayLoading(true);
    const q = presetQuery ?? deviceQuery;
    const c = presetCoil ?? coilHint;
    if (presetQuery) setDeviceQuery(presetQuery);
    if (presetCoil) setCoilHint(presetCoil);

    const { ok, json } = await apiFetch("/api/v1/ai/xray-estimate", {
      method: "POST",
      body: JSON.stringify({
        deviceQuery: q,
        observedCondition: deviceCondition,
        coilTypeHint: c,
        city: "Ludhiana",
      }),
    });
    setXrayLoading(false);
    if (ok) {
      setXrayResult(json.data);
    } else {
      notify("err", json.error?.message || "AI scan failed");
    }
  };

  const handleAdminDecideCase = async (
    caseId: string,
    decision: "VERIFIED" | "ACTION_REQUIRED" | "REJECTED"
  ) => {
    const { ok, json } = await apiFetch(`/api/v1/admin/verification/cases/${caseId}/decide`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        reason: `Reviewed registration evidence via Admin Dashboard (${decision})`,
        officialSourceChecked: true,
        evidenceReferenceUrl: "https://eprewaste.cpcb.gov.in/",
      }),
    });
    if (ok) {
      await loadRoleWorkspace(currentUser);
      await loadPublicMarketplace();
      notify("ok", `Verification case updated to ${decision} & logged in AuditEvent!`);
    } else {
      notify("err", json.error?.message || "Admin action rejected");
    }
  };

  const triggerLiveRbacDefenseDemo = async () => {
    const { status, json } = await apiFetch("/api/v1/admin/audit-events");
    if (status === 403) {
      notify(
        "err",
        `RBAC Blocked (HTTP 403): "${json.error?.message}" — Denied attempt recorded in AuditEvent!`
      );
    } else if (status === 200) {
      notify("ok", `Admin verified — retrieved ${json.data.events.length} append-only audit logs.`);
    }
  };

  const matLabel = (m: MaterialInfo) =>
    lang === "HI"
      ? m.nameHi
      : lang === "PA"
        ? m.namePa
        : lang === "MR"
          ? m.nameMr || m.nameHi
          : m.nameEn;

  const eligibleHigherStorefrontsForModal = upwardBin
    ? storefronts.filter(
        (sf) =>
          (TIER_RANK[sf.organization.tier] ?? 0) >
            (TIER_RANK[currentUser?.tier ?? "TIER_0_GENERATOR"] ?? 0) &&
          sf.rateItems.some((r) => r.material.slug === upwardBin.material.slug)
      )
    : [];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Security & Hierarchy Header */}
      <header className="sticky top-0 z-30 border-b border-emerald-900/20 bg-gradient-to-r from-emerald-950 via-emerald-900 to-teal-900 text-white shadow">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/20 ring-1 ring-emerald-300/40">
              <Layers className="h-5 w-5 text-emerald-300" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">Kabadiwala Connect</h1>
                <span className="rounded-full bg-emerald-400/20 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-200 ring-1 ring-emerald-300/30">
                  5-Tier Supply Chain + OWASP Core
                </span>
              </div>
              <p className="text-xs text-emerald-200/85">
                Household (T0) → Local Pheri (T1) → Area Shop (T2) → Wholesale Mandi (T3) → Authorised Recycler (T4)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex rounded-lg bg-emerald-950/70 p-0.5 ring-1 ring-white/15">
              {(["EN", "HI", "PA", "MR"] as const).map((code) => (
                <button
                  key={code}
                  onClick={() => setLang(code)}
                  className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    lang === code
                      ? "bg-amber-400 text-slate-950 shadow-sm"
                      : "text-emerald-100 hover:bg-white/10"
                  }`}
                >
                  {LANGUAGE_META[code].nativeLabel}
                </button>
              ))}
            </div>

            {currentUser && (
              <div className="relative">
                <button
                  type="button"
                  onClick={async () => {
                    const next = !showNotifs;
                    setShowNotifs(next);
                    if (next && unreadCount > 0) {
                      await apiFetch("/api/v1/notifications/read-all", {
                        method: "POST",
                      });
                      setUnreadCount(0);
                    }
                  }}
                  className="relative rounded-xl bg-white/10 p-2 text-emerald-100 ring-1 ring-white/20 hover:bg-white/20"
                  title="Notifications"
                >
                  <Bell className="h-4 w-4" />
                  {unreadCount > 0 && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] font-extrabold text-slate-950">
                      {unreadCount}
                    </span>
                  )}
                </button>

                {showNotifs && (
                  <div className="absolute right-0 mt-2 w-80 rounded-2xl border border-slate-200 bg-white p-3 text-xs text-slate-800 shadow-2xl">
                    <div className="mb-2 font-bold text-slate-900">
                      Platform Alerts & Arbitration Notices ({notifications.length})
                    </div>
                    <div className="max-h-60 divide-y divide-slate-100 overflow-y-auto">
                      {notifications.length === 0 ? (
                        <div className="py-4 text-center text-slate-500">
                          No notifications yet
                        </div>
                      ) : (
                        notifications.map((n) => (
                          <div key={n.id} className="py-2">
                            <div className="font-bold text-emerald-900">{n.title}</div>
                            <div className="mt-0.5 text-[11px] text-slate-600">{n.body}</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {currentUser ? (
              <div className="flex items-center gap-2 rounded-xl bg-white/10 px-3 py-1.5 text-xs ring-1 ring-white/20">
                <UserCheck className="h-4 w-4 text-emerald-300" />
                <div>
                  <div className="font-bold text-white">
                    {currentUser.profile?.displayName ?? currentUser.role}
                  </div>
                  <div className="text-[11px] text-emerald-200">
                    {currentUser.platformCode} · {currentUser.verificationLevel}
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  title="Revoke session & sign out"
                  className="ml-1 rounded-lg bg-white/10 p-1.5 text-emerald-100 hover:bg-rose-500/80 hover:text-white"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <span className="rounded-lg bg-amber-400/20 px-3 py-1 text-xs font-medium text-amber-200">
                Signed Out — Select an Account Below
              </span>
            )}
          </div>
        </div>

        {/* One-Click Multi-Tier Role Switcher Bar */}
        <div className="border-t border-white/10 bg-emerald-950/60">
          <div className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto px-4 py-2 text-xs">
            <span className="shrink-0 font-semibold text-emerald-300">
              Switch Live Role Session:
            </span>
            {DEMO_ACCOUNTS.map((acc) => {
              const active = currentUser?.email === acc.email;
              return (
                <button
                  key={acc.email}
                  onClick={() => handleQuickSwitch(acc.email, acc.pass)}
                  className={`shrink-0 rounded-lg px-2.5 py-1 font-medium transition ${
                    active
                      ? "bg-white text-emerald-950 font-bold shadow"
                      : "bg-white/10 text-emerald-100 hover:bg-white/20"
                  }`}
                >
                  {acc.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-md rounded-xl border border-slate-200 bg-slate-900 px-4 py-3 text-sm font-medium text-white shadow-xl">
          <div className="flex items-center gap-2.5">
            {toast.type === "ok" ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
            ) : (
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
            )}
            <span>{toast.text}</span>
          </div>
        </div>
      )}

      {/* Main Navigation Tabs */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-6 flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
          <button
            onClick={() => setActiveTab("marketplace")}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              activeTab === "marketplace"
                ? "bg-emerald-700 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <Store className="h-4 w-4" />
            Storefront Rate Cards (T1–T4)
          </button>

          <button
            onClick={() => setActiveTab("bidding")}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              activeTab === "bidding"
                ? "bg-emerald-700 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <Gavel className="h-4 w-4" />
            Open Multi-Buyer Bidding ({openListings.length})
          </button>

          <button
            onClick={() => setActiveTab("dashboard")}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              activeTab === "dashboard"
                ? "bg-emerald-700 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <Scale className="h-4 w-4" />
            Shop Bins, Dismantling, Khata & Orders
          </button>

          <button
            onClick={() => setActiveTab("xray")}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              activeTab === "xray"
                ? "bg-emerald-700 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <Cpu className="h-4 w-4" />
            Camera AI, Scale OCR & X-Ray
          </button>

          <button
            onClick={() => setActiveTab("operations")}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              activeTab === "operations"
                ? "bg-emerald-700 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <TrendingUp className="h-4 w-4" />
            Trends, Offline Sync & Disputes
          </button>

          <button
            onClick={() => setActiveTab("security")}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
              activeTab === "security"
                ? "bg-emerald-700 text-white shadow-sm"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            Verification, Auth & Audit
          </button>
        </div>

        {/* ===================================================================== */}
        {/* TAB 1: ZOMATO-STYLE MULTI-TIER STOREFRONT RATE CARDS                  */}
        {/* ===================================================================== */}
        {activeTab === "marketplace" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
              <div>
                <h2 className="text-base font-bold text-emerald-950">
                  Multi-Tier Scrap Storefronts & Published Purchase Offers
                </h2>
                <p className="text-xs text-emerald-800">
                  Purchase rates step up from Local Doorstep Collector (Tier 1) → Area Shop (Tier 2) → Wholesale Baling Mandi (Tier 3) → CPCB Authorised Recycler (Tier 4).
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { id: "ALL", label: "All Hierarchy Tiers" },
                  { id: "TIER_1_LOCAL_COLLECTOR", label: "Tier 1 · Local Pheri" },
                  { id: "TIER_2_AREA_SHOP", label: "Tier 2 · Area Shop" },
                  { id: "TIER_3_WHOLESALE_AGGREGATOR", label: "Tier 3 · Thok Mandi" },
                  { id: "TIER_4_AUTHORISED_RECYCLER", label: "Tier 4 · CPCB Plant" },
                ].map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setTierFilter(f.id)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      tierFilter === f.id
                        ? "bg-emerald-800 text-white"
                        : "bg-white text-emerald-900 border border-emerald-200 hover:bg-emerald-100"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              {storefronts.map((sf) => {
                const badge = tierBadgeLabel(sf.organization.tier);
                return (
                  <div
                    key={sf.id}
                    className="flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md"
                  >
                    <div>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <span
                            className={`inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${badge.color}`}
                          >
                            {badge.short}
                          </span>
                          <h3 className="mt-1.5 text-lg font-bold text-slate-900">
                            {sf.shopTitle}
                          </h3>
                          <p className="text-xs text-slate-500">{sf.tagline}</p>
                        </div>

                        <div className="text-right text-xs">
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-bold text-emerald-800">
                            ★ {sf.ratingAvg.toFixed(1)} · {sf.completedOrdersCnt} orders
                          </span>
                          <div className="mt-1">
                            <Link
                              href={`/verify/${sf.organization.platformCode}`}
                              className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-emerald-700 hover:underline"
                            >
                              Verify QR: {sf.organization.platformCode}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          </div>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                        <span className="rounded-md bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
                          Min Pickup: {(sf.minPickupGrams / 1000).toFixed(0)} kg
                        </span>
                        <span className="rounded-md bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
                          Radius: {sf.organization.serviceRadiusKm} km ({sf.organization.city})
                        </span>
                        <span className="rounded-md bg-blue-50 px-2.5 py-1 font-semibold text-blue-800">
                          Status: {sf.organization.verificationLevel}
                        </span>
                        {sf.organization.recyclerRegistration?.cpcbPortalChecked && (
                          <span className="rounded-md bg-purple-100 px-2.5 py-1 font-bold text-purple-900">
                            CPCB Ref: {sf.organization.recyclerRegistration.registrationNumber}
                          </span>
                        )}
                      </div>

                      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-slate-50 text-slate-600">
                            <tr>
                              <th className="px-3 py-2 font-semibold">Material Stream</th>
                              <th className="px-3 py-2 font-semibold">Pickup Offer</th>
                              <th className="px-3 py-2 font-semibold">Gate Drop-off</th>
                              <th className="px-3 py-2 font-semibold">Min Qty</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {sf.rateItems.map((ri) => (
                              <tr key={ri.id} className="hover:bg-slate-50/80">
                                <td className="px-3 py-2 font-medium text-slate-900">
                                  {matLabel(ri.material)}
                                  {ri.material.isRegulatedHazardous && (
                                    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                                      Regulated
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 font-bold text-emerald-700">
                                  {formatInr(ri.pickupRatePaise)}/{ri.material.defaultUnit}
                                </td>
                                <td className="px-3 py-2 font-semibold text-teal-700">
                                  {formatInr(ri.dropoffRatePaise)}/{ri.material.defaultUnit}
                                </td>
                                <td className="px-3 py-2 text-slate-500">
                                  {(ri.minWeightGrams / 1000).toFixed(1)} kg
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => speakStorefrontRateCard(sf)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                      >
                        <Volume2 className="h-4 w-4 text-emerald-700" />
                        Speak Rate Card ({LANGUAGE_META[lang].nativeLabel})
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setBookingStorefront(sf);
                          if (sf.rateItems[0]) {
                            setSelectedSlug(sf.rateItems[0].material.slug);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-700 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-emerald-800"
                      >
                        Sell / Request Pickup
                        <ArrowUpRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 2: OPEN MULTI-BUYER BIDDING BOARD                                 */}
        {/* ===================================================================== */}
        {activeTab === "bidding" && (
          <div className="grid gap-6 lg:grid-cols-12">
            <form
              onSubmit={handleCreateOpenBroadcast}
              className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-4"
            >
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900">
                <Gavel className="h-3.5 w-3.5" /> Broadcast Open Scrap Lot
              </div>
              <h2 className="text-lg font-bold text-slate-900">
                Let Nearby Buyers Compete With Price Offers
              </h2>
              <p className="text-xs text-slate-600">
                Your exact street address stays hidden on open listings and is shared strictly after you accept a winning buyer&apos;s offer.
              </p>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Lot Headline
                </label>
                <input
                  required
                  value={bcastTitle}
                  onChange={(e) => setBcastTitle(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Primary Material Stream
                </label>
                <select
                  value={bcastSlug}
                  onChange={(e) => setBcastSlug(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  {materials.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {matLabel(m)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Estimated Weight (kg)
                </label>
                <input
                  type="number"
                  min="1"
                  step="0.5"
                  value={bcastKg}
                  onChange={(e) => setBcastKg(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <button
                type="submit"
                className="w-full rounded-xl bg-emerald-700 py-2.5 text-sm font-bold text-white shadow hover:bg-emerald-800"
              >
                Post Open Broadcast Lot
              </button>
            </form>

            <div className="space-y-4 lg:col-span-8">
              {openListings.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                  No open broadcast lots awaiting bids right now — post one on the left!
                </div>
              ) : (
                openListings.map((lot) => {
                  const isOwner = currentUser?.id === lot.ownerId;
                  const canBid =
                    currentUser &&
                    !isOwner &&
                    currentUser.role !== "CUSTOMER" &&
                    currentUser.role !== "ADMIN";

                  return (
                    <div
                      key={lot.id}
                      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-700">
                            Seller: {lot.ownerDisplayName} ({lot.ownerPlatformCode}) · PIN{" "}
                            {lot.pickupPincode}
                          </span>
                          <h3 className="mt-1.5 text-base font-bold text-slate-900">
                            {lot.title}
                          </h3>
                          <div className="mt-1 text-xs text-slate-600">
                            Items:{" "}
                            {lot.items
                              .map(
                                (i) =>
                                  `${matLabel(i.material)} (${(
                                    i.estimatedGrams / 1000
                                  ).toFixed(1)} kg)`
                              )
                              .join(" + ")}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-[11px] text-slate-500">Indicative Baseline</div>
                          <div className="text-base font-extrabold text-slate-900">
                            {formatInr(lot.indicativeEstimatePaise)}
                          </div>
                        </div>
                      </div>

                      {/* Competing Offers List */}
                      <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
                        <div className="text-xs font-bold text-slate-700">
                          Competing Buyer Offers ({lot.offers.length})
                        </div>

                        {lot.offers.map((off) => (
                          <div
                            key={off.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-50/60 px-3.5 py-2.5 text-xs"
                          >
                            <div>
                              <span className="font-bold text-slate-900">
                                {off.buyer.organization?.businessName ??
                                  off.buyer.profile?.displayName ??
                                  off.buyer.platformCode}
                              </span>{" "}
                              <span className="text-slate-500">
                                ({off.buyer.tier} · Offer v{off.version})
                              </span>
                              {off.notes && (
                                <div className="text-[11px] text-slate-600">{off.notes}</div>
                              )}
                            </div>

                            <div className="flex items-center gap-3">
                              <span className="text-sm font-extrabold text-emerald-800">
                                {formatInr(off.offeredTotalPaise)}
                              </span>
                              {isOwner && off.status === "OPEN" && (
                                <button
                                  onClick={() => handleAcceptBidOffer(off.id)}
                                  className="rounded-lg bg-emerald-700 px-3 py-1.5 font-bold text-white hover:bg-emerald-800"
                                >
                                  Accept Offer
                                </button>
                              )}
                            </div>
                          </div>
                        ))}

                        {canBid && (
                          <div className="mt-3 flex gap-2 pt-1">
                            <input
                              type="number"
                              placeholder="Your Total Offer in ₹ (e.g., 15500)"
                              value={offerAmountsInr[lot.id] ?? ""}
                              onChange={(e) =>
                                setOfferAmountsInr((prev) => ({
                                  ...prev,
                                  [lot.id]: e.target.value,
                                }))
                              }
                              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-xs"
                            />
                            <button
                              type="button"
                              onClick={() => handleSubmitBidOffer(lot.id)}
                              className="rounded-xl bg-teal-700 px-4 py-2 text-xs font-bold text-white hover:bg-teal-800"
                            >
                              Submit Competing Offer
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 3: ROLE WORKSPACE — BINS, UPWARD SALE, DISMANTLING, KHATA & ORDERS*/}
        {/* ===================================================================== */}
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            {!currentUser ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
                <p className="text-sm font-semibold text-slate-700">
                  Select a role in the header switcher to inspect your workspace.
                </p>
              </div>
            ) : (
              <>
                {/* Platform ID Card + Rate Menu Editor */}
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-2xl bg-gradient-to-br from-emerald-900 to-teal-950 p-6 text-white shadow">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="max-w-sm space-y-2.5">
                        <div className="flex items-center gap-2">
                          <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold">
                            Platform-Issued Digital Identity
                          </span>
                          <span className="font-mono text-sm font-extrabold text-amber-300">
                            {currentUser.platformCode}
                          </span>
                        </div>
                        <h3 className="text-xl font-bold">
                          {currentUser.profile?.displayName ?? currentUser.role}
                        </h3>
                        <p className="text-xs text-emerald-200">
                          Role: {currentUser.role} · Hierarchy: {currentUser.tier} · Status:{" "}
                          {currentUser.verificationLevel}
                        </p>
                        <p className="rounded-xl bg-black/25 p-3 text-[11px] text-emerald-100">
                          {currentUser.platformIdDisclaimer}
                        </p>
                        <Link
                          href={`/verify/${currentUser.platformCode}`}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-3.5 py-2 text-xs font-bold text-white hover:bg-white/25"
                        >
                          Open & Print Shop QR Badge (/verify/{currentUser.platformCode})
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </div>

                      <div className="shrink-0">
                        <QrMatrixCard
                          value={
                            typeof window !== "undefined"
                              ? `${window.location.origin}/verify/${currentUser.platformCode}`
                              : `/verify/${currentUser.platformCode}`
                          }
                          size={120}
                          title="Scan My ID"
                          subtitle={currentUser.platformCode}
                        />
                      </div>
                    </div>
                  </div>

                  {currentUser.role !== "CUSTOMER" && currentUser.role !== "ADMIN" && (
                    <form
                      onSubmit={handlePublishRate}
                      className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                    >
                      <h3 className="text-base font-bold text-slate-900">
                        Update My Storefront Purchase Rate Menu (Versioned)
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Updating a rate archives the prior offer version rather than rewriting history.
                      </p>

                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="sm:col-span-3">
                          <label className="block text-xs font-semibold text-slate-700">
                            Material Category
                          </label>
                          <select
                            value={newRateSlug}
                            onChange={(e) => setNewRateSlug(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                          >
                            {materials.map((m) => (
                              <option key={m.slug} value={m.slug}>
                                {m.nameEn}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-slate-700">
                            Pickup Rate (₹/kg)
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="0.5"
                            value={newPickupInr}
                            onChange={(e) => setNewPickupInr(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-slate-700">
                            Gate Drop-off (₹/kg)
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="0.5"
                            value={newDropoffInr}
                            onChange={(e) => setNewDropoffInr(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                          />
                        </div>

                        <div className="flex items-end">
                          <button
                            type="submit"
                            className="w-full rounded-xl bg-emerald-700 py-2 text-xs font-bold text-white hover:bg-emerald-800"
                          >
                            Publish Rate Card
                          </button>
                        </div>
                      </div>
                    </form>
                  )}
                </div>

                {/* Aggregated Stock Bins with 1-Click UPWARD HIERARCHY SALE */}
                {currentUser.role !== "CUSTOMER" && currentUser.role !== "ADMIN" && (
                  <div className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-base font-bold text-slate-900">
                          Aggregated Stock Bins → Sell Upward to Higher Tier (BatchLineage Tracked)
                        </h3>
                        <p className="text-xs text-slate-500">
                          Sell sorted bin stock upward (`T1 → T2 → T3 → T4`) while automatically linking contributing child pickups into `BatchLineage`.
                        </p>
                      </div>
                      <PackageCheck className="h-6 w-6 text-emerald-700" />
                    </div>

                    {bins.length === 0 ? (
                      <p className="mt-4 text-xs text-slate-500">
                        No stock in bins yet — dismantle an appliance below or settle an incoming pickup order!
                      </p>
                    ) : (
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        {bins.map((b) => (
                          <div
                            key={b.id}
                            className="flex flex-col justify-between rounded-xl border border-emerald-100 bg-emerald-50/50 p-4"
                          >
                            <div>
                              <div className="text-xs font-bold text-slate-800">
                                {matLabel(b.material)}
                              </div>
                              <div className="mt-1 text-2xl font-extrabold text-emerald-800">
                                {(b.availableGrams / 1000).toFixed(2)} kg
                              </div>
                              <div className="text-[11px] text-slate-600">
                                Cost Basis: {formatInr(b.weightedAvgCostPaise)}/kg
                              </div>
                            </div>

                            {currentUser.tier !== "TIER_4_AUTHORISED_RECYCLER" &&
                              b.availableGrams > 0 && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenSellUpwardModal(b)}
                                  className="mt-3 inline-flex items-center justify-center gap-1 rounded-xl bg-emerald-800 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-900"
                                >
                                  Sell Bin Upward
                                  <ArrowUpRight className="h-3.5 w-3.5" />
                                </button>
                              )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Appliance Dismantling Splitter + Morning Cash Advance Khata */}
                {currentUser.role !== "CUSTOMER" && currentUser.role !== "ADMIN" && (
                  <div className="grid gap-6 lg:grid-cols-2">
                    <form
                      onSubmit={handleRecordDismantle}
                      className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                    >
                      <div className="flex items-center gap-2">
                        <Wrench className="h-5 w-5 text-teal-700" />
                        <h3 className="text-base font-bold text-slate-900">
                          Appliance & E-Waste Dismantling Splitter
                        </h3>
                      </div>
                      <p className="text-xs text-slate-500">
                        Enforces physics mass conservation (`Outputs + Residue ≤ Input Weight`) and adds recovered streams straight into your Stock Bins.
                      </p>

                      <div className="grid grid-cols-2 gap-2.5 text-xs">
                        <div className="col-span-2">
                          <label className="font-semibold text-slate-700">
                            Appliance / Batch Description
                          </label>
                          <input
                            value={dismantleDesc}
                            onChange={(e) => setDismantleDesc(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700">Input Total (kg)</label>
                          <input
                            type="number"
                            step="0.1"
                            value={dismantleInputKg}
                            onChange={(e) => setDismantleInputKg(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700">Clean Copper (kg)</label>
                          <input
                            type="number"
                            step="0.1"
                            value={dismantleCopperKg}
                            onChange={(e) => setDismantleCopperKg(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700">Grade-A PCB (kg)</label>
                          <input
                            type="number"
                            step="0.1"
                            value={dismantlePcbKg}
                            onChange={(e) => setDismantlePcbKg(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5"
                          />
                        </div>
                        <div>
                          <label className="font-semibold text-slate-700">Heavy Iron (kg)</label>
                          <input
                            type="number"
                            step="0.1"
                            value={dismantleIronKg}
                            onChange={(e) => setDismantleIronKg(e.target.value)}
                            className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-1.5"
                          />
                        </div>
                      </div>

                      <button
                        type="submit"
                        className="w-full rounded-xl bg-teal-700 py-2 text-xs font-bold text-white hover:bg-teal-800"
                      >
                        Log Dismantling & Stock Pure Bins
                      </button>
                    </form>

                    {/* Khata Cash Advances (Peshgi) */}
                    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2">
                        <Wallet className="h-5 w-5 text-amber-600" />
                        <h3 className="text-base font-bold text-slate-900">
                          Supplier Morning Cash Advance (*Peshgi*) & Khata
                        </h3>
                      </div>
                      <form onSubmit={handleIssueKhataAdvance} className="grid grid-cols-3 gap-2 text-xs">
                        <input
                          placeholder="Collector ID (KC-COL-...)"
                          value={khataBorrowerCode}
                          onChange={(e) => setKhataBorrowerCode(e.target.value)}
                          className="rounded-xl border border-slate-300 px-2.5 py-2"
                        />
                        <input
                          type="number"
                          placeholder="Advance ₹"
                          value={khataAmountInr}
                          onChange={(e) => setKhataAmountInr(e.target.value)}
                          className="rounded-xl border border-slate-300 px-2.5 py-2"
                        />
                        <button
                          type="submit"
                          className="rounded-xl bg-amber-600 px-3 py-2 font-bold text-white hover:bg-amber-700"
                        >
                          Issue Cash Advance
                        </button>
                      </form>

                      <div className="max-h-44 divide-y divide-slate-100 overflow-y-auto text-xs">
                        {khataEntries.map((k) => (
                          <div key={k.id} className="flex items-center justify-between py-2">
                            <div>
                              <span className="font-bold text-slate-800">{k.entryType}</span>
                              <div className="text-[11px] text-slate-500">
                                {k.lender.platformCode} → {k.borrower.platformCode}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold text-slate-900">
                                {formatInr(k.amountPaise)}
                              </div>
                              <div className="text-[11px] text-amber-800">
                                Due Balance: {formatInr(k.balanceAfterPaise)}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Active & Completed Transactions Table with Trace QR Links */}
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-base font-bold text-slate-900">
                      My Transactions, Settlements & Multi-Tier Lineage Links ({orders.length})
                    </h3>
                    <button
                      onClick={() => loadRoleWorkspace(currentUser)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Refresh
                    </button>
                  </div>

                  {orders.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-500">
                      No transactions on this account yet — click &ldquo;Sell / Request Pickup&rdquo; on any Storefront card!
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {orders.map((ord) => {
                        const isBuyer = ord.buyerId === currentUser.id;
                        return (
                          <div
                            key={ord.id}
                            className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 p-4"
                          >
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-xs font-bold text-slate-900">
                                  {ord.orderNumber}
                                </span>
                                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-900">
                                  {ord.status}
                                </span>
                                <span className="text-xs text-slate-500">
                                  {ord.sellerTier} → {ord.buyerTier}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-slate-600">
                                Items:{" "}
                                {ord.items
                                  .map(
                                    (i) =>
                                      `${i.material.nameEn} (${(
                                        (i.actualGrams ?? i.estimatedGrams) / 1000
                                      ).toFixed(2)} kg @ ${formatInr(i.lockedRatePaise)}/kg)`
                                  )
                                  .join(" · ")}
                              </div>
                              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                                <Link
                                  href={`/trace/${ord.qrTraceToken}`}
                                  className="inline-flex items-center gap-1 font-mono text-[11px] font-bold text-emerald-700 hover:underline"
                                >
                                  <GitBranch className="h-3.5 w-3.5" />
                                  Open Lineage QR (/trace/{ord.qrTraceToken})
                                </Link>
                                {ord.paymentRecords && ord.paymentRecords.length > 0 && (
                                  <span className="text-[11px] text-slate-500">
                                    Split:{" "}
                                    {ord.paymentRecords
                                      .map((p) => `${p.method} ${formatInr(p.amountPaise)}`)
                                      .join(" + ")}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-3">
                              <div className="text-right">
                                <div className="text-[11px] text-slate-500">
                                  {ord.finalSettlementPaise !== null
                                    ? "Final Weighed Settlement"
                                    : "Agreed Offer"}
                                </div>
                                <div className="text-base font-extrabold text-emerald-800">
                                  {formatInr(
                                    ord.finalSettlementPaise ?? ord.agreedTotalPaise
                                  )}
                                </div>
                              </div>

                              {isBuyer && ord.status === "REQUESTED" && (
                                <button
                                  onClick={() => handleAcceptOrder(ord.id)}
                                  className="rounded-xl bg-blue-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-blue-700"
                                >
                                  Accept Pickup
                                </button>
                              )}

                              {isBuyer &&
                                (ord.status === "REQUESTED" || ord.status === "ACCEPTED") && (
                                  <button
                                    onClick={() => handleWeighAndSettle(ord)}
                                    className="rounded-xl bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-800"
                                  >
                                    Weigh & Settle
                                  </button>
                                )}

                              <button
                                type="button"
                                onClick={() => setSlipOrderId(ord.id)}
                                className="inline-flex items-center gap-1 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-950 hover:bg-emerald-100"
                              >
                                <Receipt className="h-3.5 w-3.5" /> UPI QR & Slip
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ===================================================================== */}
        {/* TAB 4: UNIFIED CAMERA AI VISION, 7-SEG SCALE OCR & BOM X-RAY STUDIO   */}
        {/* ===================================================================== */}
        {activeTab === "xray" && (
          <CameraAiStudio
            lang={lang}
            accessToken={accessToken}
            hasUser={Boolean(currentUser)}
            pendingBuyerOrders={orders.filter(
              (o) =>
                currentUser &&
                o.buyerId === currentUser.id &&
                (o.status === "REQUESTED" || o.status === "ACCEPTED")
            )}
            onSpeak={speakTextAloud}
            onNotify={notify}
            onOrderSettled={async () => {
              await loadRoleWorkspace(currentUser);
            }}
          />
        )}

        {/* ===================================================================== */}
        {/* TAB 4.5: MARKET TRENDS, IDEMPOTENT OFFLINE SYNC & DISPUTE ARBITRATION */}
        {/* ===================================================================== */}
        {activeTab === "operations" && (
          <OperationsHub
            accessToken={accessToken}
            userRole={currentUser?.role ?? null}
            orders={orders}
            onRefreshWorkspace={async () => {
              await loadRoleWorkspace(currentUser);
            }}
            onNotify={notify}
          />
        )}

        {/* ===================================================================== */}
        {/* TAB 5: SECURITY CONTROLS, REGISTRATION, ADMIN KYC & APPEND-ONLY AUDIT */}
        {/* ===================================================================== */}
        {activeTab === "security" && (
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900">
                  Account Onboarding & OWASP Controls
                </h2>
                <Lock className="h-5 w-5 text-emerald-700" />
              </div>

              <div className="flex rounded-xl bg-slate-100 p-1 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setAuthMode("register")}
                  className={`flex-1 rounded-lg py-1.5 ${
                    authMode === "register" ? "bg-white shadow" : "text-slate-600"
                  }`}
                >
                  Create New Account
                </button>
                <button
                  type="button"
                  onClick={() => setAuthMode("login")}
                  className={`flex-1 rounded-lg py-1.5 ${
                    authMode === "login" ? "bg-white shadow" : "text-slate-600"
                  }`}
                >
                  Password Login
                </button>
              </div>

              {authMode === "register" ? (
                <form onSubmit={handleCustomRegister} className="space-y-3 text-xs">
                  <div>
                    <label className="font-semibold text-slate-700">Display / Shop Name</label>
                    <input
                      required
                      value={regName}
                      onChange={(e) => setRegName(e.target.value)}
                      placeholder="e.g., Gurpreet Scrap Store"
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700">Mobile Number</label>
                    <input
                      required
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value)}
                      placeholder="+919872001122"
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700">Role</label>
                    <select
                      value={regRole}
                      onChange={(e) => setRegRole(e.target.value as typeof regRole)}
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="CUSTOMER">Customer / Household (Tier 0)</option>
                      <option value="COLLECTOR">Local Collector / Kabadiwala (Tier 1)</option>
                      <option value="SCRAP_BUSINESS">Area Scrap Business (Tier 2/3)</option>
                      <option value="AUTHORISED_RECYCLER">
                        Authorised Recycler Applicant (Starts Unverified)
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700">
                      Password (Hashed with Argon2id)
                    </label>
                    <input
                      type="password"
                      required
                      value={regPass}
                      onChange={(e) => setRegPass(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-emerald-700 py-2.5 text-sm font-bold text-white hover:bg-emerald-800"
                  >
                    Register & Issue Platform ID
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleQuickSwitch(loginId, loginPass);
                  }}
                  className="space-y-3 text-xs"
                >
                  <div>
                    <label className="font-semibold text-slate-700">Email or Mobile</label>
                    <input
                      value={loginId}
                      onChange={(e) => setLoginId(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="font-semibold text-slate-700">Password</label>
                    <input
                      type="password"
                      value={loginPass}
                      onChange={(e) => setLoginPass(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-emerald-700 py-2.5 text-sm font-bold text-white hover:bg-emerald-800"
                  >
                    Sign In
                  </button>
                </form>
              )}

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs">
                <div className="font-bold text-slate-800">Live Backend Authorization Probe</div>
                <p className="mt-1 text-slate-600">
                  Test calling <code className="font-mono">/api/v1/admin/audit-events</code> as ({currentUser?.role ?? "Anonymous"}):
                </p>
                <button
                  type="button"
                  onClick={triggerLiveRbacDefenseDemo}
                  className="mt-3 w-full rounded-xl border border-slate-300 bg-white py-2 font-bold text-slate-800 hover:bg-slate-100"
                >
                  Test Server-Side Admin RBAC Guard
                </button>
              </div>
            </div>

            <div className="space-y-5 lg:col-span-7">
              {currentUser?.role !== "ADMIN" ? (
                <>
                  <KycVerificationPortal
                    accessToken={accessToken}
                    userRole={currentUser?.role ?? null}
                    platformCode={currentUser?.platformCode ?? null}
                    displayName={currentUser?.profile?.displayName ?? null}
                    adminCases={[]}
                    onRefreshWorkspace={async () => {
                      await loadRoleWorkspace(currentUser);
                    }}
                    onNotify={notify}
                  />

                  <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-5">
                    <h3 className="text-sm font-bold text-amber-950">
                      Admin Review Queue Restricted by Server RBAC
                    </h3>
                    <p className="mt-1 text-xs text-amber-900">
                      Switch to <strong>&ldquo;Security Admin&rdquo;</strong> in the top bar after uploading private vault evidence above to inspect 60-second signed document links and approve cases!
                    </p>
                  </div>
                </>
              ) : (
                <>
                  {adminMetrics && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="text-[11px] font-semibold text-slate-500">Accounts</div>
                        <div className="mt-1 text-2xl font-extrabold">
                          {adminMetrics.totalUsers}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="text-[11px] font-semibold text-slate-500">Storefronts</div>
                        <div className="mt-1 text-2xl font-extrabold text-emerald-700">
                          {adminMetrics.activeStorefronts}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="text-[11px] font-semibold text-slate-500">Pending KYC</div>
                        <div className="mt-1 text-2xl font-extrabold text-amber-600">
                          {adminMetrics.pendingVerifications}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-white p-4">
                        <div className="text-[11px] font-semibold text-slate-500">
                          Audit Events
                        </div>
                        <div className="mt-1 text-2xl font-extrabold text-indigo-700">
                          {adminMetrics.immutableAuditEvents}
                        </div>
                      </div>
                    </div>
                  )}

                  <KycVerificationPortal
                    accessToken={accessToken}
                    userRole={currentUser?.role ?? null}
                    platformCode={currentUser?.platformCode ?? null}
                    displayName={currentUser?.profile?.displayName ?? null}
                    adminCases={adminCases as never[]}
                    onRefreshWorkspace={async () => {
                      await loadRoleWorkspace(currentUser);
                      await loadPublicMarketplace();
                    }}
                    onNotify={notify}
                  />

                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-base font-bold text-slate-900">
                      Append-Only Security & Operational Audit Trail
                    </h3>
                    <div className="mt-3 max-h-80 divide-y divide-slate-100 overflow-y-auto text-xs">
                      {auditEvents.map((ev) => (
                        <div key={String(ev.id)} className="flex justify-between py-2">
                          <div>
                            <span
                              className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                ev.outcome === "SUCCESS"
                                  ? "bg-emerald-100 text-emerald-900"
                                  : "bg-rose-100 text-rose-900"
                              }`}
                            >
                              {String(ev.outcome)}
                            </span>
                            <span className="font-mono font-bold text-slate-800">
                              {String(ev.action)}
                            </span>
                            {Boolean(ev.reason) && (
                              <span className="ml-2 text-slate-500">— {String(ev.reason)}</span>
                            )}
                          </div>
                          <span className="shrink-0 font-mono text-[11px] text-slate-400">
                            {new Date(String(ev.createdAt)).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Upward Stock-Bin Hierarchy Sale Modal */}
      {upwardBin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form
            onSubmit={handleExecuteSellUpward}
            className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl"
          >
            <h3 className="text-lg font-bold text-slate-900">
              Sell Stock Bin Upward: {matLabel(upwardBin.material)}
            </h3>
            <p className="text-xs text-slate-500">
              Available in Bin: <strong>{(upwardBin.availableGrams / 1000).toFixed(2)} kg</strong> ·
              Automatically links child source orders into <code className="font-mono">BatchLineage</code>.
            </p>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Select Higher-Tier Buyer Storefront
              </label>
              <select
                required
                value={upwardStorefrontId}
                onChange={(e) => setUpwardStorefrontId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-xs"
              >
                {eligibleHigherStorefrontsForModal.map((sf) => {
                  const r = sf.rateItems.find(
                    (ri) => ri.material.slug === upwardBin.material.slug
                  );
                  return (
                    <option key={sf.id} value={sf.id}>
                      {sf.shopTitle} ({sf.organization.tier}) — Gate Rate{" "}
                      {r ? formatInr(r.dropoffRatePaise) : ""}/kg
                    </option>
                  );
                })}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Batch Quantity to Sell Upward (kg)
              </label>
              <input
                type="number"
                step="0.5"
                min="0.5"
                max={(upwardBin.availableGrams / 1000).toFixed(2)}
                value={upwardKg}
                onChange={(e) => setUpwardKg(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setUpwardBin(null)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-800"
              >
                Book Upward Sale & Link Lineage
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Direct Storefront Order Modal */}
      {bookingStorefront && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <form
            onSubmit={handleCreateOrderRequest}
            className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl"
          >
            <h3 className="text-lg font-bold text-slate-900">
              Sell Scrap to {bookingStorefront.shopTitle}
            </h3>
            <p className="text-xs text-slate-500">
              Locks current published rate version; final payout settled upon actual scale weighing.
            </p>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Select Material from Buyer Rate Card
              </label>
              <select
                value={selectedSlug}
                onChange={(e) => setSelectedSlug(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              >
                {bookingStorefront.rateItems.map((ri) => (
                  <option key={ri.id} value={ri.material.slug}>
                    {matLabel(ri.material)} — Pickup {formatInr(ri.pickupRatePaise)}/kg · Gate{" "}
                    {formatInr(ri.dropoffRatePaise)}/kg
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Estimated Weight (kg)
                </label>
                <input
                  type="number"
                  min="1"
                  step="0.5"
                  value={estimatedKg}
                  onChange={(e) => setEstimatedKg(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Handover Mode
                </label>
                <select
                  value={fulfillmentMode}
                  onChange={(e) =>
                    setFulfillmentMode(e.target.value as "BUYER_PICKUP" | "SELLER_DROPOFF")
                  }
                  className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="BUYER_PICKUP">Doorstep Pickup</option>
                  <option value="SELLER_DROPOFF">Shop Gate Drop-off</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBookingStorefront(null)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-800"
              >
                Confirm Request
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Dynamic UPI Pay QR & 80mm Bilingual Thermal Settlement Slip Modal */}
      <SettlementSlipModal
        orderId={slipOrderId}
        accessToken={accessToken}
        lang={lang}
        onClose={() => setSlipOrderId(null)}
      />

      {/* Persistent 4-Language Vernacular Audio Readout Bar (EN / HI / PA / MR) */}
      {liveSpeechBar && (
        <div className="fixed bottom-4 left-4 z-40 max-w-xl rounded-2xl border border-emerald-500/40 bg-emerald-950/95 px-4 py-3 text-xs text-white shadow-2xl">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-bold text-amber-300">
              <Volume2 className="h-4 w-4 animate-pulse" />
              <span>
                Spoken Vernacular Audio · {LANGUAGE_META[liveSpeechBar.lang].nativeLabel} (
                {LANGUAGE_META[liveSpeechBar.lang].locale})
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => speakTextAloud(liveSpeechBar.text, "info")}
                className="rounded-lg bg-white/15 px-2 py-1 font-bold hover:bg-white/25"
              >
                Replay
              </button>
              <button
                type="button"
                onClick={() => {
                  stopVernacularSpeech();
                  setLiveSpeechBar(null);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-rose-600/80 px-2 py-1 font-bold hover:bg-rose-600"
              >
                <Square className="h-3 w-3" /> Close
              </button>
            </div>
          </div>
          <p className="mt-1.5 leading-relaxed text-emerald-100">{liveSpeechBar.text}</p>
        </div>
      )}
    </div>
  );
}
