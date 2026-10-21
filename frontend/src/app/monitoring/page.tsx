"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useEventSourcesQuery } from "@/hooks/use-events";

export default function MonitoringIndex() {
  const router = useRouter();
  const query = useEventSourcesQuery();
  const first = query.data?.results[0];
  useEffect(() => {
    if (first) router.replace(`/monitoring/${first.id}`);
  }, [first, router]);

  if (query.isPending || first) return <p role="status" className="grid h-full place-items-center text-[13px] text-muted-foreground">Loading monitoring…</p>;
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="space-y-3">
        <p className="text-[14px] font-medium">{query.isError ? "Couldn’t load monitoring sources." : "No monitoring sources yet"}</p>
        <Button size="sm" variant="outline" render={<a href="/settings/incoming-webhooks" />}>Add an incoming webhook</Button>
      </div>
    </div>
  );
}
