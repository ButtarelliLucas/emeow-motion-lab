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
    <section className="absolute inset-0 flex items-end justify-center px-4 pb-5 pt-16 sm:px-6 sm:pb-6">
      <div className="glass-panel relative w-full max-w-xl rounded-[2rem] px-5 py-6 sm:px-8 sm:py-8">
        <div className="mb-6 flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-[1.6rem] border border-white/12 bg-white/4 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
            <img alt="Monograma e-Meow" className="h-10 w-10 object-contain" src={assetUrl("brand/emeow-m-mark.svg")} />
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.32em] text-foreground-muted">
              Experiencia interactiva
            </p>
            <img alt="e-Meow" className="h-5 w-auto opacity-90" src={assetUrl("brand/emeow-logo-white.png")} />
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-[-0.05em] text-foreground sm:text-4xl">
              {EXPERIENCE_COPY.label}
            </h1>
            <p className="mt-3 max-w-lg text-balance text-sm leading-6 text-foreground-muted sm:text-base">
              {EXPERIENCE_COPY.headline}
            </p>
          </div>

          <p className="text-sm leading-6 text-foreground-muted">{EXPERIENCE_COPY.subcopy}</p>

          <div className="rounded-[1.4rem] border border-white/10 bg-white/5 px-4 py-4">
            <p className="text-sm leading-6 text-foreground">{EXPERIENCE_COPY.permission}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1 text-xs text-foreground-muted">
              <p>Mobile first, portrait first y compatible con desktop.</p>
              <p>Sin landmarks clasicos: solo halos, estelas y campo de particulas.</p>
            </div>

            <button
              className="focus-ring inline-flex min-h-12 items-center justify-center rounded-full border border-white/15 bg-[linear-gradient(135deg,rgba(128,235,255,0.88),rgba(255,233,175,0.88))] px-6 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-105 disabled:cursor-progress disabled:opacity-72"
              disabled={busy}
              onClick={() => {
                void onStart();
              }}
              type="button"
            >
              {busy ? "Iniciando..." : "Activar camara"}
            </button>
          </div>

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
