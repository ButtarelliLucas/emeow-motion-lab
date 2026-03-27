import clsx from "clsx";
import { assetUrl } from "@/lib/assets";
import type { GestureState, OverlayStatus } from "@/types/experience";

interface StatusHudProps {
  overlayStatus: OverlayStatus;
  helpOpen: boolean;
  helpItems: readonly string[];
  onToggleHelp: () => void;
  onRecalibrate: () => void;
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

export function StatusHud({
  overlayStatus,
  helpOpen,
  helpItems,
  onToggleHelp,
  onRecalibrate,
  onGoHome,
}: StatusHudProps) {
  const currentPhaseLabel = phaseLabel(overlayStatus);

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-3 sm:px-5 sm:pt-5">
        <div className="glass-panel pointer-events-auto flex w-full max-w-6xl flex-col gap-3 rounded-[1.6rem] px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-16 w-16 items-center justify-center">
              <img alt="Logo e-Meow" className="h-16 w-16 object-contain" src={assetUrl("brand/emeow-logo-white.png")} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-foreground-muted">
                Experiencia interactiva
              </p>
              <p className="text-sm font-medium tracking-[0.18em] text-foreground">Motion Lab</p>
            </div>
          </div>

          {currentPhaseLabel ? (
            <span className="w-fit rounded-full border border-white/12 bg-white/6 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground-muted">
              {currentPhaseLabel}
            </span>
          ) : null}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] sm:px-5 sm:pb-5">
        <div className="pointer-events-auto flex w-full max-w-6xl flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div
            className={clsx(
              "glass-panel max-w-xl rounded-[1.6rem] px-4 py-4 transition",
              helpOpen ? "translate-y-0 opacity-100" : "translate-y-2 opacity-92",
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
                {helpItems.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap justify-end gap-2 self-end">
            <button
              className="focus-ring min-h-12 rounded-full border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-foreground transition hover:bg-white/10"
              onClick={onToggleHelp}
              type="button"
            >
              {helpOpen ? "Ocultar ayuda" : "Ayuda"}
            </button>
            <button
              className="focus-ring min-h-12 rounded-full border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-foreground transition hover:bg-white/10"
              onClick={onRecalibrate}
              type="button"
            >
              Recalibrar
            </button>
            <button
              className="focus-ring min-h-12 rounded-full px-2 py-3 text-sm font-medium tracking-[0.12em] text-foreground/84 transition hover:text-foreground hover:underline hover:underline-offset-4"
              data-live-chrome-control="true"
              onClick={onGoHome}
              type="button"
            >
              e-meow.com.ar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
