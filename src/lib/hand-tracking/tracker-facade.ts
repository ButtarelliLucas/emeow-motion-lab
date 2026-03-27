import { EXPERIENCE_CONFIG } from "@/config/experience";
import { createEmptyInteractionState } from "@/lib/hand-tracking/tracker-core";
import { createViewportMapping } from "@/lib/viewport-mapping";
import type { WorkerRequest, WorkerResponse } from "@/lib/hand-tracking/worker-protocol";
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

interface HandTrackingControllerLike {
  init(): Promise<void>;
  attachVideo(video: HTMLVideoElement): void;
  setViewportMapping(mapping: ViewportMapping): void;
  setQualityTier(qualityTier: QualityTier): void;
  setDetailedLandmarksEnabled(enabled: boolean): void;
  start(): void;
  stop(): void;
  setPaused(paused: boolean): void;
  reset(): void;
  destroy(): void;
}

function defaultViewportMapping() {
  return createViewportMapping({
    viewportWidth: 1,
    viewportHeight: 1,
    videoWidth: 1,
    videoHeight: 1,
  });
}

function supportsWorkerTracking() {
  return typeof Worker !== "undefined" && typeof createImageBitmap === "function";
}

async function loadMainThreadTracker() {
  const module = await import("@/lib/hand-tracking/tracker");
  return module.HandTrackerController;
}

export class HandTrackerController implements HandTrackingControllerLike {
  private readonly callbacks: TrackerCallbacks;
  private readonly reducedMotion: boolean;
  private qualityTier: QualityTier;
  private video: HTMLVideoElement | null = null;
  private viewportMapping: ViewportMapping = defaultViewportMapping();
  private detailedLandmarksEnabled = false;
  private running = false;
  private paused = false;
  private rafId = 0;
  private videoFrameId = 0;
  private lastTrackedAt = 0;
  private lastVideoTime = -1;
  private trackIntervalMs: number;
  private frameInFlight = false;
  private nextFrameId = 0;
  private worker: Worker | null = null;
  private workerReady = false;
  private fallback: HandTrackingControllerLike | null = null;
  private fallbackInitPromise: Promise<void> | null = null;
  private reportedBackend: TrackingBackend | null = null;

  constructor({ qualityTier, reducedMotion, callbacks }: TrackerOptions) {
    this.qualityTier = qualityTier;
    this.reducedMotion = reducedMotion;
    this.callbacks = callbacks;
    this.trackIntervalMs = this.getTrackIntervalMs(qualityTier);
  }

  async init() {
    if (!supportsWorkerTracking()) {
      await this.activateFallback("Worker tracking unsupported in this browser.");
      return;
    }

    try {
      this.worker = new Worker(new URL("../../workers/hand-tracker.worker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = this.handleWorkerMessage;
      this.worker.onerror = () => {
        void this.activateFallback("Worker tracker crashed.");
      };

      await new Promise<void>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          reject(new Error("Worker hand tracker init timed out."));
        }, 12000);

        const handleReady = (event: MessageEvent<WorkerResponse>) => {
          if (event.data.type === "ready") {
            window.clearTimeout(timeoutId);
            this.workerReady = true;
            this.reportBackend("parallel");
            this.worker?.removeEventListener("message", handleReady);
            resolve();
          } else if (event.data.type === "error" && event.data.phase === "init") {
            window.clearTimeout(timeoutId);
            this.worker?.removeEventListener("message", handleReady);
            reject(new Error(event.data.message));
          }
        };

        this.worker?.addEventListener("message", handleReady);
        this.postToWorker({
          type: "init",
          qualityTier: this.qualityTier,
          reducedMotion: this.reducedMotion,
          detailedLandmarksEnabled: this.detailedLandmarksEnabled,
        });
      });

      this.postToWorker({
        type: "setViewportMapping",
        mapping: this.viewportMapping,
      });
    } catch (error) {
      console.warn("Worker tracker unavailable, falling back to main thread tracker.", error);
      await this.activateFallback("Worker tracker failed to initialize.");
    }
  }

  attachVideo(video: HTMLVideoElement) {
    this.video = video;
    this.fallback?.attachVideo(video);
  }

  setViewportMapping(mapping: ViewportMapping) {
    this.viewportMapping = mapping;
    if (this.fallback) {
      this.fallback.setViewportMapping(mapping);
      return;
    }

    this.postToWorker({
      type: "setViewportMapping",
      mapping,
    });
  }

  setQualityTier(qualityTier: QualityTier) {
    this.qualityTier = qualityTier;
    this.trackIntervalMs = this.getTrackIntervalMs(qualityTier);

    if (this.fallback) {
      this.fallback.setQualityTier(qualityTier);
      return;
    }

    this.postToWorker({
      type: "setQualityTier",
      qualityTier,
    });
  }

  setDetailedLandmarksEnabled(enabled: boolean) {
    this.detailedLandmarksEnabled = enabled;

    if (this.fallback) {
      this.fallback.setDetailedLandmarksEnabled(enabled);
      return;
    }

    this.postToWorker({
      type: "setDetailedLandmarksEnabled",
      enabled,
    });
  }

  start() {
    if (this.fallback) {
      this.fallback.start();
      return;
    }

    if (!this.workerReady || !this.video || this.running) {
      return;
    }

    this.running = true;
    this.paused = false;
    this.frameInFlight = false;
    this.lastTrackedAt = 0;
    this.lastVideoTime = -1;
    this.scheduleNextTick();
  }

  stop() {
    this.running = false;
    this.cancelScheduledTick();
    this.fallback?.stop();
  }

  setPaused(paused: boolean) {
    this.paused = paused;

    if (this.fallback) {
      this.fallback.setPaused(paused);
      return;
    }

    this.postToWorker({
      type: paused ? "pause" : "resume",
    });

    if (paused) {
      this.cancelScheduledTick();
      return;
    }

    if (this.running && !this.rafId && !this.videoFrameId) {
      this.scheduleNextTick();
    }
  }

  reset() {
    if (this.fallback) {
      this.fallback.reset();
      return;
    }

    this.postToWorker({
      type: "reset",
      now: performance.now(),
    });
  }

  destroy() {
    this.stop();
    this.fallback?.destroy();
    this.fallback = null;
    this.disposeWorker();
    this.callbacks.onInteraction(createEmptyInteractionState(performance.now()));
  }

  private getTrackIntervalMs(qualityTier: QualityTier) {
    return 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
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
    if (!this.running || this.paused || this.fallback) {
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
    void this.tick(now);
  };

  private readonly tick = async (now: number) => {
    if (!this.running || this.paused || this.fallback) {
      this.cancelScheduledTick();
      return;
    }

    const video = this.video;
    if (!this.workerReady || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.scheduleNextTick();
      return;
    }

    const usingVideoFrames = typeof video.requestVideoFrameCallback === "function";
    if ((!usingVideoFrames && video.currentTime === this.lastVideoTime) || now - this.lastTrackedAt < this.trackIntervalMs) {
      this.scheduleNextTick();
      return;
    }

    if (this.frameInFlight) {
      this.scheduleNextTick();
      return;
    }

    this.frameInFlight = true;
    this.lastTrackedAt = now;
    this.lastVideoTime = video.currentTime;

    try {
      const bitmap = await createImageBitmap(video);
      const frameId = ++this.nextFrameId;
      this.postToWorker(
        {
          type: "frame",
          frameId,
          timestamp: now,
          bitmap,
        },
        [bitmap],
      );
    } catch (error) {
      this.frameInFlight = false;
      console.warn("Failed to create ImageBitmap for worker tracking.", error);
      void this.activateFallback("ImageBitmap capture failed.");
      return;
    }

    this.scheduleNextTick();
  };

  private readonly handleWorkerMessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;

    if (message.type === "trackingResult") {
      this.frameInFlight = false;
      this.callbacks.onTrackingMetrics(message.trackingMs);
      this.callbacks.onInteraction(message.interaction);
      return;
    }

    if (message.type === "reset") {
      this.callbacks.onInteraction(message.interaction);
      return;
    }

    if (message.type === "error") {
      this.frameInFlight = false;
      void this.activateFallback(`Worker tracker ${message.phase} error: ${message.message}`);
    }
  };

  private postToWorker(message: WorkerRequest, transfer: Transferable[] = []) {
    if (!this.worker) {
      return;
    }

    this.worker.postMessage(message, transfer);
  }

  private reportBackend(backend: TrackingBackend) {
    if (this.reportedBackend === backend) {
      return;
    }

    this.reportedBackend = backend;
    this.callbacks.onTrackingBackend(backend);
  }

  private disposeWorker() {
    if (!this.worker) {
      this.workerReady = false;
      this.frameInFlight = false;
      return;
    }

    try {
      this.worker.postMessage({ type: "dispose" } satisfies WorkerRequest);
    } catch {
      // noop
    }
    this.worker.terminate();
    this.worker = null;
    this.workerReady = false;
    this.frameInFlight = false;
  }

  private async activateFallback(reason: string) {
    if (this.fallback) {
      return;
    }

    if (this.fallbackInitPromise) {
      await this.fallbackInitPromise;
      return;
    }

    console.warn(reason);
    this.disposeWorker();
    const MainThreadTracker = await loadMainThreadTracker();
    const fallback = new MainThreadTracker({
      qualityTier: this.qualityTier,
      reducedMotion: this.reducedMotion,
      callbacks: this.callbacks,
    });

    this.fallbackInitPromise = (async () => {
      try {
        await fallback.init();
        fallback.setQualityTier(this.qualityTier);
        fallback.setDetailedLandmarksEnabled(this.detailedLandmarksEnabled);
        fallback.setViewportMapping(this.viewportMapping);
        if (this.video) {
          fallback.attachVideo(this.video);
        }
        this.fallback = fallback;
        this.reportBackend("legacy");
        if (this.running) {
          fallback.start();
        }
        fallback.setPaused(this.paused);
      } finally {
        this.fallbackInitPromise = null;
      }
    })();

    await this.fallbackInitPromise;
  }
}
