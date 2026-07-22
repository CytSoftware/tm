"use client";

import { useMemo } from "react";
import { Boxes, Settings2 } from "lucide-react";

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
          <div className="max-w-7xl mx-auto px-6 py-7 space-y-9">
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
                <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-x-3 gap-y-6">
                  {categoryServices.map((service) => (
                    <a
                      key={service.id}
                      href={service.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group min-w-0 rounded-xl px-2 py-3 flex flex-col items-center gap-3 transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ServiceLogo
                        name={service.name}
                        logoUrl={service.logo_url}
                        serviceUrl={service.url}
                        className="size-24 rounded-[22%] shrink-0 text-xl transition-transform group-hover:scale-[1.03]"
                      />
                      <h3 className="max-w-28 text-center text-[13px] leading-tight font-medium line-clamp-2">
                        {service.name}
                      </h3>
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
