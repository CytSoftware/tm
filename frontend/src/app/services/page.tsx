"use client";

import { useMemo } from "react";
import { Boxes, ExternalLink, Settings2 } from "lucide-react";

import { ServiceLogo } from "@/components/services/ServiceLogo";
import { Button } from "@/components/ui/button";
import { useInfrastructureServicesQuery } from "@/hooks/use-infrastructure-services";

export default function ServicesPage() {
  const servicesQuery = useInfrastructureServicesQuery();
  const services = useMemo(
    () => servicesQuery.data?.results ?? [],
    [servicesQuery.data],
  );
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof services>();
    for (const service of services) {
      const existing = grouped.get(service.category) ?? [];
      existing.push(service);
      grouped.set(service.category, existing);
    }
    return [...grouped.entries()];
  }, [services]);

  if (servicesQuery.isLoading) {
    return (
      <div className="h-full grid place-items-center">
        <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-foreground animate-spin" />
      </div>
    );
  }

  if (servicesQuery.isError) {
    return (
      <div className="h-full grid place-items-center text-[13px] text-destructive">
        Couldn&apos;t load the service directory.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 h-14 px-5 border-b border-border/80 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-semibold tracking-tight">Services</h1>
          <p className="text-[11px] text-muted-foreground">
            Dashboards and tools used across the infrastructure.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<a href="/settings/services" />}
        >
          <Settings2 /> Configure
        </Button>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        {services.length === 0 ? (
          <div className="h-full grid place-items-center p-6 text-center">
            <div className="max-w-sm">
              <div className="size-12 rounded-xl bg-muted grid place-items-center mx-auto">
                <Boxes className="size-5 text-muted-foreground" />
              </div>
              <h2 className="mt-4 text-[15px] font-semibold">
                Build your service directory
              </h2>
              <p className="mt-1.5 text-[12px] text-muted-foreground">
                Add the tools your infrastructure relies on. Nothing appears
                here until your workspace configures it.
              </p>
              <Button
                size="sm"
                className="mt-4"
                render={<a href="/settings/services" />}
              >
                Configure services
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-w-6xl mx-auto px-6 py-6 space-y-8">
            {groups.map(([category, categoryServices]) => (
              <section key={category}>
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {category}
                  </h2>
                  <span className="text-[11px] tabular-nums text-muted-foreground/60">
                    {categoryServices.length}
                  </span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                  {categoryServices.map((service) => (
                    <a
                      key={service.id}
                      href={service.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group min-h-36 rounded-xl border border-border bg-card p-4 flex flex-col transition-colors hover:border-foreground/20 hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-start gap-3">
                        <ServiceLogo
                          name={service.name}
                          logoUrl={service.logo_url}
                          className="size-11 rounded-lg shrink-0"
                        />
                        <div className="flex-1 min-w-0 pt-0.5">
                          <div className="flex items-start gap-2">
                            <h3 className="flex-1 min-w-0 text-[14px] font-semibold truncate">
                              {service.name}
                            </h3>
                            <ExternalLink className="size-3.5 mt-0.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                          </div>
                          <p className="mt-0.5 text-[10px] text-muted-foreground truncate">
                            {hostname(service.url)}
                          </p>
                        </div>
                      </div>
                      {service.description && (
                        <p className="mt-auto pt-4 text-[12px] leading-relaxed text-muted-foreground line-clamp-2">
                          {service.description}
                        </p>
                      )}
                    </a>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function hostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
