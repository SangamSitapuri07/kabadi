import * as Speech from "expo-speech";
import { SupportedLanguage } from "@kabadi/shared";

export const MOBILE_SPEECH_LOCALE: Record<SupportedLanguage, string> = {
  EN: "en-IN",
  HI: "hi-IN",
  PA: "pa-IN",
  MR: "mr-IN",
};

export interface MobileTranslationPack {
  appName: string;
  tagline: string;
  navAuth: string;
  navMarket: string;
  navOps: string;
  navCamera: string;
  navSync: string;
  speakRatesBtn: string;
  bookSellBtn: string;
  weighSettleBtn: string;
  openUpiBtn: string;
  scanMaterialTab: string;
  scanScaleTab: string;
  scanQrTab: string;
  offlineSavedBadge: string;
}

export const MOBILE_STRINGS: Record<SupportedLanguage, MobileTranslationPack> = {
  EN: {
    appName: "Kabadiwala Connect Field",
    tagline: "T0→T4 Supply Chain · Offline SQLite · Native Camera & Speech",
    navAuth: "Account",
    navMarket: "Rates & Bids",
    navOps: "Bins & Khata",
    navCamera: "Cam & QR",
    navSync: "SQLite Sync",
    speakRatesBtn: "Speak Rates Aloud (Offline TTS)",
    bookSellBtn: "Book Drop-off / Pickup",
    weighSettleBtn: "Weigh & Settle",
    openUpiBtn: "Pay via UPI Intent",
    scanMaterialTab: "Scrap Purity AI",
    scanScaleTab: "7-Seg Scale OCR",
    scanQrTab: "QR Badge / Lineage",
    offlineSavedBadge: "Persisted on SQLite Disk",
  },
  HI: {
    appName: "कबाड़ीवाला कनेक्ट फील्ड",
    tagline: "T0→T4 सप्लाई चेन · ऑफ़लाइन SQLite · कैमरा और आवाज़",
    navAuth: "खाता",
    navMarket: "भाव व बोली",
    navOps: "स्टॉक व पेशगी",
    navCamera: "कैमरा व QR",
    navSync: "ऑफ़लाइन सिंक",
    speakRatesBtn: "भाव सुनें (ऑफ़लाइन आवाज़)",
    bookSellBtn: "माल बेचें / पिकअप बुक करें",
    weighSettleBtn: "तौल और भुगतान करें",
    openUpiBtn: "UPI से तुरंत भुगतान",
    scanMaterialTab: "माल शुद्धता जांच",
    scanScaleTab: "कांटा OCR जांच",
    scanQrTab: "QR पहचान स्कैनर",
    offlineSavedBadge: "फोन SQLite में सुरक्षित",
  },
  PA: {
    appName: "ਕਬਾੜੀਵਾਲਾ ਕਨੈਕਟ ਫੀਲਡ",
    tagline: "T0→T4 ਸਪਲਾਈ ਚੇਨ · ਆਫ਼ਲਾਈਨ SQLite · ਕੈਮਰਾ ਤੇ ਆਵਾਜ਼",
    navAuth: "ਖਾਤਾ",
    navMarket: "ਰੇਟ ਤੇ ਬੋਲੀ",
    navOps: "ਸਟਾਕ ਤੇ ਖਾਤਾ",
    navCamera: "ਕੈਮਰਾ ਤੇ QR",
    navSync: "ਆਫ਼ਲਾਈਨ ਸਿੰਕ",
    speakRatesBtn: "ਰੇਟ ਸੁਣੋ (ਆਫ਼ਲਾਈਨ ਆਵਾਜ਼)",
    bookSellBtn: "ਸਕ੍ਰੈਪ ਵੇਚੋ",
    weighSettleBtn: "ਤੋਲ ਅਤੇ ਭੁਗਤਾਨ",
    openUpiBtn: "UPI ਰਾਹੀਂ ਭੁਗਤਾਨ",
    scanMaterialTab: "ਮਾਲ ਸ਼ੁੱਧਤਾ ਜਾਂਚ",
    scanScaleTab: "ਕੰਡਾ OCR ਜਾਂਚ",
    scanQrTab: "QR ਬੈਜ ਸਕੈਨਰ",
    offlineSavedBadge: "SQLite ਡਿਸਕ ਵਿੱਚ ਸੇਵ",
  },
  MR: {
    appName: "कबाडीवाला कनेक्ट फील्ड",
    tagline: "T0→T4 साखळी · ऑफलाइन SQLite · कॅमेरा आणि आवाज",
    navAuth: "खाते",
    navMarket: "दर आणि बोली",
    navOps: "साठा व उचल",
    navCamera: "कॅमेरा व QR",
    navSync: "ऑफलाइन सिंक",
    speakRatesBtn: "दर ऐका (ऑफलाइन आवाज)",
    bookSellBtn: "भंगार विक्री नोंदवा",
    weighSettleBtn: "वजन आणि हिशोब करा",
    openUpiBtn: "UPI द्वारे पेमेंट करा",
    scanMaterialTab: "माल शुद्धता तपासणी",
    scanScaleTab: "काटा OCR तपासणी",
    scanQrTab: "QR ओळख स्कॅनर",
    offlineSavedBadge: "SQLite मध्ये सुरक्षित",
  },
};

/**
 * Speaks vernacular text using the native Android TextToSpeech / iOS AVSpeechSynthesizer engine
 * via `expo-speech` — works 100% offline in basements and field pheri routes!
 */
export async function speakNativeVernacular(
  text: string,
  lang: SupportedLanguage
): Promise<void> {
  try {
    const busy = await Speech.isSpeakingAsync();
    if (busy) {
      await Speech.stop();
    }
    Speech.speak(text, {
      language: MOBILE_SPEECH_LOCALE[lang],
      rate: 0.94,
      pitch: 1.0,
    });
  } catch {
    // Graceful no-op in headless CI / non-audio environments
  }
}

export async function stopNativeVernacularSpeech(): Promise<void> {
  try {
    await Speech.stop();
  } catch {
    // Graceful no-op
  }
}
