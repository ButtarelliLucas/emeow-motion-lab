import { useEffect, useRef, useState } from "react";
import { DEFAULT_METRICS, EXPERIENCE_CONFIG } from "@/config/experience";
import { detectInitialQualityTier } from "@/lib/quality";
import { ParticleFieldRenderer } from "@/lib/particles/renderer";
import type { HandTrackerController } from "@/lib/hand-tracking/tracker";
import type { ExperiencePhase, GestureState, OverlayStatus, QualityTier } from "@/types/experience";

const LIVE_PHASES: ExperiencePhase[] = ["calibrating", "live", "handMissing"];

function isPermissionError(error: unknown) {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function waitForVideoReady(video: HTMLVideoElement, timeoutMs: number) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };

    const onReady = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error("No pudimos leer el stream de la camara."));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("La camara tardo demasiado en responder."));
    }, timeoutMs);

    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
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
    if (phase === "requestingCamera" || phase === "calibrating") {
      return;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setPhase("unsupported");
      setOverlayStatus((current) => ({
        ...current,
        errorMessage: "La camara web necesita HTTPS y un navegador moderno con getUserMedia habilitado.",
      }));
      return;
    }

    setHelpOpen(false);
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
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia(EXPERIENCE_CONFIG.cameraConstraints),
        12000,
        "La camara no respondio a tiempo.",
      );

      streamRef.current = stream;
      const videoElement = videoRef.current;
      if (!videoElement) {
        throw new Error("Video element unavailable");
      }

      videoElement.muted = true;
      videoElement.autoplay = true;
      videoElement.playsInline = true;
      videoElement.setAttribute("muted", "true");
      videoElement.setAttribute("playsinline", "true");
      videoElement.srcObject = stream;

      await waitForVideoReady(videoElement, 6000);
      await withTimeout(
        Promise.resolve(videoElement.play()),
        8000,
        "No pudimos reproducir la camara en este dispositivo.",
      );
      setPhase("calibrating");

      const { HandTrackerController } = await withTimeout(
        import("@/lib/hand-tracking/tracker"),
        10000,
        "No pudimos cargar el motor interactivo.",
      );
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
      await withTimeout(tracker.init(), 12000, "La escena interactiva tardo demasiado en iniciar.");
      tracker.attachVideo(videoElement);
      tracker.start();

      window.setTimeout(() => {
        setPhase((current) => (current === "calibrating" ? "handMissing" : current));
      }, 1000);
    } catch (error) {
      console.error("Motion Lab startup failed", error);
      cleanupCamera();
      setPhase(isPermissionError(error) ? "denied" : "unsupported");
      setOverlayStatus((current) => ({
        ...current,
        errorMessage: isPermissionError(error)
          ? "La camara fue bloqueada. Activa el permiso del navegador para entrar al modo interactivo."
          : "No pudimos iniciar la camara o el tracking en este dispositivo. Puedes reintentar o seguir en modo visual.",
      }));
    }
  };

  const retryExperience = async () => {
    await startExperience();
  };

  const enterFallback = () => {
    cleanupCamera();
    setHelpOpen(false);
    setPhase("fallback");
  };

  const resetTracking = () => {
    setHelpOpen(false);
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
