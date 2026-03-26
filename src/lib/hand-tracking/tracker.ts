import {
  FilesetResolver,
  HandLandmarker,
  type Category,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { EXPERIENCE_CONFIG, getQualityProfile } from "@/config/experience";
import { assetUrl } from "@/lib/assets";
import { clamp, lerp, lerpVec2, length } from "@/lib/math";
import { measureHand } from "@/lib/hand-tracking/gestures";
import type { GestureState, HandVisualState, InteractionState, QualityTier, Vec2 } from "@/types/experience";

interface TrackerCallbacks {
  onInteraction: (interaction: InteractionState) => void;
  onTrackingMetrics: (trackingMs: number) => void;
}

interface TrackerOptions {
  qualityTier: QualityTier;
  reducedMotion: boolean;
  callbacks: TrackerCallbacks;
}

interface InternalHandState extends HandVisualState {
  landmarks: Vec2[];
  lastSeenAt: number;
}

function detectSweepGesture(speed: number, currentGesture: Exclude<GestureState, "dualField">) {
  if (currentGesture !== "idle") {
    return currentGesture;
  }

  return speed >= EXPERIENCE_CONFIG.sweepSpeedThreshold ? "sweep" : "idle";
}

function handednessKey(handedness: Category[][], index: number) {
  const category = handedness[index]?.[0]?.categoryName?.toLowerCase();
  return category ? `hand-${category}` : `hand-${index}`;
}

export class HandTrackerController {
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly callbacks: TrackerCallbacks;
  private running = false;
  private paused = false;
  private rafId = 0;
  private lastTrackedAt = 0;
  private lastVideoTime = -1;
  private readonly hands = new Map<string, InternalHandState>();
  private readonly reducedMotion: boolean;
  private trackIntervalMs: number;
  private trailLength: number;

  constructor({ qualityTier, reducedMotion, callbacks }: TrackerOptions) {
    this.callbacks = callbacks;
    this.reducedMotion = reducedMotion;
    this.trackIntervalMs = 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
    this.trailLength = getQualityProfile(qualityTier, reducedMotion).trailLength;
  }

  async init() {
    const vision = await FilesetResolver.forVisionTasks(assetUrl("mediapipe/wasm"));

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

  setQualityTier(qualityTier: QualityTier) {
    this.trackIntervalMs = 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
    this.trailLength = getQualityProfile(qualityTier, this.reducedMotion).trailLength;
  }

  start() {
    if (!this.landmarker || !this.video || this.running) {
      return;
    }

    this.running = true;
    this.paused = false;
    this.lastTrackedAt = 0;
    this.lastVideoTime = -1;
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;

    if (!paused && this.running && !this.rafId) {
      this.rafId = window.requestAnimationFrame(this.tick);
    }
  }

  reset() {
    this.hands.clear();
    this.callbacks.onInteraction({
      hands: [],
      handsDetected: false,
      primaryGesture: "idle",
      dualActive: false,
      lastUpdated: performance.now(),
    });
  }

  destroy() {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.hands.clear();
  }

  private readonly tick = (now: number) => {
    if (!this.running || this.paused) {
      this.rafId = 0;
      return;
    }

    if (!this.landmarker || !this.video || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.rafId = window.requestAnimationFrame(this.tick);
      return;
    }

    if (this.video.currentTime === this.lastVideoTime || now - this.lastTrackedAt < this.trackIntervalMs) {
      this.rafId = window.requestAnimationFrame(this.tick);
      return;
    }

    this.lastTrackedAt = now;
    this.lastVideoTime = this.video.currentTime;

    const startedAt = performance.now();
    const result = this.landmarker.detectForVideo(this.video, now);
    const trackingMs = performance.now() - startedAt;

    this.callbacks.onTrackingMetrics(trackingMs);
    this.processResult(result, now);

    this.rafId = window.requestAnimationFrame(this.tick);
  };

  private processResult(result: HandLandmarkerResult, now: number) {
    const nextKeys = new Set<string>();

    result.landmarks.forEach((landmarks, index) => {
      const key = handednessKey(result.handedness, index);
      nextKeys.add(key);

      const confidence = result.handedness[index]?.[0]?.score ?? 0.8;
      const previous = this.hands.get(key);
      const measured = measureHand(
        landmarks as NormalizedLandmark[],
        previous?.gesture === "pinch",
        {
          pinchOnThreshold: EXPERIENCE_CONFIG.pinchOnThreshold,
          pinchOffThreshold: EXPERIENCE_CONFIG.pinchOffThreshold,
          openPalmThreshold: EXPERIENCE_CONFIG.openPalmThreshold,
        },
        confidence,
      );

      const palm = previous ? lerpVec2(previous.palm, measured.palm, 0.45) : measured.palm;
      const fingertips = measured.fingertips.map((tip, fingertipIndex) =>
        previous?.fingertips[fingertipIndex]
          ? lerpVec2(previous.fingertips[fingertipIndex], tip, 0.38)
          : tip,
      );
      const pinchPoint = previous ? lerpVec2(previous.pinchPoint, measured.pinchPoint, 0.4) : measured.pinchPoint;
      const velocity = previous
        ? {
            x: (palm.x - previous.palm.x) / Math.max(0.016, (now - previous.lastSeenAt) / 1000),
            y: (palm.y - previous.palm.y) / Math.max(0.016, (now - previous.lastSeenAt) / 1000),
          }
        : { x: 0, y: 0 };
      const speed = length(velocity);
      const gesture = detectSweepGesture(speed, measured.gesture);
      const trail = [palm, ...(previous?.trail ?? [])].slice(0, this.trailLength);

      this.hands.set(key, {
        id: key,
        confidence: lerp(previous?.confidence ?? confidence, confidence, 0.3),
        palm,
        fingertips,
        pinchPoint,
        radius: lerp(previous?.radius ?? measured.radius, measured.radius, 0.36),
        pinchStrength: lerp(previous?.pinchStrength ?? measured.pinchStrength, measured.pinchStrength, 0.35),
        openness: lerp(previous?.openness ?? measured.openness, measured.openness, 0.35),
        speed,
        gesture,
        trail,
        velocity,
        presence: 1,
        landmarks: landmarks.map((landmark) => ({
          x: 1 - landmark.x,
          y: landmark.y,
        })),
        lastSeenAt: now,
      });
    });

    const activeHands = Array.from(this.hands.entries()).flatMap(([key, hand]) => {
      if (nextKeys.has(key)) {
        return [hand];
      }

      const age = now - hand.lastSeenAt;
      if (age > EXPERIENCE_CONFIG.handGraceMs) {
        this.hands.delete(key);
        return [];
      }

      return [
        {
          ...hand,
          presence: clamp(1 - age / EXPERIENCE_CONFIG.handGraceMs, 0, 1),
        },
      ];
    });

    activeHands.sort((left, right) => left.palm.x - right.palm.x);
    const dualActive = activeHands.length > 1;
    const primaryGesture = dualActive ? "dualField" : activeHands[0]?.gesture ?? "idle";

    this.callbacks.onInteraction({
      hands: activeHands,
      handsDetected: activeHands.length > 0,
      primaryGesture,
      dualActive,
      lastUpdated: now,
    });
  }
}
