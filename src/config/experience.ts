import type { ExperienceConfig, ExperienceMetrics, QualityProfile, QualityTier } from "@/types/experience";

export const EXPERIENCE_COPY = {
  label: "Motion Lab",
  headline: "Activa la camara para entrar en una escena cosmica eterea: tus manos deforman, atraen y expanden el flujo visual.",
  permission: "Para disfrutar la experiencia hace falta permitir el uso de la camara.",
  liveHint: "Usa tus manos dentro de la camara para deformar el flujo.",
  wireframeHint: "Toca o haz click en cualquier parte para entrar o salir del modo sin camara.",
  landscapeHint: "Se disfruta mejor en vertical, pero sigue funcionando en desktop y landscape.",
  help: [
    "Cerrar la mano atrae particulas con un radio grande hacia la palma.",
    "Abrir la mano dispersa el flujo, y cuanto mas se abre mas fuerte empuja.",
    "Con dos manos la distancia entre palmas concentra o suelta el campo central.",
    "Girar una mano cambia la paleta; con dos manos el color sale del desnivel entre ambas.",
  ],
} as const;

export const DEFAULT_METRICS: ExperienceMetrics = {
  frameMs: 16.7,
  fps: 60,
  trackingMs: 0,
};

export const EXPERIENCE_CONFIG: ExperienceConfig = {
  cameraConstraints: {
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  },
  handGraceMs: 220,
  closedFistOnThreshold: 0.72,
  closedFistOffThreshold: 0.56,
  openAmountThreshold: 0.76,
  sweepSpeedThreshold: 1.25,
  dualCloseDistance: 0.22,
  dualFarDistance: 0.86,
  trackingTargetFps: {
    low: 24,
    medium: 28,
    high: 32,
  },
  defaultMetrics: DEFAULT_METRICS,
};

const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    dprCap: 1.25,
    particleCount: 900,
    tipScale: 0.07,
    palmScale: 0.19,
    trailLength: 12,
    attractForce: 0.7,
    repelForce: 0.52,
    sweepForce: 0.34,
  },
  medium: {
    dprCap: 1.6,
    particleCount: 1450,
    tipScale: 0.08,
    palmScale: 0.22,
    trailLength: 16,
    attractForce: 0.86,
    repelForce: 0.62,
    sweepForce: 0.42,
  },
  high: {
    dprCap: 2,
    particleCount: 2100,
    tipScale: 0.095,
    palmScale: 0.25,
    trailLength: 20,
    attractForce: 1,
    repelForce: 0.74,
    sweepForce: 0.5,
  },
};

export function getQualityProfile(tier: QualityTier, reducedMotion: boolean): QualityProfile {
  const profile = QUALITY_PROFILES[tier];

  if (!reducedMotion) {
    return profile;
  }

  return {
    ...profile,
    particleCount: Math.round(profile.particleCount * 0.7),
    trailLength: Math.max(10, Math.round(profile.trailLength * 0.75)),
    attractForce: profile.attractForce * 0.82,
    repelForce: profile.repelForce * 0.82,
    sweepForce: profile.sweepForce * 0.7,
  };
}
