import { getPrisma } from "../src/lib/prisma";
import { hashSecretArgon2id } from "../src/lib/security";

export async function ensureSeeded(): Promise<void> {
  const prisma = await getPrisma();

  // Check if already seeded
  const existingAdmin = await prisma.user.findUnique({
    where: { email: "admin@kabadiwala.local" },
  });
  if (existingAdmin) {
    await ensureMilestoneOneSeedData();
    await ensureMilestoneTwoSeedData();
    await ensureMilestoneThreeSeedData();
    return;
  }

  // 1. Controlled Server-Side Provisioning of Platform Admin (NEVER via public signup)
  const adminPasswordHash = await hashSecretArgon2id("AdminPass123");
  const demoPasswordHash = await hashSecretArgon2id("KabadiPass123");

  await prisma.user.create({
    data: {
      phone: "+919800000001",
      email: "admin@kabadiwala.local",
      passwordHash: adminPasswordHash,
      role: "ADMIN",
      tier: "PLATFORM_STAFF",
      accountStatus: "ACTIVE",
      verificationLevel: "LEVEL_2_IDENTITY_REVIEWED",
      platformCode: "KC-ADM-000001",
      mfaEnabled: true,
      profile: {
        create: {
          displayName: "Platform Security & Compliance Admin",
          preferredLanguage: "EN",
          city: "Ludhiana",
          pincode: "141001",
        },
      },
    },
  });

  // 2. Database-Driven Material & Regulated Stream Catalog (with EN / HI / PA names)
  const materialDefs = [
    {
      slug: "paper-newspaper",
      nameEn: "Old Newspaper (Raddi)",
      nameHi: "अखबार रद्दी",
      namePa: "ਪੁਰਾਣੇ ਅਖ਼ਬਾਰ (ਰੱਦੀ)",
      streamGroup: "PAPER",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: false,
      minBuyerVerificationLevel: "LEVEL_0_REGISTERED" as const,
      handlingGuidance: "Keep bundled dry and free from oil or food moisture.",
    },
    {
      slug: "paper-cardboard",
      nameEn: "Corrugated Cardboard (Gatta)",
      nameHi: "गत्ता कार्टन",
      namePa: "ਗੱਤਾ ਡੱਬੇ",
      streamGroup: "PAPER",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: false,
      minBuyerVerificationLevel: "LEVEL_0_REGISTERED" as const,
      handlingGuidance: "Flatten boxes dry; remove heavy plastic tape where possible.",
    },
    {
      slug: "plastic-pet-clear",
      nameEn: "Clear PET Bottles",
      nameHi: "साफ़ PET बोतलें",
      namePa: "ਸਾਫ਼ PET ਬੋਤਲਾਂ",
      streamGroup: "PLASTIC",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: false,
      minBuyerVerificationLevel: "LEVEL_0_REGISTERED" as const,
      handlingGuidance: "Empty liquids completely; do not mix PVC pipes with PET.",
    },
    {
      slug: "metal-heavy-iron",
      nameEn: "Heavy Iron & Steel (Loha)",
      nameHi: "भारी लोहा",
      namePa: "ਭਾਰੀ ਲੋਹਾ",
      streamGroup: "FERROUS",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: false,
      minBuyerVerificationLevel: "LEVEL_0_REGISTERED" as const,
      handlingGuidance: "Wear gloves for sharp rusted edges; separate sealed gas cylinders.",
    },
    {
      slug: "metal-copper-bright",
      nameEn: "Clean Copper Wire / Coil (Tamba)",
      nameHi: "साफ़ तांबा तार",
      namePa: "ਸਾਫ਼ ਤਾਂਬਾ ਤਾਰ",
      streamGroup: "NON_FERROUS",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: false,
      minBuyerVerificationLevel: "LEVEL_1_CONTACT_VERIFIED" as const,
      handlingGuidance:
        "Mechanical stripping only. NEVER burn PVC wire insulation in open air.",
    },
    {
      slug: "ewaste-insulated-cable",
      nameEn: "Insulated Copper Power / Data Cables",
      nameHi: "इंसुलेटेड कॉपर केबल",
      namePa: "ਇੰਸੂਲੇਟਿਡ ਕਾਪਰ ਕੇਬਲ",
      streamGroup: "EWASTE",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: true,
      minBuyerVerificationLevel: "LEVEL_1_CONTACT_VERIFIED" as const,
      handlingGuidance:
        "Do NOT burn cables to extract copper; route unburnt to mechanical granulators.",
    },
    {
      slug: "ewaste-pcb-grade-a",
      nameEn: "High-Grade Telecom / Computer PCBs (Grade A)",
      nameHi: "हाई-ग्रेड मोबाइल/कंप्यूटर PCB",
      namePa: "ਹਾਈ-ਗ੍ਰੇਡ ਮੋਬਾਈਲ/ਕੰਪਿਊਟਰ PCB",
      streamGroup: "EWASTE",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: true,
      minBuyerVerificationLevel: "LEVEL_2_IDENTITY_REVIEWED" as const,
      handlingGuidance:
        "Contains gold/palladium ICs and lead solder. Never acid-leach or heat over open flame.",
    },
    {
      slug: "battery-inverter-lead",
      nameEn: "Lead-Acid Inverter / Vehicle Battery",
      nameHi: "इनवर्टर / गाड़ी बैटरी",
      namePa: "ਇਨਵਰਟਰ / ਗੱਡੀ ਬੈਟਰੀ",
      streamGroup: "BATTERY",
      defaultUnit: "KG" as const,
      isRegulatedHazardous: true,
      minBuyerVerificationLevel: "LEVEL_3_BUSINESS_VERIFIED" as const,
      handlingGuidance:
        "Keep upright; never drain acid onto soil or drains; regulated Battery Waste stream.",
    },
  ];

  const createdMaterials: Record<string, string> = {};
  for (const m of materialDefs) {
    const rec = await prisma.materialCategory.create({ data: m });
    createdMaterials[m.slug] = rec.id;
  }

  // 3. Seed Device Reference BOM Catalog for Camera AI X-Ray Valuation
  await prisma.deviceReferenceBOM.createMany({
    data: [
      {
        slug: "smartphone-midrange-android",
        deviceCategory: "SMARTPHONE",
        brandPattern: "Redmi / Samsung / Vivo / Realme 5G",
        modelName: "Mid-Range Android Smartphone (e.g., Redmi Note / Galaxy A Series)",
        typicalTotalGrams: 192,
        coilType: null,
        componentsJson: [
          {
            materialSlug: "ewaste-pcb-grade-a",
            label: "Main Logic Board (Grade-A+ Gold/BGA Telecom PCB)",
            grams: 34,
            indicativeValuePaise: 13500,
          },
          {
            materialSlug: "metal-copper-bright",
            label: "OIS Camera Array + Neodymium Speaker & Haptic Module",
            grams: 22,
            indicativeValuePaise: 5500,
          },
          {
            materialSlug: "battery-inverter-lead",
            label: "Li-Cobalt Pouch Cell (Cobalt + Lithium Recovery)",
            grams: 52,
            indicativeValuePaise: 4200,
          },
          {
            materialSlug: "metal-heavy-iron",
            label: "CNC Aluminum Mid-Frame & Shielding Cans",
            grams: 84,
            indicativeValuePaise: 2300,
          },
        ],
        refurbishRangeMinPaise: 210000,
        refurbishRangeMaxPaise: 320000,
        partsHarvestMinPaise: 55000,
        partsHarvestMaxPaise: 92000,
        safetyNotes:
          "Do NOT pry or bend lithium pouch cell with metal screwdriver; discharge safely before storage.",
      },
      {
        slug: "laptop-business-14",
        deviceCategory: "LAPTOP",
        brandPattern: "Dell / HP / Lenovo ThinkPad",
        modelName: "14–15 inch Notebook Laptop",
        typicalTotalGrams: 1750,
        coilType: null,
        componentsJson: [
          {
            materialSlug: "ewaste-pcb-grade-a",
            label: "Motherboard + RAM/Wi-Fi Gold-Finger Modules",
            grams: 310,
            indicativeValuePaise: 62000,
          },
          {
            materialSlug: "metal-copper-bright",
            label: "Pure Copper Heatpipe & Cooling Fin Assembly",
            grams: 95,
            indicativeValuePaise: 58000,
          },
          {
            materialSlug: "battery-inverter-lead",
            label: "Multi-Cell Li-Ion Battery Pack",
            grams: 240,
            indicativeValuePaise: 14000,
          },
          {
            materialSlug: "metal-heavy-iron",
            label: "Magnesium/Aluminum Chassis, Hinges & Screen Assembly",
            grams: 1105,
            indicativeValuePaise: 19000,
          },
        ],
        refurbishRangeMinPaise: 480000,
        refurbishRangeMaxPaise: 850000,
        partsHarvestMinPaise: 145000,
        partsHarvestMaxPaise: 240000,
        safetyNotes:
          "Wipe storage media before transfer; remove multi-cell lithium battery intact without puncturing.",
      },
      {
        slug: "split-ac-15ton-copper",
        deviceCategory: "SPLIT_AC",
        brandPattern: "Voltas / Daikin / LG 1.5T Copper",
        modelName: "1.5 Ton Split AC (100% Copper Condenser + Evaporator)",
        typicalTotalGrams: 38500,
        coilType: "COPPER",
        componentsJson: [
          {
            materialSlug: "metal-copper-bright",
            label: "Copper Condenser & Evaporator Coils (~5.8 kg high-purity Cu)",
            grams: 5800,
            indicativeValuePaise: 348000,
          },
          {
            materialSlug: "metal-heavy-iron",
            label: "Sealed Rotary Compressor (~11.2 kg Cu-wound motor + steel)",
            grams: 11200,
            indicativeValuePaise: 95000,
          },
          {
            materialSlug: "ewaste-pcb-grade-a",
            label: "Inverter / Control PCB + Wiring Harness",
            grams: 1300,
            indicativeValuePaise: 24000,
          },
          {
            materialSlug: "metal-heavy-iron",
            label: "Galvanized Sheet Body & ABS Indoor Shell",
            grams: 20200,
            indicativeValuePaise: 52000,
          },
        ],
        refurbishRangeMinPaise: 650000,
        refurbishRangeMaxPaise: 950000,
        partsHarvestMinPaise: 460000,
        partsHarvestMaxPaise: 560000,
        safetyNotes:
          "Recover refrigerant gas via authorised equipment before cutting sealed compressor lines.",
      },
      {
        slug: "split-ac-15ton-aluminum",
        deviceCategory: "SPLIT_AC",
        brandPattern: "1.5T Aluminum Condenser AC",
        modelName: "1.5 Ton Split AC (Aluminum Condenser Coil Variant)",
        typicalTotalGrams: 34000,
        coilType: "ALUMINUM",
        componentsJson: [
          {
            materialSlug: "metal-heavy-iron",
            label: "Aluminum Condenser Fin-Tube Coil (~3.9 kg Al)",
            grams: 3900,
            indicativeValuePaise: 68000,
          },
          {
            materialSlug: "metal-heavy-iron",
            label: "Rotary Compressor Unit",
            grams: 10800,
            indicativeValuePaise: 92000,
          },
          {
            materialSlug: "ewaste-pcb-grade-a",
            label: "Control PCB + Internal Copper Interconnects",
            grams: 1100,
            indicativeValuePaise: 28000,
          },
          {
            materialSlug: "metal-heavy-iron",
            label: "Sheet Metal Housing & Plastic Blower Shell",
            grams: 18200,
            indicativeValuePaise: 48000,
          },
        ],
        refurbishRangeMinPaise: 450000,
        refurbishRangeMaxPaise: 650000,
        partsHarvestMinPaise: 235000,
        partsHarvestMaxPaise: 290000,
        safetyNotes:
          "Notice: Aluminum coil scrap value is ~₹2,000 lower than 100% Copper coil ACs — always verify rating plate!",
      },
    ],
  });

  // 4. Seed Multi-Tier Participants Across All 5 Hierarchy Levels!

  // Tier 0: Customer / Household Generator
  const customer = await prisma.user.create({
    data: {
      phone: "+919811110000",
      email: "customer@kabadiwala.local",
      passwordHash: demoPasswordHash,
      role: "CUSTOMER",
      tier: "TIER_0_GENERATOR",
      accountStatus: "ACTIVE",
      verificationLevel: "LEVEL_1_CONTACT_VERIFIED",
      platformCode: "KC-CUS-100001",
      phoneVerifiedAt: new Date(),
      profile: {
        create: {
          displayName: "Aarav Sharma (Household)",
          preferredLanguage: "HI",
          city: "Ludhiana",
          pincode: "141001",
          addressLine: "House 42, Civil Lines, Ludhiana",
        },
      },
    },
  });

  // Tier 1: Local Door-to-Door Collector Storefront
  const tier1Collector = await prisma.user.create({
    data: {
      phone: "+919811110001",
      email: "collector@kabadiwala.local",
      passwordHash: demoPasswordHash,
      role: "COLLECTOR",
      tier: "TIER_1_LOCAL_COLLECTOR",
      accountStatus: "ACTIVE",
      verificationLevel: "LEVEL_2_IDENTITY_REVIEWED",
      platformCode: "KC-COL-100101",
      phoneVerifiedAt: new Date(),
      profile: {
        create: {
          displayName: "Raju Pheri Kabadi Seva",
          preferredLanguage: "HI",
          city: "Ludhiana",
          pincode: "141001",
        },
      },
      organization: {
        create: {
          tier: "TIER_1_LOCAL_COLLECTOR",
          platformCode: "KC-COL-100101",
          businessName: "Raju Ward-4 Doorstep Kabadi",
          city: "Ludhiana",
          pincode: "141001",
          serviceRadiusKm: 4,
          verificationLevel: "LEVEL_2_IDENTITY_REVIEWED",
          storefront: {
            create: {
              slug: "raju-ward4-kabadi",
              shopTitle: "Raju Doorstep Kabadi (30-Min E-Rickshaw Pickup)",
              tagline: "Digital hanging scale · Instant Cash or UPI · 3 kg minimum",
              isOpen: true,
              minPickupGrams: 3000,
              servicePincodes: ["141001", "141002"],
              ratingAvg: 4.9,
              completedOrdersCnt: 142,
              rateItems: {
                create: [
                  {
                    materialId: createdMaterials["paper-newspaper"]!,
                    pickupRatePaise: 1600,
                    dropoffRatePaise: 1700,
                    minWeightGrams: 2000,
                  },
                  {
                    materialId: createdMaterials["paper-cardboard"]!,
                    pickupRatePaise: 1100,
                    dropoffRatePaise: 1200,
                    minWeightGrams: 2000,
                  },
                  {
                    materialId: createdMaterials["metal-heavy-iron"]!,
                    pickupRatePaise: 2900,
                    dropoffRatePaise: 3050,
                    minWeightGrams: 2000,
                  },
                  {
                    materialId: createdMaterials["metal-copper-bright"]!,
                    pickupRatePaise: 59000,
                    dropoffRatePaise: 60500,
                    minWeightGrams: 500,
                  },
                  {
                    materialId: createdMaterials["ewaste-pcb-grade-a"]!,
                    pickupRatePaise: 135000,
                    dropoffRatePaise: 142000,
                    minWeightGrams: 500,
                  },
                ],
              },
            },
          },
        },
      },
    },
    include: { organization: { include: { storefront: true } } },
  });

  // Tier 2: Area Scrap Shop / Dukaandar Storefront (Buys from Tier 1 & Bulk Tier 0)
  await prisma.user.create({
    data: {
      phone: "+919811110002",
      email: "shop@kabadiwala.local",
      passwordHash: demoPasswordHash,
      role: "SCRAP_BUSINESS",
      tier: "TIER_2_AREA_SHOP",
      accountStatus: "ACTIVE",
      verificationLevel: "LEVEL_3_BUSINESS_VERIFIED",
      platformCode: "KC-SHP-200201",
      phoneVerifiedAt: new Date(),
      profile: {
        create: {
          displayName: "Gill Road Scrap & Dismantling Shop",
          preferredLanguage: "PA",
          city: "Ludhiana",
          pincode: "141003",
        },
      },
      organization: {
        create: {
          tier: "TIER_2_AREA_SHOP",
          platformCode: "KC-SHP-200201",
          businessName: "Gill Road Scrap Traders (Dukaandar Tier 2)",
          city: "Ludhiana",
          pincode: "141003",
          serviceRadiusKm: 12,
          verificationLevel: "LEVEL_3_BUSINESS_VERIFIED",
          businessRegistration: {
            create: {
              registrationType: "SHOP_ACT_UDYAM",
              registrationNumber: "UDYAM-PB-14-0049182",
              issuingAuthority: "MSME / Municipal Corporation Ludhiana",
              verifiedAt: new Date(),
            },
          },
          storefront: {
            create: {
              slug: "gill-road-scrap-shop",
              shopTitle: "Gill Road Area Kabadi Shop (Tier-2 Aggregator)",
              tagline: "High gate rates for local Pheriwalas & 25kg+ bulk sellers",
              isOpen: true,
              minPickupGrams: 25000,
              servicePincodes: ["141001", "141002", "141003"],
              ratingAvg: 4.8,
              completedOrdersCnt: 518,
              rateItems: {
                create: [
                  {
                    materialId: createdMaterials["paper-newspaper"]!,
                    pickupRatePaise: 1850,
                    dropoffRatePaise: 1950,
                    minWeightGrams: 10000,
                  },
                  {
                    materialId: createdMaterials["paper-cardboard"]!,
                    pickupRatePaise: 1350,
                    dropoffRatePaise: 1450,
                    minWeightGrams: 15000,
                  },
                  {
                    materialId: createdMaterials["metal-heavy-iron"]!,
                    pickupRatePaise: 3250,
                    dropoffRatePaise: 3350,
                    minWeightGrams: 15000,
                  },
                  {
                    materialId: createdMaterials["metal-copper-bright"]!,
                    pickupRatePaise: 64500,
                    dropoffRatePaise: 66000,
                    minWeightGrams: 2000,
                  },
                  {
                    materialId: createdMaterials["ewaste-pcb-grade-a"]!,
                    pickupRatePaise: 168000,
                    dropoffRatePaise: 175000,
                    minWeightGrams: 2000,
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  // Tier 3: Wholesale Mandi / Baling Hub Storefront
  const tier3User = await prisma.user.create({
    data: {
      phone: "+919811110003",
      email: "wholesale@kabadiwala.local",
      passwordHash: demoPasswordHash,
      role: "SCRAP_BUSINESS",
      tier: "TIER_3_WHOLESALE_AGGREGATOR",
      accountStatus: "ACTIVE",
      verificationLevel: "LEVEL_1_CONTACT_VERIFIED",
      platformCode: "KC-WHL-300301",
      phoneVerifiedAt: new Date(),
      profile: {
        create: {
          displayName: "Punjab Thok Baling & Mandi Godown",
          preferredLanguage: "PA",
          city: "Ludhiana",
          pincode: "141010",
        },
      },
      organization: {
        create: {
          tier: "TIER_3_WHOLESALE_AGGREGATOR",
          platformCode: "KC-WHL-300301",
          businessName: "Focal Point Wholesale Scrap & Baling Hub (Tier 3)",
          city: "Ludhiana",
          pincode: "141010",
          serviceRadiusKm: 60,
          verificationLevel: "LEVEL_1_CONTACT_VERIFIED",
          businessRegistration: {
            create: {
              registrationType: "GSTIN",
              registrationNumber: "03AABCP9912E1Z5",
              issuingAuthority: "GST Network India",
            },
          },
          storefront: {
            create: {
              slug: "focal-point-thok-mandi",
              shopTitle: "Focal Point Wholesale Mandi & Baling Hub (Tier-3)",
              tagline: "Hydraulic baling · Weighbridge · Buys 200 kg+ sorted shop loads",
              isOpen: true,
              minPickupGrams: 200000,
              servicePincodes: ["141001", "141003", "141010"],
              ratingAvg: 4.7,
              completedOrdersCnt: 890,
              rateItems: {
                create: [
                  {
                    materialId: createdMaterials["paper-cardboard"]!,
                    pickupRatePaise: 1620,
                    dropoffRatePaise: 1700,
                    minWeightGrams: 200000,
                  },
                  {
                    materialId: createdMaterials["metal-heavy-iron"]!,
                    pickupRatePaise: 3550,
                    dropoffRatePaise: 3650,
                    minWeightGrams: 200000,
                  },
                  {
                    materialId: createdMaterials["metal-copper-bright"]!,
                    pickupRatePaise: 69000,
                    dropoffRatePaise: 70500,
                    minWeightGrams: 50000,
                  },
                  {
                    materialId: createdMaterials["ewaste-insulated-cable"]!,
                    pickupRatePaise: 27500,
                    dropoffRatePaise: 28800,
                    minWeightGrams: 50000,
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  // Add a realistic PENDING VerificationCase in Admin queue for live review testing!
  await prisma.verificationCase.create({
    data: {
      applicantId: tier3User.id,
      requestedLevel: "LEVEL_3_BUSINESS_VERIFIED",
      status: "PENDING",
      notes: "Submitted Focal Point GSTIN & weighbridge calibration licence for Level 3 review.",
    },
  });

  // Tier 4: Verified CPCB Authorised Recycler Storefront
  await prisma.user.create({
    data: {
      phone: "+919811110004",
      email: "recycler@kabadiwala.local",
      passwordHash: demoPasswordHash,
      role: "AUTHORISED_RECYCLER",
      tier: "TIER_4_AUTHORISED_RECYCLER",
      accountStatus: "ACTIVE",
      verificationLevel: "LEVEL_4_AUTHORISED_RECYCLER",
      platformCode: "KC-REC-400401",
      phoneVerifiedAt: new Date(),
      profile: {
        create: {
          displayName: "GreenCircuit Authorised E-Waste & Metals Plant",
          preferredLanguage: "EN",
          city: "Ludhiana",
          pincode: "141015",
        },
      },
      organization: {
        create: {
          tier: "TIER_4_AUTHORISED_RECYCLER",
          platformCode: "KC-REC-400401",
          businessName: "GreenCircuit Critical Minerals & E-Waste Recycler Pvt Ltd",
          city: "Ludhiana",
          pincode: "141015",
          serviceRadiusKm: 250,
          verificationLevel: "LEVEL_4_AUTHORISED_RECYCLER",
          recyclerRegistration: {
            create: {
              authorityName: "CPCB / Punjab Pollution Control Board",
              registrationNumber: "CPCB-EW-PB-2026-0842",
              permittedStreams: ["EWASTE", "BATTERY", "NON_FERROUS"],
              authorisedCapacityT: 12000,
              cpcbPortalChecked: true,
              evidenceSourceUrl: "https://eprewaste.cpcb.gov.in/",
              verifiedAt: new Date(),
            },
          },
          storefront: {
            create: {
              slug: "greencircuit-authorised-plant",
              shopTitle: "GreenCircuit Authorised E-Waste Plant (Tier-4 End Recycler)",
              tagline: "Verified hydrometallurgical recovery · Direct bulk rates · Full traceability",
              isOpen: true,
              minPickupGrams: 500000,
              servicePincodes: ["141001", "141003", "141010", "141015"],
              ratingAvg: 5.0,
              completedOrdersCnt: 312,
              rateItems: {
                create: [
                  {
                    materialId: createdMaterials["ewaste-pcb-grade-a"]!,
                    pickupRatePaise: 215000,
                    dropoffRatePaise: 224000,
                    minWeightGrams: 100000,
                  },
                  {
                    materialId: createdMaterials["ewaste-insulated-cable"]!,
                    pickupRatePaise: 32000,
                    dropoffRatePaise: 33500,
                    minWeightGrams: 200000,
                  },
                  {
                    materialId: createdMaterials["metal-copper-bright"]!,
                    pickupRatePaise: 73500,
                    dropoffRatePaise: 74800,
                    minWeightGrams: 200000,
                  },
                  {
                    materialId: createdMaterials["battery-inverter-lead"]!,
                    pickupRatePaise: 11800,
                    dropoffRatePaise: 12400,
                    minWeightGrams: 250000,
                  },
                ],
              },
            },
          },
        },
      },
    },
  });

  // Seed one active sample order between Customer (Tier 0) -> Raju Collector (Tier 1)
  if (tier1Collector.organization?.storefront) {
    await prisma.transactionOrder.create({
      data: {
        orderNumber: "KC-ORD-20261023-1001",
        sellerId: customer.id,
        buyerId: tier1Collector.id,
        storefrontId: tier1Collector.organization.storefront.id,
        sellerTier: "TIER_0_GENERATOR",
        buyerTier: "TIER_1_LOCAL_COLLECTOR",
        fulfillmentMode: "BUYER_PICKUP",
        status: "REQUESTED",
        indicativeTotalPaise: 52300, // ₹523.00
        agreedTotalPaise: 52300,
        qrTraceToken: "KC-TRACE-DEMO1001A9F2",
        items: {
          create: [
            {
              materialId: createdMaterials["paper-newspaper"]!,
              lockedRatePaise: 1600,
              estimatedGrams: 10000,
              agreedSubtotalPaise: 16000,
            },
            {
              materialId: createdMaterials["metal-heavy-iron"]!,
              lockedRatePaise: 2900,
              estimatedGrams: 8000,
              agreedSubtotalPaise: 23200,
            },
            {
              materialId: createdMaterials["paper-cardboard"]!,
              lockedRatePaise: 1100,
              estimatedGrams: 11909,
              agreedSubtotalPaise: 13100,
            },
          ],
        },
      },
    });
  }

      await ensureMilestoneOneSeedData();
  await ensureMilestoneTwoSeedData();
  await ensureMilestoneThreeSeedData();
}

async function ensureMilestoneThreeSeedData(): Promise<void> {
  const prisma = await getPrisma();
  const existingHistory = await prisma.priceHistory.count();
  if (existingHistory > 0) return;

  const [copper, pcb, cardboard, alum, iron, collector, shopUser] = await Promise.all([
    prisma.materialCategory.findUnique({ where: { slug: "metal-copper-bright" } }),
    prisma.materialCategory.findUnique({ where: { slug: "ewaste-pcb-grade-a" } }),
    prisma.materialCategory.findUnique({ where: { slug: "paper-cardboard" } }),
    prisma.materialCategory.findUnique({ where: { slug: "metal-aluminium-utensil" } }),
    prisma.materialCategory.findUnique({ where: { slug: "metal-heavy-iron" } }),
    prisma.user.findUnique({ where: { email: "collector@kabadiwala.local" } }),
    prisma.user.findUnique({ where: { email: "shop@kabadiwala.local" } }),
  ]);

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const seriesSeed: Array<{
    matId: string | undefined;
    tier:
      | "TIER_1_LOCAL_COLLECTOR"
      | "TIER_2_AREA_SHOP"
      | "TIER_3_WHOLESALE_AGGREGATOR"
      | "TIER_4_AUTHORISED_RECYCLER";
    weeklyPaise: number[];
  }> = [
    {
      matId: copper?.id,
      tier: "TIER_1_LOCAL_COLLECTOR",
      weeklyPaise: [56000, 57000, 57500, 58500, 59000, 60000],
    },
    {
      matId: copper?.id,
      tier: "TIER_2_AREA_SHOP",
      weeklyPaise: [62500, 63500, 64000, 65000, 66000, 67000],
    },
    {
      matId: copper?.id,
      tier: "TIER_4_AUTHORISED_RECYCLER",
      weeklyPaise: [66500, 67500, 68000, 69000, 69500, 71000],
    },
    {
      matId: pcb?.id,
      tier: "TIER_1_LOCAL_COLLECTOR",
      weeklyPaise: [128000, 130000, 132000, 134000, 135000, 138000],
    },
    {
      matId: pcb?.id,
      tier: "TIER_2_AREA_SHOP",
      weeklyPaise: [160000, 162000, 165000, 166000, 168000, 171000],
    },
    {
      matId: pcb?.id,
      tier: "TIER_4_AUTHORISED_RECYCLER",
      weeklyPaise: [208000, 212000, 216000, 220000, 224000, 228000],
    },
    {
      matId: cardboard?.id,
      tier: "TIER_1_LOCAL_COLLECTOR",
      weeklyPaise: [1050, 1100, 1100, 1150, 1150, 1200],
    },
    {
      matId: cardboard?.id,
      tier: "TIER_3_WHOLESALE_AGGREGATOR",
      weeklyPaise: [1500, 1550, 1600, 1650, 1700, 1750],
    },
    {
      matId: alum?.id,
      tier: "TIER_1_LOCAL_COLLECTOR",
      weeklyPaise: [13000, 13200, 13500, 13800, 14000, 14200],
    },
    {
      matId: alum?.id,
      tier: "TIER_3_WHOLESALE_AGGREGATOR",
      weeklyPaise: [16200, 16500, 16800, 17000, 17400, 17600],
    },
    {
      matId: iron?.id,
      tier: "TIER_1_LOCAL_COLLECTOR",
      weeklyPaise: [2750, 2800, 2850, 2900, 2900, 2950],
    },
    {
      matId: iron?.id,
      tier: "TIER_3_WHOLESALE_AGGREGATOR",
      weeklyPaise: [3300, 3350, 3400, 3450, 3500, 3550],
    },
  ];

  const rows: Array<{
    city: string;
    tier:
      | "TIER_1_LOCAL_COLLECTOR"
      | "TIER_2_AREA_SHOP"
      | "TIER_3_WHOLESALE_AGGREGATOR"
      | "TIER_4_AUTHORISED_RECYCLER";
    materialId: string;
    medianRatePaise: number;
    minRatePaise: number;
    maxRatePaise: number;
    sampleCount: number;
    recordedAt: Date;
  }> = [];

  for (const s of seriesSeed) {
    if (!s.matId) continue;
    s.weeklyPaise.forEach((median, idx) => {
      const weeksAgo = s.weeklyPaise.length - 1 - idx;
      rows.push({
        city: "Ludhiana",
        tier: s.tier,
        materialId: s.matId!,
        medianRatePaise: median,
        minRatePaise: Math.round(median * 0.95),
        maxRatePaise: Math.round(median * 1.05),
        sampleCount: 8 + idx * 2,
        recordedAt: new Date(now - weeksAgo * 7 * dayMs),
      });
    });
  }

  if (rows.length > 0) {
    await prisma.priceHistory.createMany({ data: rows });
  }

  if (collector && shopUser) {
    await prisma.notification.createMany({
      data: [
        {
          userId: collector.id,
          title: "Tier-2 Copper Gate Rate Increased (+₹10/kg)",
          body: "Gill Road Scrap Shop updated Clean Copper gate drop-off offer to ₹670/kg.",
        },
        {
          userId: shopUser.id,
          title: "Tier-4 Authorised Recycler PCB Window Open",
          body: "GreenCircuit Critical Minerals is accepting sorted Grade-A PCB batches at ₹2,240/kg.",
        },
      ],
    });
  }
}

async function ensureMilestoneTwoSeedData(): Promise<void> {
  const prisma = await getPrisma();
  const marathiMap: Record<string, string> = {
    "paper-newspaper": "जुन्या वर्तमानपत्रांची रद्दी",
    "paper-cardboard": "पुठ्ठा / बॉक्स गट्टा",
    "plastic-pet-clear": "स्वच्छ PET पाण्याच्या बाटल्या",
    "metal-heavy-iron": "जड लोखंड आणि स्टील भंगार",
    "metal-copper-bright": "स्वच्छ तांब्याची तार / कॉईल",
    "ewaste-insulated-cable": "इन्सुलेटेड कॉपर केबल / वायर",
    "ewaste-pcb-grade-a": "हाय-ग्रेड मोबाईल / कॉम्प्युटर PCB",
    "battery-inverter-lead": "इन्व्हर्टर / गाडीची शिसे-अॅसिड बॅटरी",
  };

  for (const [slug, nameMr] of Object.entries(marathiMap)) {
    await prisma.materialCategory.updateMany({
      where: { slug },
      data: { nameMr },
    });
  }

  // Ensure Aluminum Coil / Utensil stream exists for Copper vs Aluminum AI verification & pricing
  const alumMat = await prisma.materialCategory.upsert({
    where: { slug: "metal-aluminium-utensil" },
    update: { nameMr: "अॅल्युमिनियम कॉईल / भांडी भंगार" },
    create: {
      slug: "metal-aluminium-utensil",
      nameEn: "Clean Aluminium Coil / Sheet (Silvery Non-Magnetic)",
      nameHi: "साफ़ एल्यूमीनियम कॉइल / बर्तन",
      namePa: "ਸਾਫ਼ ਐਲੂਮੀਨੀਅਮ ਕੋਇਲ / ਬਰਤਨ",
      nameMr: "अॅल्युमिनियम कॉईल / भांडी भंगार",
      streamGroup: "NON_FERROUS",
      defaultUnit: "KG",
      isRegulatedHazardous: false,
      minBuyerVerificationLevel: "LEVEL_0_REGISTERED",
      handlingGuidance:
        "Scratch oxide surface lightly to verify silvery aluminium core versus copper-coated aluminium.",
    },
  });

  // Seed active Aluminium rate items across Tier 1, Tier 2, Tier 3 storefronts if missing
  const tierRates: Array<{ slug: string; pickup: number; dropoff: number; minG: number }> = [
    { slug: "raju-doorstep-scrap-pickup", pickup: 13500, dropoff: 14200, minG: 1000 },
    { slug: "gill-road-scrap-shop", pickup: 15200, dropoff: 16000, minG: 5000 },
    { slug: "punjab-bulk-scrap-baling-hub", pickup: 16800, dropoff: 17600, minG: 50000 },
  ];

  for (const tr of tierRates) {
    const sf = await prisma.storefront.findUnique({ where: { slug: tr.slug } });
    if (sf) {
      const existingRate = await prisma.storefrontRateItem.findFirst({
        where: { storefrontId: sf.id, materialId: alumMat.id, isActive: true },
      });
      if (!existingRate) {
        await prisma.storefrontRateItem.create({
          data: {
            storefrontId: sf.id,
            materialId: alumMat.id,
            pickupRatePaise: tr.pickup,
            dropoffRatePaise: tr.dropoff,
            minWeightGrams: tr.minG,
            purityGrade: "CLEAN_SORTED",
            version: 1,
          },
        });
      }
    }
  }

  // Ensure extended household/commercial appliance BOMs exist for 2D CNN Camera X-Ray
  await prisma.deviceReferenceBOM.upsert({
    where: { slug: "ceiling-fan-copper-motor" },
    update: {},
    create: {
      slug: "ceiling-fan-copper-motor",
      deviceCategory: "CEILING_FAN",
      brandPattern: "Crompton / Havells / Orient 1200mm",
      modelName: "1200mm Induction Ceiling Fan (Copper Stator + 3 Blades)",
      typicalTotalGrams: 3850,
      coilType: "COPPER",
      componentsJson: [
        {
          materialSlug: "metal-copper-bright",
          label: "Copper Stator Winding Coils (~340g high-purity Cu)",
          grams: 340,
          indicativeValuePaise: 21500,
        },
        {
          materialSlug: "metal-aluminium-utensil",
          label: "3 Aluminum Aerodynamic Blades & Canopy",
          grams: 1150,
          indicativeValuePaise: 17500,
        },
        {
          materialSlug: "metal-heavy-iron",
          label: "Silicon Steel Stator Core, Shaft & Bearings",
          grams: 2360,
          indicativeValuePaise: 7200,
        },
      ],
      refurbishRangeMinPaise: 65000,
      refurbishRangeMaxPaise: 110000,
      partsHarvestMinPaise: 46000,
      partsHarvestMaxPaise: 58000,
      safetyNotes:
        "Discharge 2.5 uF capacitor terminals before unbolting stator housing; pull copper coils mechanically without burning varnish.",
    },
  });

  await prisma.deviceReferenceBOM.upsert({
    where: { slug: "washing-machine-twin-tub" },
    update: {},
    create: {
      slug: "washing-machine-twin-tub",
      deviceCategory: "WASHING_MACHINE",
      brandPattern: "LG / Whirlpool / Samsung 7.5kg Semi-Auto",
      modelName: "7.5 kg Twin-Tub Semi-Automatic Washing Machine",
      typicalTotalGrams: 21500,
      coilType: "ALUMINUM",
      componentsJson: [
        {
          materialSlug: "metal-copper-bright",
          label: "Wash + Spin Motor Windings & Power Harness",
          grams: 1250,
          indicativeValuePaise: 76000,
        },
        {
          materialSlug: "metal-aluminium-utensil",
          label: "Motor End-Shields, Pulleys & Spin Drum Hub",
          grams: 2400,
          indicativeValuePaise: 36500,
        },
        {
          materialSlug: "ewaste-pcb-grade-a",
          label: "Timer / Control Switchboard & Capacitor Pack",
          grams: 450,
          indicativeValuePaise: 14500,
        },
        {
          materialSlug: "metal-heavy-iron",
          label: "PP Copolymer Tub Body + Steel Base Frame",
          grams: 17400,
          indicativeValuePaise: 42000,
        },
      ],
      refurbishRangeMinPaise: 240000,
      refurbishRangeMaxPaise: 420000,
      partsHarvestMinPaise: 165000,
      partsHarvestMaxPaise: 215000,
      safetyNotes:
        "Drain residual water and discharge wash/spin capacitors safely before removing lower motor assembly.",
    },
  });
}

async function ensureMilestoneOneSeedData(): Promise<void> {
  const prisma = await getPrisma();
  const existingOpen = await prisma.materialListing.findFirst({
    where: { status: "LISTED" },
  });
  if (existingOpen) return;

  const [customer, collector, shopUser, copperMat, pcbMat, cardboardMat] =
    await Promise.all([
      prisma.user.findUnique({ where: { email: "customer@kabadiwala.local" } }),
      prisma.user.findUnique({
        where: { email: "collector@kabadiwala.local" },
        include: { organization: true },
      }),
      prisma.user.findUnique({
        where: { email: "shop@kabadiwala.local" },
        include: { organization: true },
      }),
      prisma.materialCategory.findUnique({ where: { slug: "metal-copper-bright" } }),
      prisma.materialCategory.findUnique({ where: { slug: "ewaste-pcb-grade-a" } }),
      prisma.materialCategory.findUnique({ where: { slug: "paper-cardboard" } }),
    ]);

  if (!customer || !collector || !shopUser || !copperMat || !pcbMat || !cardboardMat) {
    return;
  }

  // 1. Seed Open Broadcast Lot with Competing Buyer Offer
  const broadcastListing = await prisma.materialListing.create({
    data: {
      ownerId: customer.id,
      title: "Office Clearance: 8 kg Telecom/IT PCBs + 6 kg Clean Copper Wire",
      sellerTier: "TIER_0_GENERATOR",
      pickupCity: "Ludhiana",
      pickupPincode: "141001",
      pickupAddressPrivate: "Plot 19, Civil Lines Extension, Ludhiana",
      preferredMode: "BUYER_PICKUP",
      indicativeEstimatePaise: 1434000,
      status: "LISTED",
      items: {
        create: [
          {
            materialId: pcbMat.id,
            estimatedGrams: 8000,
            indicativeRatePaise: 135000,
            indicativeSubtotalPaise: 1080000,
          },
          {
            materialId: copperMat.id,
            estimatedGrams: 6000,
            indicativeRatePaise: 59000,
            indicativeSubtotalPaise: 354000,
          },
        ],
      },
    },
  });

  await prisma.purchaseOffer.create({
    data: {
      listingId: broadcastListing.id,
      buyerId: collector.id,
      priceType: "STOREFRONT_RATE_OR_OFFER",
      offeredTotalPaise: 1460000,
      version: 1,
      notes: "Same-hour digital hanging scale pickup + instant cash",
      status: "OPEN",
    },
  });

  // 2. Seed Morning Cash Advance (Peshgi) from Tier-2 Shop -> Tier-1 Collector Raju
  await prisma.khataLedgerEntry.create({
    data: {
      lenderId: shopUser.id,
      borrowerId: collector.id,
      entryType: "CASH_ADVANCE_GIVEN",
      amountPaise: 150000, // ₹1,500 morning cash advance
      balanceAfterPaise: 150000,
      notes: "7:30 AM morning pheri cash advance (Peshgi)",
    },
  });

  // 3. Seed Ready-to-Sell Stock Bins in Tier-1 Collector & Tier-2 Shop for instant upward sale testing
  if (collector.organization) {
    await prisma.inventoryBin.upsert({
      where: {
        organizationId_materialId: {
          organizationId: collector.organization.id,
          materialId: copperMat.id,
        },
      },
      update: {},
      create: {
        organizationId: collector.organization.id,
        materialId: copperMat.id,
        availableGrams: 9500, // 9.5 kg Copper collected from local homes
        weightedAvgCostPaise: 59000, // Bought @ ₹590/kg -> sells to Tier-2 @ ₹660/kg!
      },
    });
  }

  if (shopUser.organization) {
    await prisma.inventoryBin.upsert({
      where: {
        organizationId_materialId: {
          organizationId: shopUser.organization.id,
          materialId: pcbMat.id,
        },
      },
      update: {},
      create: {
        organizationId: shopUser.organization.id,
        materialId: pcbMat.id,
        availableGrams: 115000, // 115 kg Grade-A PCBs sorted at shop -> ready for Tier-4 CPCB Plant!
        weightedAvgCostPaise: 168000, // Bought @ ₹1,680/kg -> sells to Tier-4 @ ₹2,240/kg!
      },
    });
    await prisma.inventoryBin.upsert({
      where: {
        organizationId_materialId: {
          organizationId: shopUser.organization.id,
          materialId: cardboardMat.id,
        },
      },
      update: {},
      create: {
        organizationId: shopUser.organization.id,
        materialId: cardboardMat.id,
        availableGrams: 240000, // 240 kg Cardboard -> ready for Tier-3 Wholesale Baling Hub!
        weightedAvgCostPaise: 1350,
      },
    });
  }
}

if (require.main === module) {
  ensureSeeded()
    .then(() => {
      console.log("Kabadiwala Connect seed complete.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
