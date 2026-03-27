import { BrandLockup } from "@/components/BrandLockup";
import type { ExperiencePhase } from "@/types/experience";

interface FallbackExperienceProps {
  phase: ExperiencePhase;
  errorMessage: string | null;
  onRetry: () => Promise<void> | void;
  onVisualMode: () => void;
}

function titleForPhase(phase: ExperiencePhase) {
  switch (phase) {
    case "denied":
      return "La c\u00e1mara qued\u00f3 bloqueada";
    case "unsupported":
      return "Modo interactivo no disponible";
    default:
      return "Modo visual et\u00e9reo";
  }
}

export function FallbackExperience({ phase, errorMessage, onRetry, onVisualMode }: FallbackExperienceProps) {
  return (
    <section className="absolute inset-0 flex items-end justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+4rem)] sm:px-6 sm:items-center sm:pb-6 sm:pt-16">
      <div className="panel-overlay w-full max-w-lg rounded-[2rem] px-5 py-6 sm:px-7">
        <BrandLockup className="mb-5" variant="hud" />
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-foreground-muted">Fallback guiado</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-foreground">{titleForPhase(phase)}</h2>
        <p className="mt-4 text-sm leading-6 text-foreground-muted">
          {errorMessage ??
            "Pod\u00e9s quedarte en una versi\u00f3n visual no interactiva mientras decid\u00eds si reintentar la c\u00e1mara desde un contexto HTTPS."}
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            className="focus-ring intro-activate-button min-h-12 rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:brightness-105"
            onClick={() => {
              void onRetry();
            }}
            type="button"
          >
            Reintentar c\u00e1mara
          </button>
          <button
            className="focus-ring panel-shell min-h-12 rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-foreground transition hover:bg-white/10"
            onClick={onVisualMode}
            type="button"
          >
            Seguir sin c\u00e1mara
          </button>
        </div>

        <div className="panel-note mt-4 rounded-[1.4rem] px-4 py-4 text-sm leading-6 text-foreground-muted">
          Si volv\u00e9s a probarlo, record\u00e1 usar un sitio publicado por HTTPS y encuadrar las manos completas dentro del cuadro para evitar jitter y p\u00e9rdidas de tracking.
        </div>
      </div>
    </section>
  );
}
