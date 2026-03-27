import { EXPERIENCE_COPY } from "@/config/experience";
import { assetUrl } from "@/lib/assets";
import type { ExperiencePhase } from "@/types/experience";

interface IntroGateProps {
  phase: ExperiencePhase;
  onStart: () => Promise<void> | void;
}

function statusCopy(phase: ExperiencePhase) {
  if (phase === "requestingCamera") {
    return "Pidiendo permiso de camara...";
  }

  if (phase === "calibrating") {
    return "Calibrando la escena para entrar al flujo...";
  }

  return null;
}

export function IntroGate({ phase, onStart }: IntroGateProps) {
  const busy = phase === "requestingCamera" || phase === "calibrating";
  const status = statusCopy(phase);

  return (
    <section className="absolute inset-0 flex items-end justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+4rem)] sm:px-6 sm:items-center sm:pb-6 sm:pt-16">
      <div className="glass-panel relative w-full max-w-xl rounded-[2rem] px-5 pb-16 pt-6 sm:px-8 sm:pb-16 sm:pt-8">
        <div className="mb-6 flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center">
            <img alt="Logo e-Meow" className="h-16 w-16 object-contain" src={assetUrl("brand/emeow-logo-white.png")} />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.32em] text-foreground-muted">Interactive</p>
            <p className="text-base font-medium tracking-[0.18em] text-foreground">Motion Lab</p>
          </div>
        </div>

        <div className="space-y-5">
          <p className="text-pretty text-sm leading-6 text-foreground-muted sm:max-w-lg sm:text-base">
            {EXPERIENCE_COPY.headline}
          </p>

          <div className="rounded-[1.4rem] border border-white/10 bg-white/5 px-4 py-4">
            <p className="text-sm leading-6 text-foreground">{EXPERIENCE_COPY.permission}</p>
          </div>

          <button
            className="focus-ring intro-activate-button inline-flex min-h-12 w-full items-center justify-center rounded-full border border-white/14 px-7 py-3 text-sm font-medium tracking-[0.12em] text-white transition hover:brightness-105 disabled:cursor-progress disabled:opacity-72"
            disabled={busy}
            onClick={() => {
              void onStart();
            }}
            type="button"
          >
            {busy ? "Iniciando..." : "Activar Cámara"}
          </button>

          {status ? (
            <div className="rounded-full border border-white/10 bg-black/30 px-4 py-2 text-center text-xs uppercase tracking-[0.28em] text-foreground-muted">
              {status}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
