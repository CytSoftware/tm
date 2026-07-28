"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";

import { ServiceLogo } from "@/components/services/ServiceLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCreateInfrastructureService,
  useDeleteInfrastructureService,
  useInfrastructureServicesQuery,
  useUpdateInfrastructureService,
} from "@/hooks/use-infrastructure-services";
import type { InfrastructureService } from "@/lib/types";

export default function ServiceSettingsPage() {
  const servicesQuery = useInfrastructureServicesQuery();
  const remove = useDeleteInfrastructureService();
  const services = useMemo(
    () => servicesQuery.data?.results ?? [],
    [servicesQuery.data],
  );
  const categories = useMemo(
    () => [...new Set(services.map((service) => service.category))].sort(),
    [services],
  );
  const [editor, setEditor] = useState<InfrastructureService | "new" | null>(
    null,
  );

  function deleteService(service: InfrastructureService) {
    if (confirm(`Delete ${service.name} from the service directory?`)) {
      remove.mutate(service.id);
    }
  }

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
        Couldn&apos;t load services.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 min-h-14 px-4 max-lg:px-3 py-2 border-b border-border/80 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex-1 min-w-0">
          <h1 className="text-[16px] font-semibold tracking-tight">Services</h1>
          <p className="text-[11px] text-muted-foreground">
            Configure the shared grid of infrastructure tools and dashboards.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<a href="/services" />}
        >
          View directory <ExternalLink />
        </Button>
        <Button size="sm" onClick={() => setEditor("new")}>
          <Plus /> Add service
        </Button>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 lg:px-6 py-6">
          {services.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
              <ImagePlus className="size-7 mx-auto text-muted-foreground" />
              <h2 className="mt-3 text-[14px] font-medium">No services yet</h2>
              <p className="mt-1 text-[12px] text-muted-foreground">
                Add the first external tool to create the Services grid.
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={() => setEditor("new")}
              >
                <Plus /> Add service
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card divide-y divide-border/70">
              {services.map((service) => (
                <div
                  key={service.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <ServiceLogo
                    name={service.name}
                    logoUrl={service.logo_url}
                    serviceUrl={service.url}
                    className="size-10 rounded-lg shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium truncate">
                        {service.name}
                      </p>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground shrink-0">
                        {service.category}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
                      {service.description || service.url}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditor(service)}
                    aria-label={`Edit ${service.name}`}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => deleteService(service)}
                    disabled={remove.isPending}
                    aria-label={`Delete ${service.name}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {remove.isError && (
            <p className="mt-3 text-[11px] text-destructive">
              Couldn&apos;t delete that service.
            </p>
          )}
        </div>
      </main>

      {editor && (
        <ServiceEditorDialog
          service={editor === "new" ? null : editor}
          categories={categories}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function ServiceEditorDialog({
  service,
  categories,
  onClose,
}: {
  service: InfrastructureService | null;
  categories: string[];
  onClose: () => void;
}) {
  const create = useCreateInfrastructureService();
  const update = useUpdateInfrastructureService();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(service?.name ?? "");
  const [url, setUrl] = useState(service?.url ?? "");
  const [category, setCategory] = useState(service?.category ?? "");
  const [description, setDescription] = useState(service?.description ?? "");
  const [logo, setLogo] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const previewUrl = useMemo(
    () => (logo ? URL.createObjectURL(logo) : ""),
    [logo],
  );

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const shownLogo = previewUrl || (removeLogo ? "" : service?.logo_url ?? "");
  const saving = create.isPending || update.isPending;
  const hasError = create.isError || update.isError;
  const valid =
    name.trim().length > 0 &&
    category.trim().length > 0 &&
    /^https?:\/\//i.test(url.trim());

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    const input = {
      name: name.trim(),
      url: url.trim(),
      category: category.trim(),
      description: description.trim(),
      logo,
      removeLogo,
    };
    if (service) {
      update.mutate(
        { id: service.id, input },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(input, { onSuccess: onClose });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[500px] p-0 gap-0" showCloseButton={false}>
        <div className="px-5 py-4 border-b border-border/70">
          <DialogTitle className="text-[15px]">
            {service ? "Edit service" : "New service"}
          </DialogTitle>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Every field and logo is workspace-configured; no services are
            added automatically.
          </p>
        </div>
        <form onSubmit={submit}>
          <div className="px-5 py-4 space-y-4">
            <div className="flex items-center gap-4">
              <ServiceLogo
                name={name || "Service"}
                logoUrl={shownLogo}
                serviceUrl={url}
                className="size-16 rounded-xl shrink-0"
              />
              <div className="space-y-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    event.target.value = "";
                    if (file) {
                      setLogo(file);
                      setRemoveLogo(false);
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  <ImagePlus /> {shownLogo ? "Replace logo" : "Attach logo"}
                </Button>
                {shownLogo && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => {
                      setLogo(null);
                      setRemoveLogo(Boolean(service?.logo_url));
                    }}
                  >
                    Remove logo
                  </Button>
                )}
                <p className="text-[10px] text-muted-foreground">
                  PNG, JPEG, WebP or GIF · 2 MB maximum
                </p>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Uptime Kuma"
                  maxLength={120}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Input
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  placeholder="Monitoring"
                  list="service-categories"
                  maxLength={80}
                />
                <datalist id="service-categories">
                  {categories.map((item) => (
                    <option key={item} value={item} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Dashboard URL</Label>
              <Input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://uptime.example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Uptime monitoring and incident dashboard"
                maxLength={300}
              />
            </div>

            {hasError && (
              <p className="text-[11px] text-destructive">
                Couldn&apos;t save this service. Check the URL and logo file.
              </p>
            )}
          </div>
          <div className="px-5 py-3 border-t border-border/70 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving ? "Saving…" : service ? "Save changes" : "Add service"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
