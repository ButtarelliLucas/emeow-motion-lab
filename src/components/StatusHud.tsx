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

function gestureLabel(gesture: GestureState) {
  switch (gesture) {
    case "pinch":
      return "Pinch";
    case "openPalm":
      return "Palma abierta";
    case "sweep":
      return "Sweep";
    case "dualField":
      return "Campo dual";
    default:
      return "Idle";
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
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-3 sm:px-5 sm:pt-5">
        <div className="glass-panel pointer-events-auto flex w-full max-w-6xl flex-col gap-3 rounded-[1.6rem] px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-[1.2rem] border border-white/12 bg-white/6">
              <img alt="Monograma e-Meow" className="h-7 w-7 object-contain" src={assetUrl("brand/emeow-m-mark.svg")} />
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-foreground-muted">
                e-Meow Motion Lab
              </p>
              <p className="text-sm font-medium text-foreground">Cosmic hand sculpting</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {[
              `Camara ${overlayStatus.phase === "live" || overlayStatus.phase === "handMissing" ? "activa" : "lista"}`,
              `${overlayStatus.handsCount} mano${overlayStatus.handsCount === 1 ? "" : "s"}`,
              gestureLabel(overlayStatus.primaryGesture),
              `Modo ${overlayStatus.qualityTier}`,
            ].map((item) => (
              <span
                key={item}
                className="rounded-full border border-white/12 bg-white/6 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground-muted"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-3 sm:px-5 sm:pb-5">
        <div className="pointer-events-auto flex w-full max-w-6xl flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div
            className={clsx(
              "glass-panel max-w-xl rounded-[1.6rem] px-4 py-4 transition",
              helpOpen ? "translate-y-0 opacity-100" : "translate-y-2 opacity-92",
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-foreground-muted">Estado</p>
                <p className="mt-2 text-sm leading-6 text-foreground-muted">
                  Frame {overlayStatus.metrics.frameMs.toFixed(1)} ms · Tracking {overlayStatus.metrics.trackingMs.toFixed(1)} ms
                </p>
              </div>
              <button
                className="focus-ring min-h-12 rounded-full border border-white/12 bg-white/6 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-white/10"
                onClick={onToggleHelp}
                type="button"
              >
                {helpOpen ? "Ocultar ayuda" : "Ayuda"}
              </button>
            </div>

            {helpOpen ? (
              <div className="mt-4 grid gap-2 text-sm leading-6 text-foreground-muted">
                {helpItems.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex gap-2 self-end">
            <button
              className="focus-ring min-h-12 rounded-full border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-foreground transition hover:bg-white/10"
              onClick={onRecalibrate}
              type="button"
            >
              Recalibrar
            </button>
            <button
              className="focus-ring min-h-12 rounded-full border border-white/12 bg-white/6 px-4 py-3 text-sm font-medium text-foreground transition hover:bg-white/10"
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
