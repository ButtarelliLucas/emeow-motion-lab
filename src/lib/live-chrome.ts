import type { ExperiencePhase } from "@/types/experience";

export const LIVE_CHROME_HAND_LATCH_MS = 1200;
export const LIVE_CHROME_INACTIVITY_MS = 2200;
export const LIVE_CHROME_POINTER_DELTA_PX = 6;
export const LIVE_CHROME_LOGO_DELAY_MS = 180;
export const LIVE_CHROME_FULLSCREEN_DELAY_MS = LIVE_CHROME_LOGO_DELAY_MS + 240;

export function isLiveChromePhase(phase: ExperiencePhase) {
  return phase === "live" || phase === "handMissing";
}

export function shouldKeepHandPresenceLatched(lastDetectedAt: number | null, now: number) {
  if (lastDetectedAt === null) {
    return false;
  }

  return now - lastDetectedAt <= LIVE_CHROME_HAND_LATCH_MS;
}

export function isMeaningfulPointerMove(
  previous: { x: number; y: number } | null,
  next: { x: number; y: number },
) {
  if (!previous) {
    return true;
  }

  return Math.hypot(next.x - previous.x, next.y - previous.y) >= LIVE_CHROME_POINTER_DELTA_PX;
}

export function getLiveChromeFlags({
  phase,
  handPresenceLatched,
  chromeVisible,
  centerStageReady,
  fullscreenReady,
  fullscreenSupported,
}: {
  phase: ExperiencePhase;
  handPresenceLatched: boolean;
  chromeVisible: boolean;
  centerStageReady: boolean;
  fullscreenReady: boolean;
  fullscreenSupported: boolean;
}) {
  const livePhase = isLiveChromePhase(phase);
  const siteOnlyMode = livePhase && handPresenceLatched && !chromeVisible;

  return {
    siteOnlyMode,
    centerLogoVisible: siteOnlyMode && centerStageReady,
    fullscreenVisible: siteOnlyMode && centerStageReady && fullscreenReady && fullscreenSupported,
  };
}
