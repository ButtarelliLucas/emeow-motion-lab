import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { DEFAULT_METRICS, EXPERIENCE_CONFIG } from "@/config/experience";
import {
  LIVE_CHROME_FULLSCREEN_DELAY_MS,
  LIVE_CHROME_HAND_LATCH_MS,
  LIVE_CHROME_INACTIVITY_MS,
  LIVE_CHROME_LOGO_DELAY_MS,
  getLiveChromeFlags,
  isLiveChromePhase,
  isMeaningfulPointerMove,
} from "@/lib/live-chrome";
import { detectInitialQualityTier } from "@/lib/quality";
import type { HandTrackerController } from "@/lib/hand-tracking/tracker-facade";
import { ParticleFieldRenderer } from "@/lib/particles/renderer";
import { createViewportMapping } from "@/lib/viewport-mapping";
import type {
  ExperiencePhase,
  GestureState,
  HandVisualState,
  InteractionState,
  OverlayStatus,
  QualityTier,
  TrackingBackend,
  Vec2,
  ViewportMapping,
} from "@/types/experience";

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
      reject(new Error("No pudimos leer el stream de la c\u00e1mara."));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("La c\u00e1mara tard\u00f3 demasiado en responder."));
    }, timeoutMs);

    video.addEventListener("loadedmetadata", onReady, { once: true });
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function getViewportMapping(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
): ViewportMapping | null {
  if (!canvas) {
    return null;
  }

  const viewportWidth = canvas.clientWidth || window.innerWidth || 1;
  const viewportHeight = canvas.clientHeight || window.innerHeight || 1;

  return createViewportMapping({
    viewportWidth,
    viewportHeight,
    videoWidth: video?.videoWidth || viewportWidth,
    videoHeight: video?.videoHeight || viewportHeight,
  });
}

function syncViewportMapping(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  renderer: ParticleFieldRenderer | null,
  tracker: HandTrackerController | null,
) {
  const mapping = getViewportMapping(video, canvas);
  if (!mapping) {
    return;
  }

  renderer?.setViewportMapping(mapping);
  tracker?.setViewportMapping(mapping);
}

function isChromeControlTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("[data-live-chrome-control='true']"));
}

function createEmptyInteraction(): InteractionState {
  return {
    hands: [],
    handsDetected: false,
    primaryGesture: "idle",
    dualActive: false,
    paletteBias: 0,
    dualDistance: 0,
    dualCloseness: 0,
    dualDepthDelta: 0,
    dualDepthAmount: 0,
    lastUpdated: performance.now(),
  };
}

function createDebugTrail(palm: Vec2, radius: number) {
  return Array.from({ length: 24 }, (_, index) => {
    const progress = index / 23;
    return {
      x: palm.x - radius * (0.78 - progress * 0.78),
      y: palm.y - radius * 0.12 + radius * progress * 0.08,
    };
  });
}

function createDebugLandmarks(palm: Vec2, radius: number) {
  const points: Vec2[] = [
    { x: palm.x, y: palm.y - radius * 0.15 },
    { x: palm.x - radius * 0.16, y: palm.y - radius * 0.02 },
    { x: palm.x - radius * 0.24, y: palm.y + radius * 0.14 },
    { x: palm.x - radius * 0.28, y: palm.y + radius * 0.28 },
    { x: palm.x - radius * 0.31, y: palm.y + radius * 0.43 },
    { x: palm.x - radius * 0.09, y: palm.y + radius * 0.06 },
    { x: palm.x - radius * 0.1, y: palm.y + radius * 0.26 },
    { x: palm.x - radius * 0.1, y: palm.y + radius * 0.46 },
    { x: palm.x - radius * 0.1, y: palm.y + radius * 0.67 },
    { x: palm.x, y: palm.y + radius * 0.09 },
    { x: palm.x, y: palm.y + radius * 0.32 },
    { x: palm.x, y: palm.y + radius * 0.57 },
    { x: palm.x, y: palm.y + radius * 0.83 },
    { x: palm.x + radius * 0.1, y: palm.y + radius * 0.07 },
    { x: palm.x + radius * 0.12, y: palm.y + radius * 0.29 },
    { x: palm.x + radius * 0.14, y: palm.y + radius * 0.49 },
    { x: palm.x + radius * 0.16, y: palm.y + radius * 0.68 },
    { x: palm.x + radius * 0.2, y: palm.y + radius * 0.02 },
    { x: palm.x + radius * 0.26, y: palm.y + radius * 0.17 },
    { x: palm.x + radius * 0.3, y: palm.y + radius * 0.3 },
    { x: palm.x + radius * 0.34, y: palm.y + radius * 0.43 },
  ];

  return points;
}

function createDebugHand(mapping: ViewportMapping | null): HandVisualState {
  const sceneHalfWidth = mapping?.sceneHalfWidth ?? 1;
  const viewportWidth = mapping?.viewportWidth ?? (window.innerWidth || 1);
  const viewportHeight = mapping?.viewportHeight ?? (window.innerHeight || 1);
  const sceneHalfHeight = sceneHalfWidth * (viewportHeight / Math.max(viewportWidth, 1));
  const palm = { x: 0, y: 0 };
  const radius = Math.max(Math.min(sceneHalfWidth * 0.22, sceneHalfHeight * 0.32), 0.14);
  const fingertips = [
    { x: palm.x - radius * 0.31, y: palm.y + radius * 0.43 },
    { x: palm.x - radius * 0.1, y: palm.y + radius * 0.67 },
    { x: palm.x, y: palm.y + radius * 0.83 },
    { x: palm.x + radius * 0.16, y: palm.y + radius * 0.68 },
    { x: palm.x + radius * 0.34, y: palm.y + radius * 0.43 },
  ];

  return {
    id: "debug-hand",
    palm,
    landmarks: createDebugLandmarks(palm, radius),
    fingertips,
    pinchPoint: { x: palm.x, y: palm.y + radius * 0.34 },
    radius,
    pinchStrength: 0.08,
    openness: 0.9,
    closure: 0.14,
    openAmount: 0.88,
    rollAngle: 0,
    sideTilt: 0,
    paletteBias: 0.08,
    ellipseAngle: 0.04,
    ellipseRadiusX: radius * 1.16,
    ellipseRadiusY: radius * 1.48,
    projectedScale: 1,
    attractionAmount: 0.06,
    repulsionAmount: 0.04,
    openImpulseAmount: 0.04,
    closingImpulseAmount: 0,
    speed: 0.2,
    gesture: "openPalm",
    trail: createDebugTrail(palm, radius),
    velocity: { x: 0, y: 0 },
    confidence: 1,
    presence: 1,
  };
}

function createDebugInteraction(mapping: ViewportMapping | null): InteractionState {
  const hand = createDebugHand(mapping);
  return {
    hands: [hand],
    handsDetected: true,
    primaryGesture: "openPalm",
    dualActive: false,
    paletteBias: hand.paletteBias,
    dualDistance: 0,
    dualCloseness: 0,
    dualDepthDelta: 0,
    dualDepthAmount: 0,
    lastUpdated: performance.now(),
  };
}

export function useExperienceController() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<ParticleFieldRenderer | null>(null);
  const trackerRef = useRef<HandTrackerController | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const metricsRef = useRef(DEFAULT_METRICS);
  const handLatchTimeoutRef = useRef(0);
  const activityTimeoutRef = useRef(0);
  const centerLogoTimeoutRef = useRef(0);
  const fullscreenTimeoutRef = useRef(0);
  const calibratingTimeoutRef = useRef(0);
  const screenToggleHintShowTimeoutRef = useRef(0);
  const screenToggleHintTimeoutRef = useRef(0);
  const lastInteractionRef = useRef<InteractionState>(createEmptyInteraction());
  const screenToggleHintShownRef = useRef(false);
  const lastHandDetectedAtRef = useRef<number | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const debugHandPresentRef = useRef(false);
  const phaseRef = useRef<ExperiencePhase>("intro");
  const handPresenceLatchedRef = useRef(false);
  const reducedMotion =
    typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  const fullscreenSupported = typeof document !== "undefined" ? document.fullscreenEnabled : false;
  const [phase, setPhase] = useState<ExperiencePhase>("intro");
  const [helpOpen, setHelpOpen] = useState(false);
  const [handPresenceLatched, setHandPresenceLatched] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [centerStageReady, setCenterStageReady] = useState(false);
  const [fullscreenReady, setFullscreenReady] = useState(false);
  const [screenToggleHintVisible, setScreenToggleHintVisible] = useState(false);
  const [wireframeMode, setWireframeMode] = useState(false);
  const [debugHandPresent, setDebugHandPresent] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() =>
    typeof document !== "undefined" ? Boolean(document.fullscreenElement) : false,
  );
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
    trackingBackend: null,
    trackingBackendReason: null,
    metrics: DEFAULT_METRICS,
    errorMessage: null,
  });

  const clearTimeoutRef = useCallback((timeoutRef: MutableRefObject<number>) => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = 0;
    }
  }, []);

  const hideCenterStage = useCallback(() => {
    clearTimeoutRef(centerLogoTimeoutRef);
    clearTimeoutRef(fullscreenTimeoutRef);
    setCenterStageReady(false);
    setFullscreenReady(false);
  }, [clearTimeoutRef]);

  const showScreenToggleHint = useCallback(() => {
    if (screenToggleHintShownRef.current) {
      return;
    }

    screenToggleHintShownRef.current = true;
    clearTimeoutRef(screenToggleHintShowTimeoutRef);
    clearTimeoutRef(screenToggleHintTimeoutRef);
    screenToggleHintShowTimeoutRef.current = window.setTimeout(() => {
      setScreenToggleHintVisible(true);
      screenToggleHintTimeoutRef.current = window.setTimeout(() => {
        setScreenToggleHintVisible(false);
      }, 4800);
    }, 320);
  }, [clearTimeoutRef]);

  const stageCenterVisuals = useCallback(() => {
    hideCenterStage();
    centerLogoTimeoutRef.current = window.setTimeout(() => {
      setCenterStageReady(true);
    }, LIVE_CHROME_LOGO_DELAY_MS);

    if (fullscreenSupported) {
      fullscreenTimeoutRef.current = window.setTimeout(() => {
        setFullscreenReady(true);
      }, LIVE_CHROME_FULLSCREEN_DELAY_MS);
    }
  }, [fullscreenSupported, hideCenterStage]);

  const hideChrome = useCallback(() => {
    if (!isLiveChromePhase(phaseRef.current) || !handPresenceLatchedRef.current) {
      return;
    }

    setHelpOpen(false);
    setChromeVisible(false);
    stageCenterVisuals();
    clearTimeoutRef(activityTimeoutRef);
  }, [clearTimeoutRef, stageCenterVisuals]);

  const showChrome = useCallback(() => {
    setChromeVisible(true);
    hideCenterStage();
  }, [hideCenterStage]);

  const scheduleChromeAutoHide = useCallback(() => {
    clearTimeoutRef(activityTimeoutRef);

    if (!isLiveChromePhase(phaseRef.current) || !handPresenceLatchedRef.current) {
      return;
    }

    activityTimeoutRef.current = window.setTimeout(() => {
      if (isLiveChromePhase(phaseRef.current) && handPresenceLatchedRef.current) {
        hideChrome();
      }
    }, LIVE_CHROME_INACTIVITY_MS);
  }, [clearTimeoutRef, hideChrome]);

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

  const setTrackingBackend = (trackingBackend: TrackingBackend, trackingBackendReason: string | null = null) => {
    setOverlayStatus((current) =>
      current.trackingBackend === trackingBackend && current.trackingBackendReason === trackingBackendReason
        ? current
        : {
            ...current,
            trackingBackend,
            trackingBackendReason,
          },
    );
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
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const sync = () => {
      syncViewportMapping(videoRef.current, canvasRef.current, rendererRef.current, trackerRef.current);
    };

    sync();

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    observer?.observe(canvas);
    window.addEventListener("resize", sync);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.updateQualityTier(qualityTier);
    trackerRef.current?.setQualityTier(qualityTier);
    setOverlayStatus((current) => ({
      ...current,
      qualityTier,
    }));
  }, [qualityTier]);

  useEffect(() => {
    rendererRef.current?.setWireframeMode(wireframeMode);
  }, [wireframeMode]);

  useEffect(() => {
    if (!isLiveChromePhase(phaseRef.current)) {
      return;
    }

    if (debugHandPresent) {
      const interaction = createDebugInteraction(getViewportMapping(videoRef.current, canvasRef.current));
      rendererRef.current?.setInteraction(interaction);
      setInteractionState(interaction.hands.length, true, interaction.primaryGesture);
      return;
    }

    const interaction = lastInteractionRef.current;
    rendererRef.current?.setInteraction(interaction);
    setInteractionState(interaction.hands.length, interaction.handsDetected, interaction.primaryGesture);
  }, [debugHandPresent]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    handPresenceLatchedRef.current = handPresenceLatched;
  }, [handPresenceLatched]);

  useEffect(() => {
    debugHandPresentRef.current = debugHandPresent;
  }, [debugHandPresent]);

  useEffect(() => {
    if (!fullscreenSupported) {
      return undefined;
    }

    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [fullscreenSupported]);

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

  useEffect(() => {
    if (isLiveChromePhase(phase)) {
      return;
    }

    clearTimeoutRef(handLatchTimeoutRef);
    clearTimeoutRef(activityTimeoutRef);
    clearTimeoutRef(screenToggleHintShowTimeoutRef);
    clearTimeoutRef(screenToggleHintTimeoutRef);
    lastHandDetectedAtRef.current = null;
    lastPointerRef.current = null;
    if (handPresenceLatchedRef.current) {
      handPresenceLatchedRef.current = false;
      setHandPresenceLatched(false);
    }
    setScreenToggleHintVisible(false);
    showChrome();
    if (wireframeMode) {
      setWireframeMode(false);
    }
  }, [clearTimeoutRef, phase, showChrome, wireframeMode]);

  useEffect(() => {
    if (!isLiveChromePhase(phase)) {
      return;
    }

    const effectiveHandsDetected = overlayStatus.handsDetected || debugHandPresent;

    if (effectiveHandsDetected) {
      lastHandDetectedAtRef.current = performance.now();
      clearTimeoutRef(handLatchTimeoutRef);

      if (!handPresenceLatchedRef.current) {
        handPresenceLatchedRef.current = true;
        setHandPresenceLatched(true);
        hideChrome();
        showScreenToggleHint();
      }

      return;
    }

    clearTimeoutRef(handLatchTimeoutRef);
    if (!handPresenceLatchedRef.current) {
      return;
    }

    handLatchTimeoutRef.current = window.setTimeout(() => {
      if (!(overlayStatus.handsDetected || debugHandPresent)) {
        handPresenceLatchedRef.current = false;
        setHandPresenceLatched(false);
        showChrome();
      }
    }, LIVE_CHROME_HAND_LATCH_MS);

    return () => {
      clearTimeoutRef(handLatchTimeoutRef);
    };
  }, [clearTimeoutRef, debugHandPresent, hideChrome, overlayStatus.handsDetected, phase, showChrome, showScreenToggleHint]);

  useEffect(() => {
    if (!isLiveChromePhase(phase) || !handPresenceLatched) {
      lastPointerRef.current = null;
      clearTimeoutRef(activityTimeoutRef);
      return;
    }

    const revealChrome = () => {
      showChrome();
      scheduleChromeAutoHide();
    };

    const onPointerMove = (event: PointerEvent) => {
      const nextPoint = { x: event.clientX, y: event.clientY };
      const meaningful = isMeaningfulPointerMove(lastPointerRef.current, nextPoint);
      lastPointerRef.current = nextPoint;

      if (meaningful) {
        revealChrome();
      }
    };

    const onTouchActivity = (event: TouchEvent) => {
      if (isChromeControlTarget(event.target)) {
        return;
      }

      lastPointerRef.current = null;
      revealChrome();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("touchstart", onTouchActivity, { passive: true });
    window.addEventListener("touchmove", onTouchActivity, { passive: true });

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("touchstart", onTouchActivity);
      window.removeEventListener("touchmove", onTouchActivity);
    };
  }, [clearTimeoutRef, handPresenceLatched, phase, scheduleChromeAutoHide, showChrome]);

  useEffect(
    () => () => {
      clearTimeoutRef(handLatchTimeoutRef);
        clearTimeoutRef(activityTimeoutRef);
        clearTimeoutRef(centerLogoTimeoutRef);
        clearTimeoutRef(fullscreenTimeoutRef);
        clearTimeoutRef(calibratingTimeoutRef);
        clearTimeoutRef(screenToggleHintShowTimeoutRef);
        clearTimeoutRef(screenToggleHintTimeoutRef);
        trackerRef.current?.destroy();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [clearTimeoutRef],
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

    clearTimeoutRef(handLatchTimeoutRef);
    clearTimeoutRef(activityTimeoutRef);
    clearTimeoutRef(centerLogoTimeoutRef);
    clearTimeoutRef(fullscreenTimeoutRef);
    clearTimeoutRef(calibratingTimeoutRef);
    clearTimeoutRef(screenToggleHintShowTimeoutRef);
    clearTimeoutRef(screenToggleHintTimeoutRef);
    lastHandDetectedAtRef.current = null;
    lastPointerRef.current = null;
    handPresenceLatchedRef.current = false;
    setHandPresenceLatched(false);
    setScreenToggleHintVisible(false);
    showChrome();
    setWireframeMode(false);
    rendererRef.current?.setWireframeMode(false);

    const emptyInteraction = createEmptyInteraction();
    lastInteractionRef.current = emptyInteraction;
    rendererRef.current?.setInteraction(emptyInteraction);
  };

  const startExperience = async () => {
    if (phase === "requestingCamera" || phase === "calibrating") {
      return;
    }

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setPhase("unsupported");
      setOverlayStatus((current) => ({
        ...current,
        errorMessage: "La c\u00e1mara web necesita HTTPS y un navegador moderno con getUserMedia habilitado.",
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
      trackingBackend: null,
      trackingBackendReason: null,
    }));

    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia(EXPERIENCE_CONFIG.cameraConstraints),
        12000,
        "La c\u00e1mara no respondi\u00f3 a tiempo.",
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
      syncViewportMapping(videoElement, canvasRef.current, rendererRef.current, trackerRef.current);
      await withTimeout(
        Promise.resolve(videoElement.play()),
        8000,
        "No pudimos reproducir la c\u00e1mara en este dispositivo.",
      );
      setPhase("calibrating");

      const { HandTrackerController } = await withTimeout(
        import("@/lib/hand-tracking/tracker-facade"),
        10000,
        "No pudimos cargar el motor interactivo.",
      );
      const tracker = new HandTrackerController({
        qualityTier,
        reducedMotion,
        callbacks: {
          onInteraction: (interaction) => {
            lastInteractionRef.current = interaction;
            const resolvedInteraction = debugHandPresentRef.current
              ? createDebugInteraction(getViewportMapping(videoElement, canvasRef.current))
              : interaction;
            rendererRef.current?.setInteraction(resolvedInteraction);
            setInteractionState(
              resolvedInteraction.hands.length,
              resolvedInteraction.handsDetected,
              resolvedInteraction.primaryGesture,
            );
          },
          onTrackingMetrics: (trackingMs) => {
            setMetrics(undefined, trackingMs);
          },
          onTrackingBackend: (trackingBackend, trackingBackendReason) => {
            setTrackingBackend(trackingBackend, trackingBackendReason ?? null);
          },
        },
      });

      trackerRef.current = tracker;
      syncViewportMapping(videoElement, canvasRef.current, rendererRef.current, tracker);
      await withTimeout(tracker.init(), 12000, "La escena interactiva tardo demasiado en iniciar.");
      tracker.attachVideo(videoElement);
      tracker.start();

      clearTimeoutRef(calibratingTimeoutRef);
      calibratingTimeoutRef.current = window.setTimeout(() => {
        setPhase((current) => (current === "calibrating" ? "handMissing" : current));
        calibratingTimeoutRef.current = 0;
      }, 1000);
    } catch (error) {
      console.error("Motion startup failed", error);
      cleanupCamera();
      setPhase(isPermissionError(error) ? "denied" : "unsupported");
      setOverlayStatus((current) => ({
        ...current,
        errorMessage: isPermissionError(error)
          ? "La c\u00e1mara fue bloqueada. Activ\u00e1 el permiso del navegador para entrar al modo interactivo."
          : "No pudimos iniciar la c\u00e1mara o el tracking en este dispositivo. Pod\u00e9s reintentar o seguir en modo visual.",
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

  const toggleWireframeMode = () => {
    if (!isLiveChromePhase(phaseRef.current)) {
      return;
    }

    setWireframeMode((current) => !current);
  };

  const toggleFullscreen = async () => {
    if (!fullscreenSupported) {
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }

    await document.documentElement.requestFullscreen();
  };

  const { siteOnlyMode, centerLogoVisible, fullscreenVisible } = getLiveChromeFlags({
    phase,
    handPresenceLatched,
    chromeVisible,
    centerStageReady,
    fullscreenReady,
    fullscreenSupported,
  });

  return {
    videoRef,
    canvasRef,
    phase,
    helpOpen,
    setHelpOpen,
    overlayStatus,
    chromeVisible,
    siteOnlyMode,
    centerLogoVisible,
    fullscreenVisible,
    screenToggleHintVisible,
    wireframeMode,
    debugHandPresent,
    isFullscreen,
    startExperience,
    retryExperience,
    enterFallback,
    resetTracking,
    setDebugHandPresent,
    toggleWireframeMode,
    toggleFullscreen,
  };
}
