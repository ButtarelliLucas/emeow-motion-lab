import clsx from "clsx";
import type { RefObject } from "react";

interface ExperienceViewportProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cameraVisible: boolean;
}

export function ExperienceViewport({ videoRef, canvasRef, cameraVisible }: ExperienceViewportProps) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-nebula">
      <div className="ambient-grid absolute inset-0 opacity-55" />
      <video
        ref={videoRef}
        autoPlay
        className={clsx(
          "absolute inset-0 h-full w-full object-cover transition-opacity duration-700",
          cameraVisible ? "opacity-55" : "opacity-0",
        )}
        muted
        playsInline
        aria-hidden="true"
        style={{ transform: "scaleX(-1)" }}
      />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(3,8,12,0.2),rgba(3,8,12,0.68)),radial-gradient(circle_at_center,transparent_18%,rgba(3,8,12,0.35)_74%,rgba(3,8,12,0.7)_100%)]" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
    </div>
  );
}
