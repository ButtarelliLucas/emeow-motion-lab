import clsx from "clsx";
import { assetUrl } from "@/lib/assets";
import type { GestureState, OverlayStatus } from "@/types/experience";

interface StatusHudProps {
  overlayStatus: OverlayStatus;
  helpOpen: boolean;
  helpItems: readonly string[];
  onToggleHelp: () => void;
  onGoHome: () => void;
}

function phaseLabel(overlayStatus: OverlayStatus) {
  if (overlayStatus.phase === "handMissing") {
    return "Buscando manos";
  }

  if (overlayStatus.handsCount > 0) {
    return `${overlayStatus.handsCount} mano${overlayStatus.handsCount === 1 ? "" : "s"}`;
  }

  return null;
}

function gestureHint(gesture: GestureState) {
  switch (gesture) {
    case "closedFist":
      return "Mano cerrada: el flujo se concentra con fuerza hacia la palma.";
    case "openPalm":
      return "Palma abierta: el campo se dispersa segun cuanto abras la mano.";
    case "sweep":
      return "Barrido rapido: desplaza corrientes y deja estelas.";
    case "dualField":
      return "Dos manos activas: la distancia entre palmas esta modulando el campo.";
    default:
      return "Mostra tus manos dentro del cuadro para activar el flujo.";
  }
}

function trackingBackendLabel(overlayStatus: OverlayStatus) {
  if (overlayStatus.trackingBackend === "parallel") {
    return "Procesamiento paralelo";
  }

  if (overlayStatus.trackingBackend === "legacy") {
    return "Fallback legacy";
  }

  return null;
}

export function StatusHud({
  overlayStatus,
  helpOpen,
  helpItems,
  onToggleHelp,
  onGoHome,
}: StatusHudProps) {
  const currentPhaseLabel = phaseLabel(overlayStatus);
  const trackingBackend = trackingBackendLabel(overlayStatus);

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-3 sm:px-5 sm:pt-5">
        <div className="glass-panel pointer-events-auto flex w-full max-w-6xl flex-col gap-3 rounded-[1.6rem] px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-16 w-16 items-center justify-center">
              <img alt="Logo e-Meow" className="h-16 w-16 object-contain" src={assetUrl("brand/emeow-logo-white.png")} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-foreground-muted">Interactive</p>
              <p className="text-sm font-medium tracking-[0.18em] text-foreground">Motion Lab</p>
            </div>
          </div>

          {currentPhaseLabel ? (
            <div className="flex flex-col items-start gap-2 sm:items-end">
              {currentPhaseLabel ? (
                <span className="w-fit rounded-full border border-white/12 bg-white/6 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground-muted">
                  {currentPhaseLabel}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] sm:px-5 sm:pb-5">
        <div className="relative w-full max-w-6xl">
          <div
            className={clsx(
              "glass-panel absolute bottom-[4.5rem] left-1/2 w-full max-w-xl -translate-x-1/2 rounded-[1.6rem] px-4 py-4 transition",
              helpOpen ? "pointer-events-auto translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
            )}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-foreground-muted">Estado</p>
            <p className="mt-2 text-sm leading-6 text-foreground-muted">{gestureHint(overlayStatus.primaryGesture)}</p>

            {helpOpen ? (
              <div className="mt-4 grid gap-2 text-sm leading-6 text-foreground-muted">
                <p>
                  Frame {overlayStatus.metrics.frameMs.toFixed(1)} ms / Tracking{" "}
                  {overlayStatus.metrics.trackingMs.toFixed(1)} ms
                </p>
                {overlayStatus.trackingBackend ? (
                  <div className="mt-1 rounded-[1.1rem] border border-white/8 bg-white/[0.035] px-3 py-2 text-xs leading-5 text-foreground-muted/86">
                    <p className="font-medium uppercase tracking-[0.18em] text-foreground-muted/92">{trackingBackend}</p>
                    {overlayStatus.trackingBackendReason ? <p className="mt-1">{overlayStatus.trackingBackendReason}</p> : null}
                  </div>
                ) : null}
                {helpItems.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex min-h-[6.75rem] flex-col items-center justify-end gap-2 sm:min-h-12 sm:flex-row sm:items-end sm:justify-end sm:gap-0">
            <button
              aria-label={helpOpen ? "Ocultar ayuda" : "Mostrar ayuda"}
              className="focus-ring pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/12 bg-white/6 text-sm font-medium text-foreground transition hover:bg-white/10 sm:absolute sm:bottom-0 sm:left-1/2 sm:-translate-x-1/2"
              onClick={onToggleHelp}
              type="button"
            >
              <span className="flex h-5 w-5 items-center justify-center">
                <span className="text-lg leading-none">?</span>
              </span>
            </button>
            <button
              className="pointer-events-auto min-h-12 rounded-full border-0 bg-transparent px-2 py-3 text-sm font-medium tracking-[0.12em] text-foreground/84 shadow-none outline-none transition hover:bg-transparent hover:text-foreground hover:underline hover:underline-offset-4 focus:outline-none focus-visible:bg-transparent focus-visible:text-foreground focus-visible:underline focus-visible:underline-offset-4"
              data-live-chrome-control="true"
              onClick={onGoHome}
              type="button"
            >
              motion.e-meow.com.ar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
