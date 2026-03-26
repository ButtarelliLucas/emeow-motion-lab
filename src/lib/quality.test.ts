import { describe, expect, it } from "vitest";
import { detectInitialQualityTier, nextHigherQuality, nextLowerQuality } from "@/lib/quality";

describe("quality helpers", () => {
  it("prefers low quality when reduced motion is active", () => {
    expect(
      detectInitialQualityTier({
        reducedMotion: true,
        hardwareConcurrency: 8,
        deviceMemory: 8,
        userAgent: "Desktop",
      }),
    ).toBe("low");
  });

  it("starts low on constrained mobile devices", () => {
    expect(
      detectInitialQualityTier({
        reducedMotion: false,
        hardwareConcurrency: 4,
        deviceMemory: 4,
        userAgent: "iPhone",
      }),
    ).toBe("low");
  });

  it("allows higher tiers on stronger desktops", () => {
    expect(
      detectInitialQualityTier({
        reducedMotion: false,
        hardwareConcurrency: 12,
        deviceMemory: 16,
        userAgent: "Desktop",
      }),
    ).toBe("high");
  });

  it("moves quality tiers predictably", () => {
    expect(nextLowerQuality("high")).toBe("medium");
    expect(nextLowerQuality("medium")).toBe("low");
    expect(nextHigherQuality("low")).toBe("medium");
    expect(nextHigherQuality("medium")).toBe("high");
  });
});
