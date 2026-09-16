"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { BookOpen, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MasterDetail } from "@/components/layout/MasterDetail";
import { WikiTree } from "@/components/wiki/WikiTree";
import { EditorSkeleton } from "@/components/wiki/EditorSkeleton";
import { useCreateDoc, useDeleteDoc, useWikiTreeQuery } from "@/hooks/use-wiki";
import { connectWikiTreeSocket } from "@/lib/wiki-ws";

const WikiEditor = dynamic(
  () => import("@/components/wiki/WikiEditor").then((mod) => mod.WikiEditor),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

export default function WikiPage() {
  const qc = useQueryClient();
  const treeQuery = useWikiTreeQuery();
  const docs = useMemo(() => treeQuery.data ?? [], [treeQuery.data]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const create = useCreateDoc();
  const del = useDeleteDoc();

  useEffect(() => connectWikiTreeSocket({ queryClient: qc }), [qc]);

  const selected = useMemo(
    () => docs.find((d) => d.key === selectedKey) ?? null,
    [docs, selectedKey],
  );

  async function createPage(parentId: number | null) {
    const doc = await create.mutateAsync(
      parentId != null ? { parent_id: parentId } : {},
    );
    setSelectedKey(doc.key);
  }

  async function deletePage(key: string) {
    await del.mutateAsync(key);
    setSelectedKey((cur) => (cur === key ? null : cur));
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 min-h-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 max-lg:px-3 py-1.5 border-b border-border/80 bg-background">
        <BookOpen className="size-4 text-muted-foreground" />
        <h1 className="text-[13px] font-semibold tracking-tight">Wiki</h1>
        <Button
          size="sm"
          className="ml-auto h-7 text-[12px] tap-target"
          onClick={() => createPage(null)}
          disabled={create.isPending}
        >
          <Plus className="size-3.5" /> New page
        </Button>
      </header>
      <MasterDetail
        className="h-auto flex-1"
        railWidth="w-72"
        hasSelection={selected != null}
        onBack={() => setSelectedKey(null)}
        backLabel="Wiki"
        master={
          <div className="flex-1 min-h-0 overflow-y-auto px-1">
            {treeQuery.isLoading ? (
              <p className="px-3 py-2 text-[13px] text-muted-foreground">
                Loading…
              </p>
            ) : (
              <WikiTree
                docs={docs}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
                onCreateChild={(pid) => createPage(pid)}
                onDelete={deletePage}
              />
          )}
        </div>
      }
      detail={
        selected ? (
          <WikiEditor
            key={selected.key}
            doc={selected}
            onNavigate={setSelectedKey}
          />
        ) : (
          <div className="flex-1 grid place-items-center text-[13px] text-muted-foreground">
            <div className="text-center space-y-2">
              <p>Select a page, or create one to start.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => createPage(null)}
              >
                <Plus className="size-3.5 mr-1" /> New page
              </Button>
            </div>
          </div>
        )
      }
    />
    </div>
  );
}
