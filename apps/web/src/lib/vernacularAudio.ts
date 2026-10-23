export type AppLanguage = "EN" | "HI" | "PA" | "MR";

export const LANGUAGE_META: Record<
  AppLanguage,
  { nativeLabel: string; englishName: string; locale: string }
> = {
  EN: { nativeLabel: "English", englishName: "English", locale: "en-IN" },
  HI: { nativeLabel: "हिन्दी", englishName: "Hindi", locale: "hi-IN" },
  PA: { nativeLabel: "ਪੰਜਾਬੀ", englishName: "Punjabi", locale: "pa-IN" },
  MR: { nativeLabel: "मराठी", englishName: "Marathi", locale: "mr-IN" },
};

/** Synthesize crisp WebAudio acoustic cue for verified scans vs fraud/discrepancy warnings */
export function playAcousticCue(kind: "verified" | "alert" | "info"): void {
  if (typeof window === "undefined") return;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const note = (freq: number, startOffset: number, duration: number, type: OscillatorType) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.12, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    if (kind === "verified") {
      note(523.25, 0, 0.14, "sine");
      note(659.25, 0.12, 0.18, "sine");
    } else if (kind === "alert") {
      note(440, 0, 0.13, "triangle");
      note(349.23, 0.14, 0.13, "triangle");
      note(440, 0.28, 0.18, "triangle");
    } else {
      note(587.33, 0, 0.12, "sine");
    }
  } catch {
    // Ignore audio context autoplay blocks gracefully
  }
}

export function speakVernacularText(
  text: string,
  lang: AppLanguage,
  tone: "verified" | "alert" | "info" = "info",
  onEnd?: () => void
): void {
  playAcousticCue(tone);
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    if (onEnd) setTimeout(onEnd, 3000);
    return;
  }

  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const targetLocale = LANGUAGE_META[lang].locale;
  utter.lang = targetLocale;
  utter.rate = 0.96;

  // Match best installed regional Indian voice with Devanagari fallback for Marathi
  const voices = window.speechSynthesis.getVoices();
  const exact =
    voices.find((v) => v.lang.toLowerCase() === targetLocale.toLowerCase()) ||
    voices.find((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase())) ||
    (lang === "MR" ? voices.find((v) => v.lang.toLowerCase().startsWith("hi")) : undefined);
  if (exact) {
    utter.voice = exact;
  }

  utter.onend = () => onEnd?.();
  utter.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utter);
}

export function stopVernacularSpeech(): void {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}
