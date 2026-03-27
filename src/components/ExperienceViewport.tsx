import clsx from "clsx";
import type { RefObject } from "react";

interface ExperienceViewportProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraOpacity: number;
  wireframeMode: boolean;
}

export function ExperienceViewport({ videoRef, canvasRef, cameraOpacity, wireframeMode }: ExperienceViewportProps) {
  return (
    <div className={clsx("absolute inset-0 overflow-hidden", wireframeMode ? "bg-black" : "bg-nebula")}>
      {!wireframeMode ? <div className="ambient-grid absolute inset-0 opacity-55" /> : null}
      <video
        ref={videoRef}
        autoPlay
        className={clsx(
          "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
          cameraOpacity > 0 ? "opacity-100" : "opacity-0",
        )}
        muted
        playsInline
        aria-hidden="true"
        style={{ opacity: cameraOpacity, transform: "scaleX(-1)" }}
      />
      {!wireframeMode ? (
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(3,8,12,0.2),rgba(3,8,12,0.68)),radial-gradient(circle_at_center,transparent_18%,rgba(3,8,12,0.35)_74%,rgba(3,8,12,0.7)_100%)]" />
      ) : null}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
    </div>
  );
}
