import { useEffect, useRef, useState } from "react";
import { DEFAULT_METRICS } from "@/config/experience";
import { detectInitialQualityTier } from "@/lib/quality";
import { ParticleFieldRenderer } from "@/lib/particles/renderer";
import type { ExperiencePhase, GestureState, OverlayStatus, QualityTier } from "@/types/experience";
import type { HandTrackerController } from "@/lib/hand-tracking/tracker";

const LIVE_PHASES: ExperiencePhase[] = ["calibrating", "live", "handMissing"];

function isPermissionError(error: unknown) {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

export function useExperienceController() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ParticleFieldRenderer | null>(null);
  const trackerRef = useRef<HandTrackerController | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const metricsRef = useRef(DEFAULT_METRICS);
  const reducedMotion =
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  const [phase, setPhase] = useState<ExperiencePhase>("intro");
  const [helpOpen, setHelpOpen] = useState(false);
  const [qualityTier, setQualityTier] = useState<QualityTier>(() =>
    detectInitialQualityTier({
      reducedMotion,
      hardwareConcurrency: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : undefined,
      deviceMemory:
        typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    }),
  );
  const initialTierRef = useRef(qualityTier);
  const [overlayStatus, setOverlayStatus] = useState<OverlayStatus>({
    phase: "intro",
    handsDetected: false,
    handsCount: 0,
    primaryGesture: "idle",
    qualityTier,
    metrics: DEFAULT_METRICS,
    errorMessage: null,
  });

  const setMetrics = (nextFrameMs?: number, nextTrackingMs?: number) => {
    metricsRef.current = {
      frameMs: nextFrameMs ?? metricsRef.current.frameMs,
      fps: Math.round(1000 / (nextFrameMs ?? metricsRef.current.frameMs)),
      trackingMs: nextTrackingMs ?? metricsRef.current.trackingMs,
    };

    setOverlayStatus((current) => ({
      ...current,
      metrics: metricsRef.current,
    }));
  };

  const setInteractionState = (handsCount: number, handsDetected: boolean, primaryGesture: GestureState) => {
    setPhase((current) => {
      if (!LIVE_PHASES.includes(current)) {
        return current;
      }

      return handsDetected ? "live" : "handMissing";
    });

    setOverlayStatus((current) => ({
      ...current,
      handsCount,
      handsDetected,
      primaryGesture,
    }));
  };

  useEffect(() => {
    if (!canvasRef.current) {
      return undefined;
    }

    const renderer = new ParticleFieldRenderer(canvasRef.current, {
      tier: initialTierRef.current,
      reducedMotion,
      onQualityChange: (nextTier) => {
        setQualityTier(nextTier);
      },
      onStats: (frameMs) => {
        setMetrics(frameMs);
      },
    });

    renderer.start();
    rendererRef.current = renderer;

    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [reducedMotion]);

  useEffect(() => {
    rendererRef.current?.updateQualityTier(qualityTier);
    trackerRef.current?.setQualityTier(qualityTier);
    setOverlayStatus((current) => ({
      ...current,
      qualityTier,
    }));
  }, [qualityTier]);

  useEffect(() => {
    const onVisibility = () => {
      const paused = document.hidden;
      rendererRef.current?.setPaused(paused);
      trackerRef.current?.setPaused(paused);
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    setOverlayStatus((current) => ({
      ...current,
      phase,
    }));
  }, [phase]);

  useEffect(
    () => () => {
      trackerRef.current?.destroy();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const cleanupCamera = () => {
    trackerRef.current?.destroy();
    trackerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }

    rendererRef.current?.setInteraction({
      hands: [],
      handsDetected: false,
      primaryGesture: "idle",
      dualActive: false,
      lastUpdated: performance.now(),
    });
  };

  const startExperience = async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setPhase("unsupported");
      setOverlayStatus((current) => ({
        ...current,
        errorMessage: "La camara web necesita HTTPS y un navegador moderno con getUserMedia habilitado.",
      }));
      return;
    }

    cleanupCamera();
    setPhase("requestingCamera");
    setOverlayStatus((current) => ({
      ...current,
      errorMessage: null,
      handsCount: 0,
      handsDetected: false,
      primaryGesture: "idle",
    }));

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;
      if (!videoRef.current) {
        throw new Error("Video element unavailable");
      }

      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setPhase("calibrating");

      const { HandTrackerController } = await import("@/lib/hand-tracking/tracker");
      const tracker = new HandTrackerController({
        qualityTier,
        reducedMotion,
        callbacks: {
          onInteraction: (interaction) => {
            rendererRef.current?.setInteraction(interaction);
            setInteractionState(interaction.hands.length, interaction.handsDetected, interaction.primaryGesture);
          },
          onTrackingMetrics: (trackingMs) => {
            setMetrics(undefined, trackingMs);
          },
        },
      });

      trackerRef.current = tracker;
      await tracker.init();
      tracker.attachVideo(videoRef.current);
      tracker.start();

      window.setTimeout(() => {
        setPhase((current) => (current === "calibrating" ? "handMissing" : current));
      }, 1000);
    } catch (error) {
      cleanupCamera();
      setPhase(isPermissionError(error) ? "denied" : "unsupported");
      setOverlayStatus((current) => ({
        ...current,
        errorMessage: isPermissionError(error)
          ? "La camara fue bloqueada. Activa el permiso del navegador para entrar al modo interactivo."
          : "No pudimos abrir la camara en este equipo. Puedes seguir en modo visual o reintentar.",
      }));
    }
  };

  const retryExperience = async () => {
    await startExperience();
  };

  const enterFallback = () => {
    cleanupCamera();
    setPhase("fallback");
  };

  const resetTracking = () => {
    trackerRef.current?.reset();
    setPhase("calibrating");
  };

  return {
    videoRef,
    canvasRef,
    phase,
    helpOpen,
    setHelpOpen,
    overlayStatus,
    startExperience,
    retryExperience,
    enterFallback,
    resetTracking,
  };
}
