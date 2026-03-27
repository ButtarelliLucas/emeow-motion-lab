import clsx from "clsx";
import { EXPERIENCE_COPY } from "@/config/experience";
import { assetUrl } from "@/lib/assets";

type BrandLockupVariant = "intro" | "hud" | "minimal";

interface BrandLockupProps {
  variant: BrandLockupVariant;
  className?: string;
  useBrandMarkAsInitial?: boolean;
  showSignature?: boolean;
}

export function BrandLockup({
  variant,
  className,
  useBrandMarkAsInitial = false,
  showSignature = true,
}: BrandLockupProps) {
  const showBrandMarkAsInitial = useBrandMarkAsInitial && EXPERIENCE_COPY.productName.startsWith("M");
  const titleRemainder = showBrandMarkAsInitial
    ? EXPERIENCE_COPY.productName.slice(1)
    : EXPERIENCE_COPY.productName;

  return (
    <div className={clsx("brand-lockup", `brand-lockup--${variant}`, className)}>
      <p className="brand-lockup__title">
        {showBrandMarkAsInitial ? (
          <span className="brand-lockup__title-word">
            <img
              alt=""
              aria-hidden="true"
              className="brand-lockup__title-mark"
              src={assetUrl("brand/emeow-logo-white.png")}
            />
            <span className="brand-lockup__title-rest">{titleRemainder}</span>
          </span>
        ) : (
          EXPERIENCE_COPY.productName
        )}
      </p>
      {showSignature ? (
        <div className="brand-lockup__signature">
          <span>{EXPERIENCE_COPY.brandSignature}</span>
        </div>
      ) : null}
    </div>
  );
}
