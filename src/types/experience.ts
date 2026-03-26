export type ExperiencePhase =
  | "intro"
  | "requestingCamera"
  | "calibrating"
  | "live"
  | "handMissing"
  | "denied"
  | "unsupported"
  | "fallback";

export type GestureState = "idle" | "pinch" | "openPalm" | "sweep" | "dualField";

export type QualityTier = "low" | "medium" | "high";

export interface Vec2 {
  x: number;
  y: number;
}

export interface ExperienceMetrics {
  frameMs: number;
  fps: number;
  trackingMs: number;
}

export interface QualityProfile {
  dprCap: number;
  particleCount: number;
  tipScale: number;
  palmScale: number;
  trailLength: number;
  attractForce: number;
  repelForce: number;
  sweepForce: number;
}

export interface ExperienceConfig {
  cameraConstraints: MediaStreamConstraints;
  handGraceMs: number;
  pinchOnThreshold: number;
  pinchOffThreshold: number;
  openPalmThreshold: number;
  sweepSpeedThreshold: number;
  trackingTargetFps: Record<QualityTier, number>;
  defaultMetrics: ExperienceMetrics;
}

export interface HandVisualState {
  id: string;
  palm: Vec2;
  fingertips: Vec2[];
  pinchPoint: Vec2;
  radius: number;
  pinchStrength: number;
  openness: number;
  speed: number;
  gesture: Exclude<GestureState, "dualField">;
  trail: Vec2[];
  velocity: Vec2;
  confidence: number;
  presence: number;
}

export interface InteractionState {
  hands: HandVisualState[];
  handsDetected: boolean;
  primaryGesture: GestureState;
  dualActive: boolean;
  lastUpdated: number;
}

export interface OverlayStatus {
  phase: ExperiencePhase;
  handsDetected: boolean;
  handsCount: number;
  primaryGesture: GestureState;
  qualityTier: QualityTier;
  metrics: ExperienceMetrics;
  errorMessage: string | null;
}
