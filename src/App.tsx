import { BrandLockup } from "@/components/BrandLockup";
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
          aria-label={wireframeMode ? "Volver a c\u00e1mara" : "Apagar c\u00e1mara"}
          className="absolute inset-0 z-[12] cursor-pointer bg-transparent"
          data-live-chrome-control="true"
          onClick={toggleWireframeMode}
          type="button"
        />
      ) : null}

      {showHud || showHint ? (
        <div
          className={`absolute inset-0 z-20 transition-opacity duration-300 ${
            chromeVisible ? "pointer-events-none opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          {showHud ? (
            <StatusHud
              helpItems={EXPERIENCE_COPY.help}
              helpOpen={helpOpen}
              overlayStatus={overlayStatus}
              onGoHome={() => window.open("https://motion.e-meow.com.ar", "_self", "noopener")}
              onToggleHelp={() => setHelpOpen((current) => !current)}
            />
          ) : null}

          {showHint ? (
            <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center px-4">
              <div className="panel-toast live-hint-pill rounded-full px-4 py-2 text-center text-sm text-white/82">
                {EXPERIENCE_COPY.liveHint}
              </div>
            </div>
          ) : null}

          <OrientationHint copy={EXPERIENCE_COPY.landscapeHint} />
        </div>
      ) : null}

      {showHud && screenToggleHintVisible ? (
        <div className="pointer-events-none absolute inset-0 z-[22] flex items-center justify-center px-6">
          <div className="panel-toast live-mode-toast flex max-w-lg items-center gap-3 rounded-[1.75rem] px-5 py-3 text-left text-base leading-7 text-white/94 sm:px-6 sm:py-3.5">
            <span
              aria-hidden="true"
              className="toast-icon-badge flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/92"
            >
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" />
                <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M12 9.6v4.8M9.6 12H14.4"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.6"
                />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.24em] text-white/66">tap / click</p>
              <p>{EXPERIENCE_COPY.wireframeHint}</p>
            </div>
          </div>
        </div>
      ) : null}

      {siteOnlyMode ? (
        <div className="absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+18px)]">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.26em] text-foreground/66">
              {EXPERIENCE_COPY.poweredByLabel}
            </span>
            <button
              className="site-only-link pointer-events-auto text-sm font-medium tracking-[0.18em] text-foreground/86 transition hover:text-foreground hover:underline hover:underline-offset-4 focus:outline-none focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4"
              data-live-chrome-control="true"
              onClick={() => window.open("https://e-meow.com.ar", "_self", "noopener")}
              type="button"
            >
              {EXPERIENCE_COPY.parentSite}
            </button>
          </div>
        </div>
      ) : null}

      {showHud ? (
        <div
          className={`pointer-events-none absolute inset-x-0 top-0 z-20 px-4 pt-[calc(env(safe-area-inset-top,0px)+16px)] transition-opacity duration-300 sm:px-6 sm:pt-[calc(env(safe-area-inset-top,0px)+22px)] ${
            centerLogoVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div className="relative flex min-h-20 items-start justify-center">
            <BrandLockup className="pt-2" showSignature={false} useBrandMarkAsInitial variant="minimal" />

            {fullscreenVisible ? (
              <button
                aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
                className="focus-ring icon-control pointer-events-auto absolute right-0 top-1 flex h-11 w-11 items-center justify-center bg-transparent text-foreground/82 transition hover:text-foreground focus-visible:text-foreground"
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
