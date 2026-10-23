import {
  SupportedLanguage,
  VerificationLevel,
  calculateAmountPaise,
  paiseToInrString,
} from "@kabadi/shared";
import { getPrisma } from "../../lib/prisma";
import {
  OnnxDeviceXrayPrediction,
  VernacularAiIntent,
  runDeviceXrayCnnV2Inference,
  runMandiForecasterOnnxInference,
  runVernacularIntentOnnxInference,
} from "./onnx.engine";
import {
  ImageQualityForensics,
  analyzeImageForensics,
  extractRgbChw64Tensor,
} from "./vision.engine";
import { voiceLocaleForLanguage } from "./vernacular.service";

const VERIFICATION_RANK: Record<VerificationLevel, number> = {
  LEVEL_0_REGISTERED: 0,
  LEVEL_1_CONTACT_VERIFIED: 1,
  LEVEL_2_IDENTITY_REVIEWED: 2,
  LEVEL_3_BUSINESS_VERIFIED: 3,
  LEVEL_4_AUTHORISED_RECYCLER: 4,
};

// ============================================================================
// CAPABILITY 1: MULTI-TASK 2D CNN CAMERA PHOTO DEVICE X-RAY & LIVE BOM ENGINE
// ============================================================================

export async function runCameraDeviceXrayValuation(params: {
  actorId: string;
  imageBuffer?: Buffer | null;
  mediaStorageKey?: string | null;
  deviceQuery?: string;
  observedCondition?:
    | "POWERS_ON_INTACT"
    | "CRACKED_SCREEN_BOOTS"
    | "DEAD_BOOT_INTACT_BODY"
    | "HEAVILY_DAMAGED_SCRAP";
  coilTypeHint?: "UNKNOWN" | "COPPER" | "ALUMINUM";
}) {
  const prisma = await getPrisma();
  const allRefs = await prisma.deviceReferenceBOM.findMany();
  if (allRefs.length === 0) {
    throw new Error("NO_BOM_REFERENCE");
  }

  let forensics: ImageQualityForensics | null = null;
  let cnnXray: OnnxDeviceXrayPrediction | null = null;

  if (params.imageBuffer) {
    const [imgForensics, rgbChw64] = await Promise.all([
      analyzeImageForensics(params.imageBuffer),
      extractRgbChw64Tensor(params.imageBuffer),
    ]);
    forensics = imgForensics;
    cnnXray = await runDeviceXrayCnnV2Inference(rgbChw64);
  }

  const effectiveCondition =
    params.observedCondition ??
    cnnXray?.predictedVisualCondition ??
    "DEAD_BOOT_INTACT_BODY";

  const effectiveCoil =
    params.coilTypeHint && params.coilTypeHint !== "UNKNOWN"
      ? params.coilTypeHint
      : cnnXray?.predictedCoilType ?? "UNKNOWN";

  // Match BOM record: prioritize CNN visual prediction when camera photo supplied,
  // allowing explicit coil override or text query refinement.
  let matched = cnnXray
    ? allRefs.find((r) => {
        if (
          params.coilTypeHint &&
          params.coilTypeHint !== "UNKNOWN" &&
          r.deviceCategory === "SPLIT_AC" &&
          r.coilType !== params.coilTypeHint
        ) {
          return false;
        }
        return r.slug === cnnXray.predictedBomSlug;
      }) ?? allRefs.find((r) => r.slug === cnnXray.predictedBomSlug)
    : undefined;

  if (!matched) {
    const q = (params.deviceQuery ?? "").toLowerCase();
    matched =
      allRefs.find((ref) => {
        if (
          effectiveCoil !== "UNKNOWN" &&
          ref.coilType &&
          ref.coilType !== effectiveCoil
        ) {
          return false;
        }
        return (
          q.includes(ref.slug.replace(/-/g, " ")) ||
          ref.modelName
            .toLowerCase()
            .split(" ")
            .some((tok) => tok.length > 2 && q.includes(tok)) ||
          q.includes(ref.deviceCategory.toLowerCase().replace(/_/g, " "))
        );
      }) ?? allRefs[0]!;
  }

  // Pull live active StorefrontRateItem prices so internal component BOM values track real mandi prices!
  const activeRates = await prisma.storefrontRateItem.findMany({
    where: { isActive: true, storefront: { isOpen: true } },
    include: { material: true, storefront: { include: { organization: true } } },
  });

  const ratesBySlug = new Map<string, { minPaise: number; maxPaise: number }>();
  for (const r of activeRates) {
    const slug = r.material.slug;
    const prev = ratesBySlug.get(slug);
    if (!prev) {
      ratesBySlug.set(slug, {
        minPaise: r.pickupRatePaise,
        maxPaise: r.dropoffRatePaise,
      });
    } else {
      prev.minPaise = Math.min(prev.minPaise, r.pickupRatePaise);
      prev.maxPaise = Math.max(prev.maxPaise, r.dropoffRatePaise);
    }
  }

  const rawComponents = Array.isArray(matched.componentsJson)
    ? (matched.componentsJson as Array<{
        materialSlug: string;
        label: string;
        grams: number;
        indicativeValuePaise: number;
      }>)
    : [];

  const enrichedComponents = rawComponents.map((comp) => {
    const liveRate = ratesBySlug.get(comp.materialSlug);
    const liveMinPaise = liveRate
      ? calculateAmountPaise(comp.grams, liveRate.minPaise, "KG")
      : comp.indicativeValuePaise;
    const liveMaxPaise = liveRate
      ? calculateAmountPaise(comp.grams, liveRate.maxPaise, "KG")
      : comp.indicativeValuePaise;
    const dynamicMidPaise = Math.max(
      comp.indicativeValuePaise,
      Math.round((liveMinPaise + liveMaxPaise) / 2)
    );
    return {
      ...comp,
      indicativeValuePaise: dynamicMidPaise,
      liveMandiMinPaise: liveMinPaise,
      liveMandiMaxPaise: liveMaxPaise,
      liveMandiDisplayInr: `${paiseToInrString(liveMinPaise)} – ${paiseToInrString(
        liveMaxPaise
      )}`,
    };
  });

  const scrapFloorPaise = enrichedComponents.reduce(
    (sum, comp) => sum + comp.indicativeValuePaise,
    0
  );

  const q = (params.deviceQuery ?? "").toLowerCase();
  const confidence = cnnXray
    ? Number(cnnXray.deviceConfidence.toFixed(4))
    : q.length >= 6 &&
      matched.modelName.toLowerCase().includes(q.split(" ")[0] ?? "")
    ? 0.89
    : 0.72;

  const recommendedPathway =
    effectiveCondition === "POWERS_ON_INTACT" ||
    effectiveCondition === "CRACKED_SCREEN_BOOTS"
      ? "REFURBISH_OR_REPAIR"
      : effectiveCondition === "DEAD_BOOT_INTACT_BODY"
      ? "PARTS_HARVEST_AND_HIGH_GRADE_PCB"
      : "MATERIAL_RECOVERY_FLOOR";

  const modelVersion = cnnXray ? cnnXray.modelVersion : "kc-xray-bom-v1.0";

  const scanRecord = await prisma.aIScanRecord.create({
    data: {
      actorId: params.actorId,
      scanType: "DEVICE_XRAY",
      modelVersion,
      confidence,
      requiresHumanConfirm: true,
      imageSha256: forensics?.imageSha256 ?? null,
      perceptualHash: forensics?.perceptualHash64 ?? null,
      mediaStorageKey: params.mediaStorageKey ?? null,
      indicativeMinPaise: scrapFloorPaise,
      indicativeMaxPaise: matched.refurbishRangeMaxPaise,
      structuredResultJson: JSON.parse(
        JSON.stringify({
          matchedModel: matched.modelName,
          deviceCategory: matched.deviceCategory,
          coilType: matched.coilType,
          observedCondition: effectiveCondition,
          recommendedPathway,
          cnnXrayInference: cnnXray,
          imageForensics: forensics,
          components: enrichedComponents,
        })
      ),
    },
  });

  return {
    scanId: scanRecord.id,
    modelVersion: scanRecord.modelVersion,
    inferenceMode: cnnXray
      ? "CAMERA_PHOTO_2D_CNN_ONNX_MULTITASK"
      : "CATALOG_TEXT_MATCH_WITH_LIVE_RATES",
    confidence,
    requiresHumanConfirmation: true,
    priceType: "INDICATIVE_ESTIMATE" as const,
    cnnXrayInference: cnnXray,
    imageForensics: forensics,
    matchedDevice: {
      slug: matched.slug,
      category: matched.deviceCategory,
      modelName: matched.modelName,
      typicalWeightGrams: matched.typicalTotalGrams,
      coilType: matched.coilType,
      safetyGuidance: matched.safetyNotes,
    },
    observedCondition: effectiveCondition,
    recommendedPathway,
    internalComponentsXray: enrichedComponents.map((c) => ({
      ...c,
      indicativeValueInr: paiseToInrString(c.indicativeValuePaise).replace(/^₹/, ""),
    })),
    internalComponentBreakdown: enrichedComponents,
    indicativePathways: {
      scrapMaterialFloor: {
        minPaise: scrapFloorPaise,
        maxPaise: Math.round(scrapFloorPaise * 1.18),
        displayRangeInr: `${paiseToInrString(scrapFloorPaise)} – ${paiseToInrString(
          Math.round(scrapFloorPaise * 1.18)
        )}`,
      },
      partsHarvest: {
        minPaise: matched.partsHarvestMinPaise,
        maxPaise: matched.partsHarvestMaxPaise,
        displayRangeInr: `${paiseToInrString(
          matched.partsHarvestMinPaise
        )} – ${paiseToInrString(matched.partsHarvestMaxPaise)}`,
      },
      refurbishRepair: {
        minPaise: matched.refurbishRangeMinPaise,
        maxPaise: matched.refurbishRangeMaxPaise,
        displayRangeInr: `${paiseToInrString(
          matched.refurbishRangeMinPaise
        )} – ${paiseToInrString(matched.refurbishRangeMaxPaise)}`,
      },
      recommendedPathway,
    },
    valuationTiers: {
      materialRecoveryFloorPaise: scrapFloorPaise,
      materialRecoveryFloorInr: paiseToInrString(scrapFloorPaise),
      partsHarvestRangePaise: {
        min: matched.partsHarvestMinPaise,
        max: matched.partsHarvestMaxPaise,
      },
      partsHarvestRangeInr: `${paiseToInrString(
        matched.partsHarvestMinPaise
      )} – ${paiseToInrString(matched.partsHarvestMaxPaise)}`,
      refurbishRangePaise: {
        min: matched.refurbishRangeMinPaise,
        max: matched.refurbishRangeMaxPaise,
      },
      refurbishRangeInr: `${paiseToInrString(
        matched.refurbishRangeMinPaise
      )} – ${paiseToInrString(matched.refurbishRangeMaxPaise)}`,
    },
    honestDisclaimer:
      "Indicative AI component breakdown priced against live local mandi storefronts — subject to physical inspection and calibrated scale weighing.",
  };
}

// ============================================================================
// CAPABILITY 2: NEURAL MANDI PRICE FORECASTING, OUTLIER AUDIT & SMART MATCHING
// ============================================================================

export async function getMandiMarketIntelligence(city?: string) {
  const prisma = await getPrisma();
  const [materials, histories, activeRates] = await Promise.all([
    prisma.materialCategory.findMany({ where: { isActive: true } }),
    prisma.priceHistory.findMany({ orderBy: { recordedAt: "asc" } }),
    prisma.storefrontRateItem.findMany({
      where: { isActive: true, storefront: { isOpen: true } },
      include: {
        storefront: {
          include: {
            organization: {
              include: { recyclerRegistration: true },
            },
          },
        },
        material: true,
      },
    }),
  ]);

  const seriesVectors: Float32Array[] = [];
  const trackedMaterials = materials.filter((m) =>
    activeRates.some((r) => r.materialId === m.id)
  );

  const metaPerMat = trackedMaterials.map((m) => {
    const matRates = activeRates.filter(
      (r) =>
        r.materialId === m.id &&
        (!city ||
          r.storefront.organization.city.toLowerCase() === city.toLowerCase())
    );
    const effectiveRates =
      matRates.length > 0
        ? matRates
        : activeRates.filter((r) => r.materialId === m.id);

    const dropoffs = effectiveRates.map((r) => r.dropoffRatePaise);
    const pickups = effectiveRates.map((r) => r.pickupRatePaise);
    const minRate = Math.min(...pickups);
    const maxRate = Math.max(...dropoffs);
    const avgLivePaise = Math.round(
      dropoffs.reduce((s, v) => s + v, 0) / Math.max(1, dropoffs.length)
    );

    const matHist = histories
      .filter((h) => h.materialId === m.id)
      .map((h) => h.medianRatePaise);

    // Build 5 weekly points from history or smooth baseline ending at avgLivePaise
    const pts: number[] =
      matHist.length >= 5
        ? matHist.slice(-5)
        : [
            Math.round(avgLivePaise * 0.94),
            Math.round(avgLivePaise * 0.955),
            Math.round(avgLivePaise * 0.97),
            Math.round(avgLivePaise * 0.988),
            avgLivePaise,
          ];

    const rets: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const prev = Math.max(1, pts[i - 1]!);
      rets.push((pts[i]! - prev) / prev);
    }
    while (rets.length < 4) rets.unshift(0.008);
    const r4 = rets.slice(-4);
    const slope =
      0.45 * r4[3]! + 0.3 * r4[2]! + 0.15 * r4[1]! + 0.1 * r4[0]!;
    const meanPts = pts.reduce((a, b) => a + b, 0) / pts.length;
    const stdPts = Math.sqrt(
      pts.reduce((a, b) => a + (b - meanPts) ** 2, 0) / pts.length
    );
    const volCv = stdPts / Math.max(1, meanPts);
    const spreadRatio = (maxRate - minRate) / Math.max(1, avgLivePaise);
    const zLive = stdPts > 1 ? (avgLivePaise - meanPts) / stdPts : 0;

    seriesVectors.push(
      new Float32Array([
        r4[0]!,
        r4[1]!,
        r4[2]!,
        r4[3]!,
        slope,
        volCv,
        spreadRatio,
        zLive,
      ])
    );

    return {
      material: m,
      avgLivePaise,
      minRatePaise: minRate,
      maxRatePaise: maxRate,
      spreadRatio,
      volatilityPct: Number((volCv * 100).toFixed(2)),
    };
  });

  const neuralOut = await runMandiForecasterOnnxInference(seriesVectors);

  const forecasts = metaPerMat.map((item, idx) => {
    const f = neuralOut.forecasts[idx]!;
    const pred7dPaise = Math.max(
      100,
      Math.round(item.avgLivePaise * (1 + f.predicted7dDeltaPct / 100))
    );
    const pred14dPaise = Math.max(
      100,
      Math.round(item.avgLivePaise * (1 + f.predicted14dDeltaPct / 100))
    );

    const signal: "HOLD_STOCK_FOR_UPSIDE" | "SELL_NOW_STRONG_BID" | "ACCUMULATE_STEADY" =
      f.predicted7dDeltaPct >= 1.1
        ? "HOLD_STOCK_FOR_UPSIDE"
        : f.predicted7dDeltaPct <= -0.5
        ? "SELL_NOW_STRONG_BID"
        : "ACCUMULATE_STEADY";

    return {
      materialSlug: item.material.slug,
      nameEn: item.material.nameEn,
      nameHi: item.material.nameHi,
      namePa: item.material.namePa,
      nameMr: item.material.nameMr,
      streamGroup: item.material.streamGroup,
      currentAvgRatePaise: item.avgLivePaise,
      currentAvgRateInr: `${paiseToInrString(item.avgLivePaise)}/kg`,
      tierSpreadInr: `${paiseToInrString(item.minRatePaise)} → ${paiseToInrString(
        item.maxRatePaise
      )}`,
      predicted7dRatePaise: pred7dPaise,
      predicted7dRateInr: `${paiseToInrString(pred7dPaise)}/kg`,
      predicted7dDeltaPct: f.predicted7dDeltaPct,
      predicted14dRatePaise: pred14dPaise,
      predicted14dRateInr: `${paiseToInrString(pred14dPaise)}/kg`,
      predicted14dDeltaPct: f.predicted14dDeltaPct,
      volatilityPct: item.volatilityPct,
      confidence: f.confidence,
      tradingAction: signal,
    };
  });

  // Detect under-pricing anomalies within each supply-chain tier
  const underpricingAlerts: Array<{
    storefrontTitle: string;
    platformCode: string;
    tier: string;
    materialSlug: string;
    offeredPickupPaise: number;
    peerBenchmarkPaise: number;
    discountBelowMarketPct: number;
    warning: string;
  }> = [];

  for (const r of activeRates) {
    const peerSameTier = activeRates.filter(
      (p) =>
        p.materialId === r.materialId &&
        p.storefront.organization.tier === r.storefront.organization.tier
    );
    const benchmark =
      peerSameTier.length >= 2
        ? peerSameTier.reduce((s, p) => s + p.pickupRatePaise, 0) /
          peerSameTier.length
        : metaPerMat.find((m) => m.material.id === r.materialId)
            ?.minRatePaise ?? r.pickupRatePaise;

    if (benchmark > 0 && r.pickupRatePaise < benchmark * 0.85) {
      const pctBelow = Number(
        (((benchmark - r.pickupRatePaise) / benchmark) * 100).toFixed(1)
      );
      underpricingAlerts.push({
        storefrontTitle: r.storefront.shopTitle,
        platformCode: r.storefront.organization.platformCode,
        tier: r.storefront.organization.tier,
        materialSlug: r.material.slug,
        offeredPickupPaise: r.pickupRatePaise,
        peerBenchmarkPaise: Math.round(benchmark),
        discountBelowMarketPct: pctBelow,
        warning: `Offered rate (${paiseToInrString(
          r.pickupRatePaise
        )}/kg) is ${pctBelow}% below regional peer benchmark.`,
      });
    }
  }

  return {
    modelVersion: neuralOut.modelVersion,
    modelSha256: neuralOut.modelSha256,
    runtimeBackend: "onnxruntime-wasm-cpu" as const,
    cityFilter: city ?? "ALL_MANDIS",
    generatedAt: new Date().toISOString(),
    forecasts,
    underpricingAlerts,
    honestDisclaimer:
      "Neural mandi forecasts use historical multi-tier price series for seller awareness — market rates fluctuate daily with LME/domestic mill demand.",
  };
}

export async function runSmartBuyerMatch(params: {
  city?: string;
  pincode?: string;
  fulfillmentMode?: "BUYER_PICKUP" | "SELLER_DROPOFF";
  items: Array<{ materialSlug: string; weightGrams: number }>;
}) {
  const prisma = await getPrisma();
  const mode = params.fulfillmentMode ?? "SELLER_DROPOFF";

  const storefronts = await prisma.storefront.findMany({
    where: { isOpen: true },
    include: {
      organization: { include: { recyclerRegistration: true } },
      rateItems: { where: { isActive: true }, include: { material: true } },
    },
  });

  const ranked = [];
  for (const sf of storefronts) {
    let totalPayoutPaise = 0;
    let coveredItemsCount = 0;
    let meetsAllMinWeights = true;
    let complianceEligible = true;
    const itemQuotes: Array<{
      materialSlug: string;
      weightGrams: number;
      unitRatePaise: number;
      subtotalPaise: number;
      minLotMet: boolean;
    }> = [];

    for (const reqItem of params.items) {
      const ri = sf.rateItems.find(
        (x) => x.material.slug === reqItem.materialSlug
      );
      if (!ri) continue;

      coveredItemsCount++;
      const ratePaise =
        mode === "SELLER_DROPOFF" ? ri.dropoffRatePaise : ri.pickupRatePaise;
      const subtotal = calculateAmountPaise(
        reqItem.weightGrams,
        ratePaise,
        ri.material.defaultUnit
      );
      totalPayoutPaise += subtotal;

      const minLotMet = reqItem.weightGrams >= ri.minWeightGrams;
      if (!minLotMet) meetsAllMinWeights = false;

      if (
        VERIFICATION_RANK[sf.organization.verificationLevel] <
        VERIFICATION_RANK[ri.material.minBuyerVerificationLevel]
      ) {
        complianceEligible = false;
      }

      itemQuotes.push({
        materialSlug: reqItem.materialSlug,
        weightGrams: reqItem.weightGrams,
        unitRatePaise: ratePaise,
        subtotalPaise: subtotal,
        minLotMet,
      });
    }

    if (coveredItemsCount === 0) continue;

    const coverageRatio = coveredItemsCount / params.items.length;
    const sameCity =
      !params.city ||
      sf.organization.city.toLowerCase() === params.city.toLowerCase();
    const pincodeServed =
      !params.pincode || sf.servicePincodes.includes(params.pincode);
    const cpcbAuthorised = Boolean(
      sf.organization.recyclerRegistration?.cpcbPortalChecked
    );

    const scoreRaw =
      coverageRatio * 45 +
      (meetsAllMinWeights ? 20 : 6) +
      (complianceEligible ? 15 : -25) +
      (sameCity ? 10 : 3) +
      (pincodeServed ? 5 : 0) +
      (cpcbAuthorised ? 5 : 0);

    ranked.push({
      storefrontId: sf.id,
      shopTitle: sf.shopTitle,
      businessName: sf.organization.businessName,
      platformCode: sf.organization.platformCode,
      tier: sf.organization.tier,
      city: sf.organization.city,
      verificationLevel: sf.organization.verificationLevel,
      cpcbAuthorised,
      coveredItemsCount,
      totalRequestedItems: params.items.length,
      meetsMinimumLotWeight: meetsAllMinWeights,
      complianceEligible,
      estimatedTotalPayoutPaise: totalPayoutPaise,
      estimatedTotalPayoutInr: paiseToInrString(totalPayoutPaise),
      matchScore: Math.max(0, Math.min(100, Math.round(scoreRaw))),
      itemQuotes,
    });
  }

  // Boost payout efficiency bonus among top offers
  const maxPayout = Math.max(1, ...ranked.map((r) => r.estimatedTotalPayoutPaise));
  for (const r of ranked) {
    r.matchScore = Math.min(
      100,
      Math.round(
        r.matchScore * 0.72 + (r.estimatedTotalPayoutPaise / maxPayout) * 28
      )
    );
  }

  ranked.sort(
    (a, b) =>
      b.matchScore - a.matchScore ||
      b.estimatedTotalPayoutPaise - a.estimatedTotalPayoutPaise
  );

  const baselineCollector = ranked.find(
    (r) => r.tier === "TIER_1_LOCAL_COLLECTOR"
  );
  const bestNow =
    ranked.find((r) => r.meetsMinimumLotWeight && r.complianceEligible) ??
    ranked[0] ??
    null;

  const extraMarginVsStreetPaise =
    bestNow && baselineCollector
      ? Math.max(
          0,
          bestNow.estimatedTotalPayoutPaise -
            baselineCollector.estimatedTotalPayoutPaise
        )
      : 0;

  return {
    fulfillmentMode: mode,
    recommendedPrimaryMatch: bestNow,
    extraGainVsStreetCollectorPaise: extraMarginVsStreetPaise,
    extraGainVsStreetCollectorInr: paiseToInrString(extraMarginVsStreetPaise),
    rankedBuyers: ranked,
  };
}

// ============================================================================
// CAPABILITY 3: MULTILINGUAL NEURAL VOICE/CHAT KABADI ASSISTANT (HI/PA/MR/EN)
// ============================================================================

const MATERIAL_LEXICON: Array<{ slug: string; keywords: string[]; defaultGrams: number }> = [
  {
    slug: "metal-copper-bright",
    keywords: [
      "copper",
      "tamba",
      "taamba",
      "तांबा",
      "तांबे",
      "तांब्या",
      "ਤਾਂਬਾ",
      "ਕੌਪਰ",
      "ਕਾਪਰ",
    ],
    defaultGrams: 10000,
  },
  {
    slug: "metal-heavy-iron",
    keywords: ["iron", "steel", "loha", "lokhand", "लोहा", "लोखंड", "ਲੋਹਾ", "ਲੋਹੇ", "saria"],
    defaultGrams: 20000,
  },
  {
    slug: "metal-aluminium-utensil",
    keywords: [
      "aluminium",
      "aluminum",
      "silvery",
      "एल्यूमीनियम",
      "अॅल्युमिनियम",
      "ਐਲੂਮੀਨੀਅਮ",
      "bartan",
    ],
    defaultGrams: 8000,
  },
  {
    slug: "ewaste-pcb-grade-a",
    keywords: ["pcb", "motherboard", "circuit", "telecom", "पीसीबी", "बोर्ड"],
    defaultGrams: 5000,
  },
  {
    slug: "battery-inverter-lead",
    keywords: ["battery", "inverter", "lithium", "बैटरी", "बॅटरी", "ਬੈਟਰੀ"],
    defaultGrams: 15000,
  },
  {
    slug: "paper-newspaper",
    keywords: ["newspaper", "raddi", "akhbar", "रद्दी", "अखबार", "ਰੱਦੀ", "ਅਖ਼ਬਾਰ"],
    defaultGrams: 12000,
  },
  {
    slug: "paper-cardboard",
    keywords: ["cardboard", "gatta", "carton", "box", "गत्ता", "पुठ्ठा", "ਗੱਤਾ"],
    defaultGrams: 15000,
  },
  {
    slug: "plastic-pet-clear",
    keywords: ["plastic", "pet", "bottle", "बोतल", "प्लास्टिक", "ਪਲਾਸਟਿਕ"],
    defaultGrams: 8000,
  },
];

const APPLIANCE_LEXICON: Array<{ bomSlug: string; keywords: string[] }> = [
  {
    bomSlug: "split-ac-15ton-copper",
    keywords: ["ac", "air conditioner", "split ac", "एसी", "ਏਸੀ"],
  },
  {
    bomSlug: "smartphone-midrange-android",
    keywords: ["phone", "mobile", "smartphone", "मोबाइल", "मोबाईल", "ਮੋਬਾਈਲ"],
  },
  {
    bomSlug: "laptop-notebook-pc",
    keywords: ["laptop", "notebook", "computer", "लैपटॉप", "लॅपटॉप", "ਲੈਪਟਾਪ"],
  },
  {
    bomSlug: "ceiling-fan-copper-motor",
    keywords: ["fan", "pankha", "motor", "पंखा", "मोटर", "ਪੱਖਾ"],
  },
  {
    bomSlug: "washing-machine-twin-tub",
    keywords: ["washing", "machine", "वाशिंग", "वॉशिंग", "ਵਾਸ਼ਿੰਗ"],
  },
];

function normalizeIndicDigits(s: string): string {
  // Convert Devanagari (०-९) & Gurmukhi (੦-੯) digits to ASCII 0-9
  return s
    .replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - 0x0966))
    .replace(/[\u0A66-\u0A6F]/g, (c) => String(c.charCodeAt(0) - 0x0a66));
}

export function detectVernacularLanguage(
  message: string,
  preferred?: SupportedLanguage
): SupportedLanguage {
  if (/[\u0A00-\u0A7F]/.test(message)) return "PA";
  if (/[\u0900-\u097F]/.test(message)) {
    if (/(आहे|माझ्या|किती|मिळतील|भंगार|दुकानात|करा|कसा)/.test(message)) {
      return "MR";
    }
    return "HI";
  }
  return preferred ?? "HI";
}

function extractEntitiesFromUtterance(rawText: string) {
  const norm = normalizeIndicDigits(rawText.toLowerCase());
  const pincodeMatch = norm.match(/\b([1-9][0-9]{5})\b/);
  const cityMatch = norm.match(
    /\b(ludhiana|jalandhar|amritsar|patiala|chandigarh|delhi|pune|mumbai|nagpur)\b/i
  );

  // Find numbers + units around material keywords
  const extractedItems: Array<{ materialSlug: string; weightGrams: number }> = [];
  for (const entry of MATERIAL_LEXICON) {
    for (const kw of entry.keywords) {
      const idx = norm.indexOf(kw.toLowerCase());
      if (idx !== -1) {
        const windowBefore = norm.slice(Math.max(0, idx - 22), idx);
        const numMatch = windowBefore.match(
          /(\d+(?:\.\d+)?)\s*(kg|kilo|किलो|ਕਿਲੋ|quintal|क्विंटल|ton|g|gram)?\s*$/i
        );
        let grams = entry.defaultGrams;
        if (numMatch) {
          const val = parseFloat(numMatch[1]!);
          const unit = (numMatch[2] ?? "kg").toLowerCase();
          if (unit.startsWith("quintal") || unit === "क्विंटल") {
            grams = Math.round(val * 100000);
          } else if (unit === "ton") {
            grams = Math.round(val * 1000000);
          } else if (unit === "g" || unit === "gram") {
            grams = Math.round(val);
          } else {
            grams = Math.round(val * 1000);
          }
        }
        extractedItems.push({
          materialSlug: entry.slug,
          weightGrams: Math.max(100, grams),
        });
        break;
      }
    }
  }

  const extractedAppliances: Array<{ bomSlug: string; count: number }> = [];
  for (const app of APPLIANCE_LEXICON) {
    for (const kw of app.keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:(\\d+)\\s*(?:purane|old|dead|जुने|ਪੁਰਾਣੇ)?\\s*)?(?:^|\\s)${escaped}(?:\\s|$|[?,!])`, "i");
      const m = norm.match(re);
      if (m) {
        const cnt = m[1] ? Math.min(20, Math.max(1, parseInt(m[1], 10))) : 1;
        extractedAppliances.push({
          bomSlug:
            app.bomSlug === "laptop-notebook-pc"
              ? "laptop-business-14"
              : app.bomSlug,
          count: cnt,
        });
        break;
      }
    }
  }

  return {
    city: cityMatch ? cityMatch[1]![0]!.toUpperCase() + cityMatch[1]!.slice(1) : "Ludhiana",
    pincode: pincodeMatch ? pincodeMatch[1]! : "141001",
    items:
      extractedItems.length > 0
        ? extractedItems
        : [{ materialSlug: "metal-copper-bright", weightGrams: 10000 }],
    appliances: extractedAppliances,
  };
}

export async function runVernacularAiAssistant(params: {
  actorId?: string;
  actorTier?: string;
  message: string;
  language?: SupportedLanguage;
  autoCreateListing?: boolean;
}) {
  const prisma = await getPrisma();
  const detectedLanguage = detectVernacularLanguage(params.message, params.language);
  const nlu = await runVernacularIntentOnnxInference(params.message);
  const entities = extractEntitiesFromUtterance(params.message);

  const [smartMatch, marketIntel, bomRefs] = await Promise.all([
    runSmartBuyerMatch({
      city: entities.city,
      pincode: entities.pincode,
      fulfillmentMode: "SELLER_DROPOFF",
      items: entities.items,
    }),
    getMandiMarketIntelligence(entities.city),
    entities.appliances.length > 0
      ? prisma.deviceReferenceBOM.findMany({
          where: { slug: { in: entities.appliances.map((a) => a.bomSlug) } },
        })
      : Promise.resolve([]),
  ]);

  let applianceBonusMinPaise = 0;
  let applianceBonusMaxPaise = 0;
  const applianceSummaries = entities.appliances.map((a) => {
    const ref = bomRefs.find((r) => r.slug === a.bomSlug);
    const minP = (ref?.partsHarvestMinPaise ?? 50000) * a.count;
    const maxP = (ref?.partsHarvestMaxPaise ?? 90000) * a.count;
    applianceBonusMinPaise += minP;
    applianceBonusMaxPaise += maxP;
    return {
      modelName: ref?.modelName ?? a.bomSlug,
      quantity: a.count,
      estimatedPartsHarvestInr: `${paiseToInrString(minP)} – ${paiseToInrString(maxP)}`,
    };
  });

  const bestBuyer = smartMatch.recommendedPrimaryMatch;
  const scrapPayoutPaise = bestBuyer?.estimatedTotalPayoutPaise ?? 0;
  const combinedTotalMinPaise = scrapPayoutPaise + applianceBonusMinPaise;
  const combinedTotalMaxPaise = scrapPayoutPaise + applianceBonusMaxPaise;
  const topForecast =
    marketIntel.forecasts.find(
      (f) => f.materialSlug === entities.items[0]?.materialSlug
    ) ?? marketIntel.forecasts[0];

  // Optionally create a real live MaterialListing straight from chat!
  let createdListing: { id: string; title: string; indicativeEstimateInr: string } | null =
    null;
  if (params.autoCreateListing && params.actorId) {
    const mats = await prisma.materialCategory.findMany({
      where: { slug: { in: entities.items.map((i) => i.materialSlug) } },
    });
    if (mats.length > 0) {
      const listing = await prisma.materialListing.create({
        data: {
          ownerId: params.actorId,
          title: `AI Voice/Chat Lot (${entities.city}): ${mats
            .map((m) => m.nameEn)
            .join(" + ")}`,
          sellerTier: (params.actorTier as never) ?? "TIER_0_GENERATOR",
          pickupCity: entities.city,
          pickupPincode: entities.pincode,
          pickupAddressPrivate: `Voice-Booked Pickup, ${entities.city} ${entities.pincode}`,
          preferredMode: "BUYER_PICKUP",
          indicativeEstimatePaise: Math.max(1000, scrapPayoutPaise),
          status: "LISTED",
          items: {
            create: entities.items
              .map((it) => {
                const mat = mats.find((m) => m.slug === it.materialSlug);
                if (!mat) return null;
                const unitRate =
                  bestBuyer?.itemQuotes.find(
                    (q) => q.materialSlug === it.materialSlug
                  )?.unitRatePaise ?? 2500;
                return {
                  materialId: mat.id,
                  estimatedGrams: it.weightGrams,
                  indicativeRatePaise: unitRate,
                  indicativeSubtotalPaise: calculateAmountPaise(
                    it.weightGrams,
                    unitRate,
                    mat.defaultUnit
                  ),
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null),
          },
        },
      });
      createdListing = {
        id: listing.id,
        title: listing.title,
        indicativeEstimateInr: paiseToInrString(listing.indicativeEstimatePaise),
      };
    }
  }

  const totalRangeStr =
    applianceBonusMaxPaise > 0
      ? `${paiseToInrString(combinedTotalMinPaise)} – ${paiseToInrString(
          combinedTotalMaxPaise
        )}`
      : paiseToInrString(scrapPayoutPaise);

  const buyerName = bestBuyer?.shopTitle ?? "Verified Local Storefront";
  const fcast7d = topForecast
    ? `${topForecast.predicted7dRateInr} (${
        topForecast.predicted7dDeltaPct >= 0 ? "+" : ""
      }${topForecast.predicted7dDeltaPct}%)`
    : "";

  const repliesByLang: Record<VernacularAiIntent, Record<SupportedLanguage, string>> = {
    VALUATE_AND_RATES: {
      EN: `Live ${entities.city} Mandi Valuation: Your scrap & appliance lot is estimated around ${totalRangeStr}. Top local match: ${buyerName} (${bestBuyer?.tier ?? "TIER_2"}). 7-day trend: ${fcast7d}.`,
      HI: `लाइव ${entities.city} मंडी मूल्यांकन: आपके कबाड़ और उपकरणों की अनुमानित कीमत लगभग ${totalRangeStr} है। सबसे बढ़िया खरीदार: ${buyerName}। 7-दिन का भाव अनुमान: ${fcast7d}।`,
      PA: `ਲਾਈਵ ${entities.city} ਮੰਡੀ ਮੁੱਲ: ਤੁਹਾਡੇ ਸਮਾਨ ਦੀ ਅੰਦਾਜ਼ਨ ਕੀਮਤ ਲਗਭਗ ${totalRangeStr} ਹੈ। ਸਭ ਤੋਂ ਵਧੀਆ ਖਰੀਦਦਾਰ: ${buyerName}। 7-ਦਿਨਾਂ ਦਾ ਅੰਦਾਜ਼ਾ: ${fcast7d}।`,
      MR: `थेट ${entities.city} बाजार मूल्यांकन: तुमच्या भंगार व उपकरणांची अंदाजे किंमत ${totalRangeStr} आहे. सर्वोत्तम खरेदीदार: ${buyerName}. ७-दिवसांचा अंदाज: ${fcast7d}.`,
    },
    PRICE_FORECAST_TIMING: {
      EN: `7-Day Mandi Forecast (${topForecast?.nameEn ?? "Scrap"}): Current avg ${topForecast?.currentAvgRateInr} → 7-day neural projection ${fcast7d}. Signal: ${topForecast?.tradingAction.replace(/_/g, " ")}.`,
      HI: `7-दिन मंडी भाव पूर्वानुमान (${topForecast?.nameHi ?? "स्क्रैप"}): अभी औसत भाव ${topForecast?.currentAvgRateInr} है, अगले 7 दिन में अनुमान ${fcast7d}। सलाह: ${topForecast?.tradingAction === "HOLD_STOCK_FOR_UPSIDE" ? "माल रोक कर बढ़त का लाभ लें" : "अभी अच्छे दाम पर बेचें"}।`,
      PA: `7-ਦਿਨ ਮੰਡੀ ਭਾਅ ਅੰਦਾਜ਼ਾ (${topForecast?.namePa ?? "ਸਕ੍ਰੈਪ"}): ਮੌਜੂਦਾ ਰੇਟ ${topForecast?.currentAvgRateInr} ਤੋਂ 7 ਦਿਨਾਂ ਵਿੱਚ ${fcast7d}। ਸਲਾਹ: ${topForecast?.tradingAction}।`,
      MR: `७-दिवसांचा बाजारभाव अंदाज (${topForecast?.nameMr || topForecast?.nameEn}): सध्याचा भाव ${topForecast?.currentAvgRateInr} असून ७ दिवसांत ${fcast7d} राहण्याचा अंदाज आहे.`,
    },
    SMART_BUYER_MATCH: {
      EN: `Best Verified Buyer in ${entities.city}: ${buyerName} (${bestBuyer?.verificationLevel}) offering ${bestBuyer?.estimatedTotalPayoutInr} — ${smartMatch.extraGainVsStreetCollectorInr} extra vs street average.`,
      HI: `${entities.city} में सबसे बढ़िया सत्यापित खरीदार: ${buyerName} — कुल भुगतान ${bestBuyer?.estimatedTotalPayoutInr} (गली के औसत से ${smartMatch.extraGainVsStreetCollectorInr} ज़्यादा)।`,
      PA: `${entities.city} ਵਿੱਚ ਸਭ ਤੋਂ ਵਧੀਆ ਵੈਰੀਫਾਈਡ ਖਰੀਦਦਾਰ: ${buyerName} — ਕੁੱਲ ਰਕਮ ${bestBuyer?.estimatedTotalPayoutInr} (${smartMatch.extraGainVsStreetCollectorInr} ਵੱਧ ਲਾਭ)।`,
      MR: `${entities.city} मधील सर्वोत्तम प्रमाणित खरेदीदार: ${buyerName} — एकूण रक्कम ${bestBuyer?.estimatedTotalPayoutInr} (${smartMatch.extraGainVsStreetCollectorInr} जादा परतावा).`,
    },
    BOOK_PICKUP_LISTING: {
      EN: createdListing
        ? `Pickup Listing Created! "${createdListing.title}" is now live on the broadcast board (Indicative ${createdListing.indicativeEstimateInr}).`
        : `Ready to publish pickup in ${entities.city} (${entities.pincode}) for ${totalRangeStr}. Tap "Create Live Pickup Listing" to broadcast to verified collectors.`,
      HI: createdListing
        ? `आपकी पिकअप लिस्टिंग बन गई है! "${createdListing.title}" (अनुमानित ${createdListing.indicativeEstimateInr}) अब लाइव है।`
        : `${entities.city} (${entities.pincode}) से ${totalRangeStr} के कबाड़ पिकअप के लिए तैयार — एक क्लिक में लाइव बुकिंग जारी करें।`,
      PA: createdListing
        ? `ਤੁਹਾਡੀ ਪਿਕਅੱਪ ਲਿਸਟਿੰਗ ਲਾਈਵ ਹੋ ਗਈ ਹੈ! ਅੰਦਾਜ਼ਨ ਕੀਮਤ ${createdListing.indicativeEstimateInr}।`
        : `${entities.city} (${entities.pincode}) ਵਿੱਚ ${totalRangeStr} ਦੇ ਪਿਕਅੱਪ ਲਈ ਤਿਆਰ — ਲਾਈਵ ਬੁਕਿੰਗ ਸ਼ੁਰੂ ਕਰੋ।`,
      MR: createdListing
        ? `तुमची पिकअप ऑर्डर लाईव्ह झाली आहे! अंदाजे किंमत ${createdListing.indicativeEstimateInr}.`
        : `${entities.city} (${entities.pincode}) येथून ${totalRangeStr} पिकअपसाठी तयार.`,
    },
    SCALE_DISPUTE_FRAUD_HELP: {
      EN: `Scale Protection Active: Scan the digital kanta display in the Scale OCR tab first — if deviation exceeds tolerance or a replayed photo is used, raise a Dispute to freeze buyer settlement immediately.`,
      HI: `कांटा सुरक्षा सक्रिय: पहले 'Scale OCR' टैब से डिजिटल कांटे की फोटो स्कैन करें। वजन कम होने पर तुरंत 'Dispute' दर्ज करें — भुगतान अपने-आप होल्ड हो जाएगा।`,
      PA: `ਕੰਡਾ ਸੁਰੱਖਿਆ ਚਾਲੂ ਹੈ: ਪਹਿਲਾਂ Scale OCR ਟੈਬ ਨਾਲ ਡਿਜੀਟਲ ਕੰਡੇ ਦੀ ਫੋਟੋ ਖਿੱਚੋ। ਵਜ਼ਨ ਵਿੱਚ ਫ਼ਰਕ ਹੋਣ ਤੇ ਤੁਰੰਤ Dispute ਪਾਓ।`,
      MR: `काटा सुरक्षा सक्रिय: आधी Scale OCR टॅबमधून डिजिटल काट्याचा फोटो स्कॅन करा; तफावत आढळल्यास त्वरित तक्रार (Dispute) नोंदवा.`,
    },
    SAFETY_HAZARD_COMPLIANCE: {
      EN: `CPCB Safety Rule: NEVER burn PVC copper cables or puncture swollen Li-ion / lead-acid batteries. Route PCBs and batteries strictly to Level-4 CPCB Authorised Recyclers (${buyerName}).`,
      HI: `CPCB सुरक्षा नियम: तांबे की तारों को कभी खुले में न जलाएं और लिथियम/इनवर्टर बैटरी में छेद न करें। PCB व बैटरी केवल अधिकृत Level-4 रीसाइक्लर को ही बेचें।`,
      PA: `CPCB ਸੁਰੱਖਿਆ ਨਿਯਮ: ਤਾਂਬੇ ਦੀਆਂ ਤਾਰਾਂ ਨੂੰ ਕਦੇ ਨਾ ਸਾੜੋ ਅਤੇ ਲਿਥੀਅਮ ਬੈਟਰੀ ਨੂੰ ਤਿੱਖੇ ਔਜ਼ਾਰ ਨਾਲ ਨਾ ਖੋਲ੍ਹੋ। ਸਿਰਫ਼ ਮਾਨਤਾ ਪ੍ਰਾਪਤ Level-4 ਰੀਸਾਈਕਲਰ ਨੂੰ ਵੇਚੋ।`,
      MR: `CPCB सुरक्षा नियम: तांब्याच्या तारा कधीही जाळू नका आणि लिथियम/शिसे बॅटरी फोडू नका. ई-कचरा फक्त अधिकृत Level-4 रिसायकलरकडेच द्या.`,
    },
  };

  return {
    modelVersion: nlu.modelVersion,
    modelSha256: nlu.modelSha256,
    runtimeBackend: "onnxruntime-wasm-cpu" as const,
    detectedLanguage,
    voiceLocale: voiceLocaleForLanguage(detectedLanguage),
    intent: nlu.intent,
    intentConfidence: nlu.confidence,
    allIntentScores: nlu.allScores,
    extractedEntities: entities,
    replyText: repliesByLang[nlu.intent][detectedLanguage],
    multilingualReplies: repliesByLang[nlu.intent],
    liveValuation: {
      scrapPayoutPaise,
      applianceBonusMinPaise,
      applianceBonusMaxPaise,
      combinedDisplayInr: totalRangeStr,
      applianceBreakdowns: applianceSummaries,
      topBuyerMatch: bestBuyer,
      topMaterialForecast: topForecast ?? null,
    },
    createdListing,
  };
}
