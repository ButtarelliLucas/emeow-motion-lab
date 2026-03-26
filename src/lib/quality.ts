import { clamp } from "@/lib/math";
import type { QualityTier } from "@/types/experience";

const QUALITY_ORDER: QualityTier[] = ["low", "medium", "high"];

export interface QualityDeviceHints {
  reducedMotion: boolean;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  userAgent?: string;
}

export function detectInitialQualityTier({
  reducedMotion,
  hardwareConcurrency,
  deviceMemory,
  userAgent,
}: QualityDeviceHints): QualityTier {
  if (reducedMotion) {
    return "low";
  }

  const cores = hardwareConcurrency ?? 4;
  const memory = deviceMemory ?? 4;
  const mobile = /android|iphone|ipad|mobile/i.test(userAgent ?? "");

  if (mobile && (memory <= 4 || cores <= 6)) {
    return "low";
  }

  if (!mobile && memory >= 8 && cores >= 8) {
    return "high";
  }

  return mobile ? "medium" : "high";
}

export function nextLowerQuality(tier: QualityTier) {
  const index = QUALITY_ORDER.indexOf(tier);
  return QUALITY_ORDER[clamp(index - 1, 0, QUALITY_ORDER.length - 1)];
}

export function nextHigherQuality(tier: QualityTier) {
  const index = QUALITY_ORDER.indexOf(tier);
  return QUALITY_ORDER[clamp(index + 1, 0, QUALITY_ORDER.length - 1)];
}
