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
      return "La camara quedo bloqueada";
    case "unsupported":
      return "Modo interactivo no disponible";
    default:
      return "Modo visual etereo";
  }
}

export function FallbackExperience({ phase, errorMessage, onRetry, onVisualMode }: FallbackExperienceProps) {
  return (
    <section className="absolute inset-0 flex items-end justify-center px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] pt-[calc(env(safe-area-inset-top,0px)+4rem)] sm:px-6 sm:items-center sm:pb-6 sm:pt-16">
      <div className="glass-panel w-full max-w-lg rounded-[2rem] px-5 py-6 sm:px-7">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-foreground-muted">Fallback guiado</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-[-0.05em] text-foreground">{titleForPhase(phase)}</h2>
        <p className="mt-4 text-sm leading-6 text-foreground-muted">
          {errorMessage ??
            "Puedes quedarte en una version visual no interactiva mientras decides si reintentar la camara desde un contexto HTTPS."}
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            className="focus-ring min-h-12 rounded-full border border-white/15 bg-[linear-gradient(135deg,rgba(128,235,255,0.88),rgba(248,62,165,0.88))] px-5 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-105"
            onClick={() => {
              void onRetry();
            }}
            type="button"
          >
            Reintentar camara
          </button>
          <button
            className="focus-ring min-h-12 rounded-full border border-white/15 bg-white/6 px-5 py-3 text-sm font-semibold text-foreground transition hover:bg-white/10"
            onClick={onVisualMode}
            type="button"
          >
            Seguir sin camara
          </button>
        </div>

        <div className="mt-4 rounded-[1.4rem] border border-white/10 bg-black/28 px-4 py-4 text-sm leading-6 text-foreground-muted">
          Si vuelves a probarlo, recuerda usar un sitio publicado por HTTPS y encuadrar las manos completas dentro del cuadro para evitar jitter y perdidas de tracking.
        </div>
      </div>
    </section>
  );
}
