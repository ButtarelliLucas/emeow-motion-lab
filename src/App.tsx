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
    helpOpen,
    phase,
    startExperience,
    retryExperience,
    enterFallback,
    resetTracking,
    setHelpOpen,
  } = useExperienceController();

  const showIntro = phase === "intro" || phase === "requestingCamera" || phase === "calibrating";
  const showFallback = phase === "denied" || phase === "unsupported" || phase === "fallback";
  const showHud = phase === "live" || phase === "handMissing";
  const showHint = phase === "handMissing";

  return (
    <main className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <ExperienceViewport cameraVisible={!showFallback && !showIntro} canvasRef={canvasRef} videoRef={videoRef} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(198,243,255,0.16),transparent_34%),radial-gradient(circle_at_bottom,rgba(255,241,207,0.14),transparent_30%)]" />

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
          <div className="rounded-full border border-white/15 bg-black/45 px-4 py-2 text-center text-sm text-white/82 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl">
            {EXPERIENCE_COPY.liveHint}
          </div>
        </div>
      ) : null}

      <OrientationHint copy={EXPERIENCE_COPY.landscapeHint} />

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
