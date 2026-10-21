"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Settings2 } from "lucide-react";
import { useEventSourcesQuery } from "@/hooks/use-events";
import { MonitoringIcon } from "@/lib/monitoring";
import { cn } from "@/lib/utils";

/** One tab per incoming-webhook source; each tab is that source's own page. */
export default function MonitoringLayout({ children }: { children: React.ReactNode }) {
  const { sourceId } = useParams<{ sourceId?: string }>();
  const sources = useEventSourcesQuery().data?.results ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sources.length > 0 && (
        <nav aria-label="Monitoring sources" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/80 px-3">
          {sources.map(source => {
            const active = String(source.id) === sourceId;
            return (
              <Link
                key={source.id}
                href={`/monitoring/${source.id}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] transition-colors",
                  active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <MonitoringIcon name={source.icon} className="size-3.5" />
                {source.name}
                {!!source.new_count && (
                  <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums" title={`${source.new_count} new`}>{source.new_count}</span>
                )}
              </Link>
            );
          })}
          <Link href="/settings/incoming-webhooks" aria-label="Add or configure sources" className="ml-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <Settings2 className="size-3.5" />
          </Link>
        </nav>
      )}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
