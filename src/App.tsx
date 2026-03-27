import { assetUrl } from "@/lib/assets";
import { ExperienceViewport } from "@/components/ExperienceViewport";
import { FallbackExperience } from "@/components/FallbackExperience";
import { IntroGate } from "@/components/IntroGate";
import { OrientationHint } from "@/components/OrientationHint";
import { StatusHud } from "@/components/StatusHud";
import { EXPERIENCE_COPY } from "@/config/experience";
import { useExperienceController } from "@/hooks/useExperienceController";

export default function App() {
  const {
    canvasRef,
    videoRef,
    overlayStatus,
    chromeVisible,
    siteOnlyMode,
    centerLogoVisible,
    fullscreenVisible,
    screenToggleHintVisible,
    wireframeMode,
    isFullscreen,
    helpOpen,
    phase,
    startExperience,
    retryExperience,
    enterFallback,
    resetTracking,
    setHelpOpen,
    toggleWireframeMode,
    toggleFullscreen,
  } = useExperienceController();

  const showIntro = phase === "intro" || phase === "requestingCamera" || phase === "calibrating";
  const showFallback = phase === "denied" || phase === "unsupported" || phase === "fallback";
  const showHud = phase === "live" || phase === "handMissing";
  const showHint = phase === "handMissing";
  const cameraOpacity = showFallback || showIntro || wireframeMode ? 0 : 0.55;

  return (
    <main className="app-viewport relative overflow-hidden bg-background text-foreground">
      <ExperienceViewport cameraOpacity={cameraOpacity} canvasRef={canvasRef} videoRef={videoRef} wireframeMode={wireframeMode} />
      {!wireframeMode ? (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(198,243,255,0.16),transparent_34%),radial-gradient(circle_at_bottom,rgba(248,62,165,0.16),transparent_30%)]" />
      ) : null}

      {showHud ? (
        <button
          aria-label={wireframeMode ? "Volver a camara" : "Apagar camara"}
          className="absolute inset-0 z-[12] cursor-pointer bg-transparent"
          data-live-chrome-control="true"
          onClick={toggleWireframeMode}
          type="button"
        />
      ) : null}

      {showHud || showHint ? (
        <div
          className={`absolute inset-0 z-20 transition-opacity duration-300 ${
            chromeVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          {showHud ? (
            <StatusHud
              helpItems={EXPERIENCE_COPY.help}
              helpOpen={helpOpen}
              overlayStatus={overlayStatus}
              onGoHome={() => window.open("https://e-meow.com.ar", "_self", "noopener")}
              onRecalibrate={resetTracking}
              onToggleHelp={() => setHelpOpen((current) => !current)}
            />
          ) : null}

          {showHint ? (
            <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center px-4">
              <div className="live-hint-pill rounded-full border border-white/15 bg-black/45 px-4 py-2 text-center text-sm text-white/82 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
                {EXPERIENCE_COPY.liveHint}
              </div>
            </div>
          ) : null}

          <OrientationHint copy={EXPERIENCE_COPY.landscapeHint} />
        </div>
      ) : null}

      {showHud && screenToggleHintVisible ? (
        <div className="pointer-events-none absolute inset-0 z-[22] flex items-center justify-center px-6">
          <div className="live-mode-toast max-w-md rounded-full border border-white/12 bg-black/42 px-4 py-2.5 text-center text-sm leading-6 text-white/86 shadow-[0_18px_45px_rgba(0,0,0,0.32)] backdrop-blur-xl sm:px-5">
            {EXPERIENCE_COPY.wireframeHint}
          </div>
        </div>
      ) : null}

      {siteOnlyMode ? (
        <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+18px)]">
          <button
            className="pointer-events-auto bg-transparent text-sm font-medium tracking-[0.18em] text-foreground/86 transition hover:text-foreground hover:underline hover:underline-offset-4 focus:outline-none focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4"
            data-live-chrome-control="true"
            onClick={() => window.open("https://e-meow.com.ar", "_self", "noopener")}
            type="button"
          >
            e-meow.com.ar
          </button>
        </div>
      ) : null}

      {showHud ? (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 px-4 pt-[calc(env(safe-area-inset-top,0px)+16px)] transition-opacity duration-300 sm:px-6 sm:pt-[calc(env(safe-area-inset-top,0px)+22px)] ${
            centerLogoVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="relative flex min-h-20 items-start justify-center">
            <img
              alt="Logo e-Meow"
              className="h-[4.5rem] w-auto object-contain opacity-75 drop-shadow-[0_0_18px_rgba(127,235,255,0.12)] sm:h-20"
              src={assetUrl("brand/emeow-logo-white.png")}
            />

            {fullscreenVisible ? (
              <button
                aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
                className="pointer-events-auto absolute right-0 top-1 flex h-11 w-11 items-center justify-center bg-transparent text-foreground/82 transition hover:text-foreground focus:outline-none focus-visible:text-foreground"
                data-live-chrome-control="true"
                onClick={() => {
                  void toggleFullscreen();
                }}
                type="button"
              >
                <span className={`relative block h-4 w-4 transition-transform ${isFullscreen ? "rotate-45" : ""}`}>
                  <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-current" />
                  <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-current" />
                </span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showIntro ? <IntroGate phase={phase} onStart={startExperience} /> : null}

      {showFallback ? (
        <FallbackExperience
          errorMessage={overlayStatus.errorMessage}
          phase={phase}
          onRetry={retryExperience}
          onVisualMode={enterFallback}
        />
      ) : null}
    </main>
  );
}
