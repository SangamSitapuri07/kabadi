import { SupportedLanguage } from "@kabadi/shared";

export interface RateSpeechLine {
  nameEn: string;
  nameHi: string;
  namePa: string;
  nameMr?: string;
  pickupRateInr: string;
  dropoffRateInr: string;
  unit: string;
  isRegulatedHazardous?: boolean;
}

export function pickLocalizedMaterialName(
  m: { nameEn: string; nameHi: string; namePa: string; nameMr?: string | null },
  lang: SupportedLanguage
): string {
  switch (lang) {
    case "HI":
      return m.nameHi || m.nameEn;
    case "PA":
      return m.namePa || m.nameEn;
    case "MR":
      return m.nameMr && m.nameMr.trim().length > 0 ? m.nameMr : m.nameHi || m.nameEn;
    default:
      return m.nameEn;
  }
}

export function voiceLocaleForLanguage(lang: SupportedLanguage): string {
  switch (lang) {
    case "HI":
      return "hi-IN";
    case "PA":
      return "pa-IN";
    case "MR":
      return "mr-IN";
    default:
      return "en-IN";
  }
}

export function buildStorefrontSpeechScript(
  shopTitle: string,
  tierLabel: string,
  rates: RateSpeechLine[],
  lang: SupportedLanguage
): { locale: string; script: string } {
  const topRates = rates.slice(0, 5);
  const locale = voiceLocaleForLanguage(lang);

  if (lang === "HI") {
    const items = topRates
      .map(
        (r) =>
          `${pickLocalizedMaterialName(r, "HI")} पिकअप भाव ${r.pickupRateInr} रुपये और दुकान गेट भाव ${r.dropoffRateInr} रुपये प्रति ${r.unit === "KG" ? "किलो" : "नग"}`
      )
      .join("। ");
    return {
      locale,
      script: `कबाड़ीवाला कनेक्ट भाव बोर्ड: ${shopTitle} (${tierLabel})। ${items}। अंतिम भुगतान कांटे पर वास्तविक तौल के बाद ही तय होगा।`,
    };
  }

  if (lang === "PA") {
    const items = topRates
      .map(
        (r) =>
          `${pickLocalizedMaterialName(r, "PA")} ਪਿਕਅੱਪ ਰੇਟ ${r.pickupRateInr} ਰੁਪਏ ਅਤੇ ਦੁਕਾਨ ਗੇਟ ਰੇਟ ${r.dropoffRateInr} ਰੁਪਏ ਪ੍ਰਤੀ ${r.unit === "KG" ? "ਕਿਲੋ" : "ਪੀਸ"}`
      )
      .join("। ");
    return {
      locale,
      script: `ਕਬਾੜੀਵਾਲਾ ਕਨੈਕਟ ਰੇਟ ਕਾਰਡ: ${shopTitle} (${tierLabel})। ${items}। ਆਖ਼ਰੀ ਭੁਗਤਾਨ ਕੰਡੇ ਤੇ ਅਸਲ ਤੋਲ ਤੋਂ ਬਾਅਦ ਹੋਵੇਗਾ।`,
    };
  }

  if (lang === "MR") {
    const items = topRates
      .map(
        (r) =>
          `${pickLocalizedMaterialName(r, "MR")} घरपोच पिकअप दर ${r.pickupRateInr} रुपये आणि दुकान गेट दर ${r.dropoffRateInr} रुपये प्रति ${r.unit === "KG" ? "किलो" : "नग"}`
      )
      .join("। ");
    return {
      locale,
      script: `कबाडीवाला कनेक्ट दर फलक: ${shopTitle} (${tierLabel})। ${items}। अंतिम रक्कम काट्यावर प्रत्यक्ष वजन केल्यानंतरच ठरवली जाईल।`,
    };
  }

  const items = topRates
    .map(
      (r) =>
        `${r.nameEn}: pickup ${r.pickupRateInr} rupees, gate drop-off ${r.dropoffRateInr} rupees per ${r.unit === "KG" ? "kilogram" : "piece"}`
    )
    .join(". ");
  return {
    locale,
    script: `Kabadiwala Connect Rate Board for ${shopTitle} (${tierLabel}). ${items}. Final payout is strictly settled upon verified scale weighing.`,
  };
}

export function buildVisionScanSpeech(params: {
  materialNames: { nameEn: string; nameHi: string; namePa: string; nameMr?: string };
  estimatedKg: string;
  minInr: string;
  maxInr: string;
  confidencePct: number;
  fraudFlags: string[];
  hazardWarning: string | null;
  lang: SupportedLanguage;
}): Record<SupportedLanguage, string> {
  const { materialNames, estimatedKg, minInr, maxInr, confidencePct, fraudFlags, hazardWarning } =
    params;

  const hasFraud = fraudFlags.length > 0;
  const fraudNoteEn = hasFraud
    ? ` Warning: Anti-fraud alert triggered (${fraudFlags.join(", ")}). Inspect lot physically before payment.`
    : "";
  const fraudNoteHi = hasFraud
    ? ` सावधान! धोखाधड़ी या नमी की चेतावनी (${fraudFlags.join(", ")})। पैसे देने से पहले माल खुद जांचें।`
    : "";
  const fraudNotePa = hasFraud
    ? ` ਸਾਵਧਾਨ! ਧੋਖਾਧੜੀ ਜਾਂ ਨਮੀ ਦੀ ਚੇਤਾਵਨੀ (${fraudFlags.join(", ")})। ਭੁਗਤਾਨ ਤੋਂ ਪਹਿਲਾਂ ਮਾਲ ਚੈੱਕ ਕਰੋ।`
    : "";
  const fraudNoteMr = hasFraud
    ? ` सावधान! फसवणूक किंवा ओलाव्याची सूचना (${fraudFlags.join(", ")})। पैसे देण्यापूर्वी माल तपासा।`
    : "";

  const hazEn = hazardWarning ? ` Safety rule: ${hazardWarning}` : "";
  const hazHi = hazardWarning
    ? " सुरक्षा नियम: तार कभी न जलाएं और बैटरी या पीसीबी को हाथ के दस्ताने पहनकर अलग रखें।"
    : "";
  const hazPa = hazardWarning
    ? " ਸੁਰੱਖਿਆ ਨਿਯਮ: ਤਾਰਾਂ ਕਦੇ ਨਾ ਸਾੜੋ ਅਤੇ ਬੈਟਰੀ ਜਾਂ ਪੀਸੀਬੀ ਨੂੰ ਦਸਤਾਨੇ ਪਾ ਕੇ ਵੱਖ ਰੱਖੋ।"
    : "";
  const hazMr = hazardWarning
    ? " सुरक्षा नियम: केबल कधीही जाळू नका आणि बॅटरी किंवा पीसीबी हातमोजे घालून वेगळे ठेवा।"
    : "";

  return {
    EN: `Camera AI Indicative Scan (${confidencePct}% confidence): Detected ${materialNames.nameEn} for ${estimatedKg} kilograms. Estimated local market range is ${minInr} to ${maxInr} rupees.${fraudNoteEn}${hazEn}`,
    HI: `कैमरा एआई अनुमानित जांच (${confidencePct}% भरोसा): ${estimatedKg} किलो ${pickLocalizedMaterialName(materialNames, "HI")} पहचाना गया। स्थानीय बाजार का अनुमानित मूल्य ${minInr} से ${maxInr} रुपये है।${fraudNoteHi}${hazHi}`,
    PA: `ਕੈਮਰਾ ਏਆਈ ਅੰਦਾਜ਼ਨ ਜਾਂਚ (${confidencePct}% ਭਰੋਸਾ): ${estimatedKg} ਕਿਲੋ ${pickLocalizedMaterialName(materialNames, "PA")} ਪਛਾਣਿਆ ਗਿਆ। ਅੰਦਾਜ਼ਨ ਬਜ਼ਾਰ ਕੀਮਤ ${minInr} ਤੋਂ ${maxInr} ਰੁਪਏ ਹੈ।${fraudNotePa}${hazPa}`,
    MR: `कॅमेरा एआय अंदाजे तपासणी (${confidencePct}% विश्वास): ${estimatedKg} किलो ${pickLocalizedMaterialName(materialNames, "MR")} ओळखले गेले. स्थानिक बाजारातील अंदाजे किंमत ${minInr} ते ${maxInr} रुपये आहे.${fraudNoteMr}${hazMr}`,
  };
}

export function buildScaleVerdictSpeech(params: {
  declaredKg: string;
  ocrKg: string | null;
  discrepancyFlag: boolean;
  replayFlag: boolean;
}): Record<SupportedLanguage, string> {
  const { declaredKg, ocrKg, discrepancyFlag, replayFlag } = params;

  if (replayFlag) {
    return {
      EN: `Security Alert! Duplicate scale photo detected. This weighing photo matches an earlier scan and cannot be trusted as fresh proof.`,
      HI: `सुरक्षा चेतावनी! यह कांटे की फोटो पुरानी या दोबारा इस्तेमाल की गई है। कृपया ताज़ा तौल की फोटो लें।`,
      PA: `ਸੁਰੱਖਿਆ ਚੇਤਾਵਨੀ! ਇਹ ਕੰਡੇ ਦੀ ਫੋਟੋ ਪੁਰਾਣੀ ਜਾਂ ਦੁਬਾਰਾ ਵਰਤੀ ਗਈ ਹੈ। ਕਿਰਪਾ ਕਰਕੇ ਨਵੀਂ ਫੋਟੋ ਖਿੱਚੋ।`,
      MR: `सुरक्षा इशारा! हा काट्याचा फोटो जुना किंवा पुन्हा वापरलेला आढळला आहे. कृपया नवीन वजनाचा फोटो घ्या.`,
    };
  }

  if (!ocrKg) {
    return {
      EN: `Scale digits could not be read clearly. Declared weight ${declaredKg} kilograms requires manual two-party verification.`,
      HI: `कांटे के अंक साफ़ दिखाई नहीं दे रहे हैं। ${declaredKg} किलो वजन की दोनों पक्ष मिलकर पुष्टि करें।`,
      PA: `ਕੰਡੇ ਦੇ ਨੰਬਰ ਸਾਫ਼ ਨਹੀਂ ਦਿਸ ਰਹੇ। ${declaredKg} ਕਿਲੋ ਭਾਰ ਦੀ ਦੋਵੇਂ ਧਿਰਾਂ ਪੁਸ਼ਟੀ ਕਰਨ।`,
      MR: `काट्यावरील आकडे स्पष्ट दिसत नाहीत. ${declaredKg} किलो वजनाची दोन्ही बाजूंनी खात्री करा.`,
    };
  }

  if (discrepancyFlag) {
    return {
      EN: `Weight Discrepancy Alert! Digital scale displays ${ocrKg} kilograms, whereas ${declaredKg} kilograms was entered. Hold settlement and re-weigh immediately.`,
      HI: `वजन में अंतर की चेतावनी! डिजिटल कांटे पर ${ocrKg} किलो दिख रहा है, लेकिन ${declaredKg} किलो दर्ज किया गया है। भुगतान रोकें और दोबारा तौल करें।`,
      PA: `ਭਾਰ ਵਿੱਚ ਫ਼ਰਕ ਦੀ ਚੇਤਾਵਨੀ! ਡਿਜੀਟਲ ਕੰਡੇ ਤੇ ${ocrKg} ਕਿਲੋ ਦਿਸ ਰਿਹਾ ਹੈ ਪਰ ${declaredKg} ਕਿਲੋ ਭਰਿਆ ਗਿਆ ਹੈ। ਦੁਬਾਰਾ ਤੋਲ ਕਰੋ।`,
      MR: `वजनामध्ये तफावत आढळली! डिजिटल काट्यावर ${ocrKg} किलो दिसत आहे, पण ${declaredKg} किलो नोंदवले गेले आहे. पुन्हा वजन तपासा.`,
    };
  }

  return {
    EN: `Scale Verified! Digital display reading of ${ocrKg} kilograms matches declared weight of ${declaredKg} kilograms within tolerance.`,
    HI: `तौल सत्यापित! डिजिटल कांटे का वजन ${ocrKg} किलो दर्ज किए गए ${declaredKg} किलो से मेल खाता है।`,
    PA: `ਤੋਲ ਪ੍ਰਮਾਣਿਤ! ਡਿਜੀਟਲ ਕੰਡੇ ਦਾ ਭਾਰ ${ocrKg} ਕਿਲੋ ਦਰਜ ਕੀਤੇ ${declaredKg} ਕਿਲੋ ਨਾਲ ਮਿਲਦਾ ਹੈ।`,
    MR: `वजन प्रमाणित! डिजिटल काट्यावरील ${ocrKg} किलो वजन नोंदवलेल्या ${declaredKg} किलोशी जुळते.`,
  };
}
