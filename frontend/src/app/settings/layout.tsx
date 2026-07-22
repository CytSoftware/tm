"use client";

import {
  Activity,
  Columns3,
  Grid2X2,
  Send,
  Settings,
  Zap,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

const SETTINGS_NAV = [
  {
    href: "/settings/quick-actions",
    label: "Quick actions",
    description: "Personal sidebar shortcuts",
    icon: Zap,
  },
  {
    href: "/settings/columns",
    label: "Columns",
    description: "Staleness thresholds",
    icon: Columns3,
  },
  {
    href: "/settings/outgoing-webhooks",
    label: "Outgoing webhooks",
    description: "Cyt sends task events",
    icon: Send,
  },
  {
    href: "/settings/incoming-webhooks",
    label: "Incoming webhooks",
    description: "Services send monitoring events",
    icon: Activity,
  },
  {
    href: "/settings/services",
    label: "Services",
    description: "Infrastructure directory",
    icon: Grid2X2,
  },
] as const;

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="h-full min-h-0 flex">
      <aside className="w-56 shrink-0 border-r border-border/80 bg-muted/10 flex flex-col min-h-0">
        <div className="shrink-0 h-14 px-4 border-b border-border/70 flex items-center gap-2">
          <Settings className="size-4 text-muted-foreground" />
          <span className="text-[14px] font-semibold tracking-tight">
            Settings
          </span>
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <button
                key={item.href}
                type="button"
                onClick={() => router.push(item.href)}
                className={cn(
                  "w-full rounded-md px-2.5 py-2 flex items-start gap-2.5 text-left transition-colors",
                  active
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 mt-0.5 shrink-0" />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium truncate">
                    {item.label}
                  </span>
                  <span className="block mt-0.5 text-[10px] text-muted-foreground truncate">
                    {item.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>
      </aside>
      <section className="flex-1 min-w-0 min-h-0 overflow-hidden">
        {children}
      </section>
    </div>
  );
}
