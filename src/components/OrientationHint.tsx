import { useEffect, useState } from "react";

interface OrientationHintProps {
  copy: string;
}

function isCompactLandscape() {
  return window.innerWidth < 900 && window.innerWidth > window.innerHeight;
}

export function OrientationHint({ copy }: OrientationHintProps) {
  const [visible, setVisible] = useState(() => (typeof window !== "undefined" ? isCompactLandscape() : false));

  useEffect(() => {
    const update = () => {
      setVisible(isCompactLandscape());
    };

    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex justify-center px-4">
      <div className="rounded-full border border-white/10 bg-black/45 px-4 py-2 text-center text-xs uppercase tracking-[0.24em] text-foreground-muted backdrop-blur-xl">
        {copy}
      </div>
    </div>
  );
}
