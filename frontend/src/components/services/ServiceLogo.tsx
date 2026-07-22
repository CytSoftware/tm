import { Boxes } from "lucide-react";

import { cn } from "@/lib/utils";

export function ServiceLogo({
  name,
  logoUrl,
  serviceUrl,
  className,
}: {
  name: string;
  logoUrl?: string;
  serviceUrl?: string;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  const faviconUrl = faviconFor(serviceUrl);

  return (
    <span
      className={cn(
        "relative grid place-items-center overflow-hidden bg-card text-muted-foreground text-xs font-semibold ring-1 ring-border/70 shadow-sm",
        className,
      )}
      aria-hidden
    >
      {initials || <Boxes className="size-1/2" />}
      {faviconUrl && (
        // Service favicons are intentionally loaded from their own origin.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconUrl}
          alt=""
          className="absolute inset-0 size-full bg-card object-contain p-[14%]"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
      {logoUrl && (
        // Uploaded logos can originate from any configured backend media host.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className="absolute inset-0 size-full bg-card object-contain p-[12%]"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      )}
    </span>
  );
}

function faviconFor(url?: string) {
  if (!url) return "";
  try {
    return new URL("/favicon.ico", url).toString();
  } catch {
    return "";
  }
}
