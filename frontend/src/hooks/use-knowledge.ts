"use client";

/**
 * LLM Wiki data hooks — read-only markdown pages stored in B2 (llm-wiki/).
 *
 * Query-only by design: humans read, agents write (via the knowledge_* MCP
 * tools). No mutations here.
 */

import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";
import { llmWikiListKey, llmWikiPageKey } from "@/lib/query-keys";

export type WikiPageMeta = {
  slug: string;
  title: string;
  size: number;
  updated_at: string | null;
};

export type WikiPageDetail = {
  slug: string;
  title: string;
  markdown: string;
  updated_at: string | null;
};

export function useKnowledgeList() {
  return useQuery({
    queryKey: llmWikiListKey(),
    queryFn: () => apiFetch<WikiPageMeta[]>("/api/knowledge/pages/"),
  });
}

export function useKnowledgePage(slug: string | null) {
  return useQuery({
    queryKey: slug ? llmWikiPageKey(slug) : ["llm-wiki", "page", "__none__"],
    queryFn: () =>
      apiFetch<WikiPageDetail>(
        `/api/knowledge/pages/${encodeURIComponent(slug ?? "")}/`,
      ),
    enabled: !!slug,
  });
}
