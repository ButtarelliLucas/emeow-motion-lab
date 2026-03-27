import { describe, expect, it } from "vitest";
import {
  LIVE_CHROME_FULLSCREEN_DELAY_MS,
  LIVE_CHROME_HAND_LATCH_MS,
  LIVE_CHROME_LOGO_DELAY_MS,
  getLiveChromeFlags,
  isLiveChromePhase,
  isMeaningfulPointerMove,
  shouldKeepHandPresenceLatched,
} from "@/lib/live-chrome";

describe("live chrome helpers", () => {
  it("identifies the live chrome phases", () => {
    expect(isLiveChromePhase("live")).toBe(true);
    expect(isLiveChromePhase("handMissing")).toBe(true);
    expect(isLiveChromePhase("intro")).toBe(false);
  });

  it("keeps hand presence latched within the recovery window", () => {
    expect(shouldKeepHandPresenceLatched(1000, 1000 + LIVE_CHROME_HAND_LATCH_MS - 1)).toBe(true);
    expect(shouldKeepHandPresenceLatched(1000, 1000 + LIVE_CHROME_HAND_LATCH_MS + 1)).toBe(false);
    expect(shouldKeepHandPresenceLatched(null, 1000)).toBe(false);
  });

  it("ignores tiny pointer movement and accepts meaningful movement", () => {
    expect(isMeaningfulPointerMove(null, { x: 10, y: 10 })).toBe(true);
    expect(isMeaningfulPointerMove({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
    expect(isMeaningfulPointerMove({ x: 10, y: 10 }, { x: 18, y: 10 })).toBe(true);
  });

  it("derives the staggered center stage flags", () => {
    expect(
      getLiveChromeFlags({
        phase: "live",
        handPresenceLatched: true,
        chromeVisible: false,
        centerStageReady: false,
        fullscreenReady: false,
        fullscreenSupported: true,
      }),
    ).toEqual({
      siteOnlyMode: true,
      centerLogoVisible: false,
      fullscreenVisible: false,
    });

    expect(
      getLiveChromeFlags({
        phase: "live",
        handPresenceLatched: true,
        chromeVisible: false,
        centerStageReady: true,
        fullscreenReady: true,
        fullscreenSupported: true,
      }),
    ).toEqual({
      siteOnlyMode: true,
      centerLogoVisible: true,
      fullscreenVisible: true,
    });

    expect(LIVE_CHROME_FULLSCREEN_DELAY_MS).toBeGreaterThan(LIVE_CHROME_LOGO_DELAY_MS);
  });
});
