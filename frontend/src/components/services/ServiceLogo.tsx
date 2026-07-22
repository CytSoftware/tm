import { Boxes } from "lucide-react";

import { cn } from "@/lib/utils";

export function ServiceLogo({
  name,
  logoUrl,
  className,
}: {
  name: string;
  logoUrl?: string;
  className?: string;
}) {
  if (logoUrl) {
    return (
      // Uploaded logos can originate from any configured backend media host.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        className={cn("object-contain", className)}
      />
    );
  }

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <span
      className={cn(
        "grid place-items-center bg-muted text-muted-foreground font-semibold",
        className,
      )}
      aria-hidden
    >
      {initials || <Boxes className="size-1/2" />}
    </span>
  );
}
