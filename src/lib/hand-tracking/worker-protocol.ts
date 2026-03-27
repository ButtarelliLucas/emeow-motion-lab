import type { InteractionState, QualityTier, ViewportMapping } from "@/types/experience";

export type WorkerRequest =
  | {
      type: "init";
      qualityTier: QualityTier;
      reducedMotion: boolean;
      detailedLandmarksEnabled?: boolean;
    }
  | {
      type: "frame";
      frameId: number;
      timestamp: number;
      bitmap: ImageBitmap;
    }
  | {
      type: "setViewportMapping";
      mapping: ViewportMapping;
    }
  | {
      type: "setQualityTier";
      qualityTier: QualityTier;
    }
  | {
      type: "setDetailedLandmarksEnabled";
      enabled: boolean;
    }
  | {
      type: "pause";
    }
  | {
      type: "resume";
    }
  | {
      type: "reset";
      now: number;
    }
  | {
      type: "dispose";
    };

export type WorkerResponse =
  | {
      type: "ready";
      backend: "worker";
    }
  | {
      type: "trackingResult";
      frameId: number;
      trackingMs: number;
      interaction: InteractionState;
    }
  | {
      type: "reset";
      interaction: InteractionState;
    }
  | {
      type: "error";
      phase: "init" | "runtime";
      message: string;
    };
