import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { EXPERIENCE_CONFIG } from "@/config/experience";
import { assetUrl } from "@/lib/assets";
import { createEmptyInteractionState, TrackingStateEngine } from "@/lib/hand-tracking/tracker-core";
import { createViewportMapping } from "@/lib/viewport-mapping";
import type { InteractionState, QualityTier, TrackingBackend, ViewportMapping } from "@/types/experience";

interface TrackerCallbacks {
  onInteraction: (interaction: InteractionState) => void;
  onTrackingMetrics: (trackingMs: number) => void;
  onTrackingBackend: (backend: TrackingBackend) => void;
}

interface TrackerOptions {
  qualityTier: QualityTier;
  reducedMotion: boolean;
  callbacks: TrackerCallbacks;
}

function defaultViewportMapping() {
  return createViewportMapping({
    viewportWidth: 1,
    viewportHeight: 1,
    videoWidth: 1,
    videoHeight: 1,
  });
}

export class HandTrackerController {
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly callbacks: TrackerCallbacks;
  private running = false;
  private paused = false;
  private rafId = 0;
  private videoFrameId = 0;
  private lastTrackedAt = 0;
  private lastVideoTime = -1;
  private trackIntervalMs: number;
  private readonly engine: TrackingStateEngine;

  constructor({ qualityTier, reducedMotion, callbacks }: TrackerOptions) {
    this.callbacks = callbacks;
    this.trackIntervalMs = 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
    this.engine = new TrackingStateEngine({
      qualityTier,
      reducedMotion,
    });
    this.engine.setViewportMapping(defaultViewportMapping());
  }

  async init() {
    this.callbacks.onTrackingBackend("legacy");
    const vision = await FilesetResolver.forVisionTasks(assetUrl("mediapipe/wasm/"));

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: assetUrl("models/hand_landmarker.task"),
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.45,
      });
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: assetUrl("models/hand_landmarker.task"),
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.45,
      });
    }
  }

  attachVideo(video: HTMLVideoElement) {
    this.video = video;
  }

  setViewportMapping(mapping: ViewportMapping) {
    this.engine.setViewportMapping(mapping);
  }

  setQualityTier(qualityTier: QualityTier) {
    this.trackIntervalMs = 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
    this.engine.setQualityTier(qualityTier);
  }

  setDetailedLandmarksEnabled(enabled: boolean) {
    this.engine.setDetailedLandmarksEnabled(enabled);
  }

  start() {
    if (!this.landmarker || !this.video || this.running) {
      return;
    }

    this.running = true;
    this.paused = false;
    this.lastTrackedAt = 0;
    this.lastVideoTime = -1;
    this.scheduleNextTick();
  }

  stop() {
    this.running = false;
    this.cancelScheduledTick();
  }

  setPaused(paused: boolean) {
    this.paused = paused;

    if (paused) {
      this.cancelScheduledTick();
      return;
    }

    if (this.running && !this.rafId && !this.videoFrameId) {
      this.scheduleNextTick();
    }
  }

  reset() {
    this.callbacks.onInteraction(this.engine.reset(performance.now()));
  }

  destroy() {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.engine.reset(performance.now());
  }

  private cancelScheduledTick() {
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    if (this.videoFrameId && this.video?.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.videoFrameId);
      this.videoFrameId = 0;
    }
  }

  private scheduleNextTick() {
    if (!this.running || this.paused) {
      return;
    }

    if (this.video?.requestVideoFrameCallback) {
      this.videoFrameId = this.video.requestVideoFrameCallback(this.handleVideoFrame);
      return;
    }

    this.rafId = window.requestAnimationFrame(this.tick);
  }

  private readonly handleVideoFrame = (now: number) => {
    this.videoFrameId = 0;
    this.tick(now);
  };

  private readonly tick = (now: number) => {
    if (!this.running || this.paused) {
      this.cancelScheduledTick();
      return;
    }

    const video = this.video;
    if (!this.landmarker || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.scheduleNextTick();
      return;
    }

    const usingVideoFrames = typeof video.requestVideoFrameCallback === "function";
    if ((!usingVideoFrames && video.currentTime === this.lastVideoTime) || now - this.lastTrackedAt < this.trackIntervalMs) {
      this.scheduleNextTick();
      return;
    }

    this.lastTrackedAt = now;
    this.lastVideoTime = video.currentTime;

    const startedAt = performance.now();
    const result = this.landmarker.detectForVideo(video, now);
    const trackingMs = performance.now() - startedAt;

    this.callbacks.onTrackingMetrics(trackingMs);
    this.processResult(result, now);
    this.scheduleNextTick();
  };

  private processResult(result: HandLandmarkerResult, now: number) {
    this.callbacks.onInteraction(this.engine.processResult(result, now));
  }
}

export { createEmptyInteractionState };
