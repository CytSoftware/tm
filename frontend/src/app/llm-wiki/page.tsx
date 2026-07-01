"use client";

/**
 * LLM Wiki — the agent-maintained markdown knowledge base (B2 llm-wiki/).
 * Read-only for humans; pages are created/updated by agents via MCP.
 *
 * Layout invariant (see CLAUDE.md): immediate child of the app shell, so the
 * root is ``h-full flex`` and every scroll surface carries ``min-h-0``.
 */

import { useState } from "react";
import MarkdownIt from "markdown-it";
import { FileText, Sparkles } from "lucide-react";

import { useKnowledgeList, useKnowledgePage } from "@/hooks/use-knowledge";
import { cn } from "@/lib/utils";

// html:false keeps raw HTML in the source escaped (the pages are agent-written,
// but this stays defensive); linkify turns bare URLs into links.
const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// With html:false the only injection surface left is link/image URL *schemes*.
// Harden validateLink (used for both links and images) to reject dangerous
// schemes — including the percent-encoded forms a browser decodes on click.
const DANGEROUS_SCHEME = /^(javascript|vbscript|data|file):/i;
md.validateLink = (url: string) => {
  let s = (url || "").trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // malformed encoding — fall through and test the raw string
  }
  // strip control chars / whitespace (avoids a control-char regex literal)
  s = Array.from(s)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join("");
  return !DANGEROUS_SCHEME.test(s);
};

export default function LlmWikiPage() {
  const [slug, setSlug] = useState<string | null>(null);
  const list = useKnowledgeList();
  const page = useKnowledgePage(slug);

  return (
    <div className="h-full flex min-h-0">
      {/* Page list */}
      <aside className="w-72 shrink-0 border-r border-border/80 flex flex-col min-h-0">
        <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-border/80">
          <Sparkles className="size-4 text-muted-foreground" />
          <span className="text-[13px] font-medium">LLM Wiki</span>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {list.isLoading ? (
            <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
          ) : list.isError ? (
            <div className="p-4 text-[13px] text-destructive">
              {(list.error as Error)?.message ?? "Failed to load."}
            </div>
          ) : list.data && list.data.length === 0 ? (
            <div className="p-4 text-[13px] text-muted-foreground">
              No pages yet. Agents write pages here via MCP.
            </div>
          ) : (
            <ul className="py-1">
              {list.data!.map((p) => (
                <li key={p.slug}>
                  <button
                    type="button"
                    onClick={() => setSlug(p.slug)}
                    className={cn(
                      "w-full flex items-center gap-2 px-4 py-2 text-[13px] text-left hover:bg-accent/50",
                      slug === p.slug && "bg-accent",
                    )}
                  >
                    <FileText className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{p.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Rendered page */}
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        {!slug ? (
          <div className="h-full grid place-items-center text-[13px] text-muted-foreground">
            Select a page.
          </div>
        ) : page.isLoading ? (
          <div className="p-6 text-[13px] text-muted-foreground">Loading…</div>
        ) : page.isError ? (
          <div className="p-6 text-[13px] text-destructive">
            {(page.error as Error)?.message ?? "Failed to load page."}
          </div>
        ) : page.data ? (
          <article className="mx-auto max-w-3xl px-8 py-8">
            <div className="mb-3 text-[11px] uppercase tracking-wide text-muted-foreground">
              Read-only · maintained by agents
              {page.data.updated_at
                ? ` · updated ${new Date(page.data.updated_at).toLocaleDateString()}`
                : ""}
            </div>
            <div
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: md.render(page.data.markdown) }}
            />
          </article>
        ) : null}
      </main>
    </div>
  );
}
