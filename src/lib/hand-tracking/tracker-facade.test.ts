import { describe, expect, it } from "vitest";
import { shouldFallbackAfterBitmapCaptureFailure } from "@/lib/hand-tracking/tracker-facade";

describe("shouldFallbackAfterBitmapCaptureFailure", () => {
  it("allows a couple of transient capture failures before falling back", () => {
    expect(shouldFallbackAfterBitmapCaptureFailure(1)).toBe(false);
    expect(shouldFallbackAfterBitmapCaptureFailure(2)).toBe(false);
  });

  it("falls back only after repeated capture failures", () => {
    expect(shouldFallbackAfterBitmapCaptureFailure(3)).toBe(true);
    expect(shouldFallbackAfterBitmapCaptureFailure(4)).toBe(true);
  });
});
