export type ExperiencePhase =
  | "intro"
  | "requestingCamera"
  | "calibrating"
  | "live"
  | "handMissing"
  | "denied"
  | "unsupported"
  | "fallback";

export type GestureState = "idle" | "closedFist" | "openPalm" | "sweep" | "dualField";

export type QualityTier = "low" | "medium" | "high";

export type TrackingBackend = "parallel" | "legacy";

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
  closedFistOnThreshold: number;
  closedFistOffThreshold: number;
  openAmountThreshold: number;
  sweepSpeedThreshold: number;
  dualCloseDistance: number;
  dualFarDistance: number;
  trackingTargetFps: Record<QualityTier, number>;
  defaultMetrics: ExperienceMetrics;
}

export interface ViewportMapping {
  viewportWidth: number;
  viewportHeight: number;
  videoWidth: number;
  videoHeight: number;
  contentWidth: number;
  contentHeight: number;
  offsetX: number;
  offsetY: number;
  sceneHalfWidth: number;
}

export interface HandVisualState {
  id: string;
  palm: Vec2;
  landmarks: Vec2[];
  fingertips: Vec2[];
  pinchPoint: Vec2;
  radius: number;
  pinchStrength: number;
  openness: number;
  closure: number;
  openAmount: number;
  rollAngle: number;
  sideTilt: number;
  paletteBias: number;
  ellipseAngle: number;
  ellipseRadiusX: number;
  ellipseRadiusY: number;
  projectedScale: number;
  attractionAmount: number;
  repulsionAmount: number;
  openImpulseAmount: number;
  closingImpulseAmount: number;
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
  paletteBias: number;
  dualDistance: number;
  dualCloseness: number;
  dualDepthDelta: number;
  dualDepthAmount: number;
  lastUpdated: number;
}

export interface OverlayStatus {
  phase: ExperiencePhase;
  handsDetected: boolean;
  handsCount: number;
  primaryGesture: GestureState;
  qualityTier: QualityTier;
  trackingBackend: TrackingBackend | null;
  trackingBackendReason: string | null;
  metrics: ExperienceMetrics;
  errorMessage: string | null;
}
