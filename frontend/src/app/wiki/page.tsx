"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
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
    <div className="h-full flex min-h-0">
      <aside className="w-72 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 h-11 shrink-0 border-b border-border">
          <span className="text-[13px] font-medium">Wiki</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-[12px]"
            onClick={() => createPage(null)}
            disabled={create.isPending}
          >
            <Plus className="size-3.5" /> New
          </Button>
        </div>
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
      </aside>
      <main className="flex-1 min-w-0 min-h-0 flex flex-col">
        {selected ? (
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
        )}
      </main>
    </div>
  );
}
