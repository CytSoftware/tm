"use client";

/**
 * LLM Wiki — the agent-maintained markdown knowledge base (B2 llm-wiki/).
 * Read-only for humans; pages are created/updated by agents via MCP.
 *
 * Pages are nested (slug = path like "entities/people/ali-soukarieh"), so the
 * sidebar renders a collapsible tree built from the flat slug list. Page bodies
 * use Karpathy-style [[wikilinks]] which we resolve to in-app navigation.
 *
 * Layout invariant (see CLAUDE.md): immediate child of the app shell, so the
 * root is ``h-full flex`` and every scroll surface carries ``min-h-0``.
 */

import { useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { ChevronRight, FileText, Folder, Sparkles } from "lucide-react";

import { MasterDetail } from "@/components/layout/MasterDetail";

import {
  type WikiPageMeta,
  useKnowledgeList,
  useKnowledgePage,
} from "@/hooks/use-knowledge";
import { cn } from "@/lib/utils";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

// With html:false the only injection surface left is link/image URL *schemes*.
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
  return !DANGEROUS_SCHEME.test(s) || s.startsWith("#w/");
};

// ── Tree ──────────────────────────────────────────────────────────────────
type TreeNode = {
  name: string;
  path: string; // folder path or full slug
  slug?: string; // set on leaf pages
  title: string;
  children: TreeNode[];
};

function buildTree(pages: WikiPageMeta[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", title: "", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);
  for (const p of [...pages].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const parts = p.slug.split("/");
    let cur = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      const leaf = i === parts.length - 1;
      let node = byPath.get(acc);
      if (!node) {
        node = { name: part, path: acc, title: part, children: [] };
        byPath.set(acc, node);
        cur.children.push(node);
      }
      if (leaf) {
        node.slug = p.slug;
        node.title = p.title || part;
      }
      cur = node;
    });
  }
  // folders first, then pages; each alphabetical
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      const af = a.slug ? 1 : 0;
      const bf = b.slug ? 1 : 0;
      if (af !== bf) return af - bf;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root.children;
}

// ── Wikilinks ───────────────────────────────────────────────────────────────
/** Resolve [[target|label]] / [[target]] to in-app links (`#w/<slug>`). */
function resolveWikilinks(
  body: string,
  slugSet: Set<string>,
  byLastSegment: Map<string, string[]>,
): string {
  return body.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [rawTarget, rawLabel] = inner.split("|");
    const label = (rawLabel ?? rawTarget).trim();
    let target = rawTarget.trim().toLowerCase().replace(/\.md$/, "");
    if (target.startsWith("wiki/")) target = target.slice(5);
    let slug: string | undefined;
    if (slugSet.has(target)) slug = target;
    else {
      const matches = byLastSegment.get(target.split("/").pop() || "");
      if (matches && matches.length === 1) slug = matches[0];
    }
    if (!slug) return label;
    // keep the link/label from breaking markdown; encode slug per segment
    const safeLabel = label.replace(/[[\]\n]/g, " ").trim() || slug;
    const enc = slug.split("/").map(encodeURIComponent).join("/");
    return `[${safeLabel}](#w/${enc})`;
  });
}

// ── Component ────────────────────────────────────────────────────────────────
export default function LlmWikiPage() {
  const [slug, setSlug] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const list = useKnowledgeList();
  const page = useKnowledgePage(slug);

  const tree = useMemo(() => buildTree(list.data ?? []), [list.data]);

  const { slugSet, byLastSegment } = useMemo(() => {
    const set = new Set<string>();
    const last = new Map<string, string[]>();
    for (const p of list.data ?? []) {
      set.add(p.slug);
      const seg = p.slug.split("/").pop() || p.slug;
      const arr = last.get(seg);
      if (arr) arr.push(p.slug);
      else last.set(seg, [p.slug]);
    }
    return { slugSet: set, byLastSegment: last };
  }, [list.data]);

  function selectSlug(s: string) {
    setSlug(s);
    // expand every ancestor folder so the page is visible in the tree
    const parts = s.split("/");
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = "";
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.add(acc);
      }
      return next;
    });
  }

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function onContentClick(e: React.MouseEvent<HTMLElement>) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#w/")) {
      e.preventDefault();
      let s = href.slice(3);
      try {
        s = decodeURIComponent(s);
      } catch {
        /* keep raw */
      }
      selectSlug(s);
    }
  }

  const html = useMemo(() => {
    if (!page.data) return "";
    const resolved = resolveWikilinks(page.data.markdown, slugSet, byLastSegment);
    return md.render(resolved);
  }, [page.data, slugSet, byLastSegment]);

  return (
    <MasterDetail
      railWidth="w-72"
      hasSelection={slug != null}
      onBack={() => setSlug(null)}
      backLabel="LLM Wiki"
      master={
        <>
        <header className="shrink-0 h-12 flex items-center gap-2 px-4 border-b border-border/80">
          <Sparkles className="size-4 text-muted-foreground" />
          <span className="text-[13px] font-medium">LLM Wiki</span>
          {list.data && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground/60">
              {list.data.length}
            </span>
          )}
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {list.isLoading ? (
            <div className="p-4 text-[13px] text-muted-foreground">Loading…</div>
          ) : list.isError ? (
            <div className="p-4 text-[13px] text-destructive">
              {(list.error as Error)?.message ?? "Failed to load."}
            </div>
          ) : tree.length === 0 ? (
            <div className="p-4 text-[13px] text-muted-foreground">
              No pages yet. Agents write pages here via MCP.
            </div>
          ) : (
            tree.map((n) => (
              <TreeItem
                key={n.path}
                node={n}
                depth={0}
                selected={slug}
                expanded={expanded}
                onToggle={toggle}
                onSelect={selectSlug}
              />
            ))
          )}
        </div>
        </>
      }
      detail={
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
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
          <article className="mx-auto max-w-3xl px-4 py-6 lg:px-8 lg:py-8">
            <div className="mb-1 text-[11px] text-muted-foreground/70 font-mono">
              {page.data.slug}
            </div>
            <MetaRow meta={page.data.meta} />
            <div
              className="prose prose-sm dark:prose-invert max-w-none [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto"
              onClick={onContentClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </article>
        ) : null}
        </div>
      }
    />
  );
}

function TreeItem({
  node,
  depth,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (slug: string) => void;
}) {
  const isFolder = !node.slug;

  if (isFolder) {
    const open = expanded.has(node.path);
    return (
      <>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          className="w-full flex items-center gap-1.5 py-1.5 pr-2 text-[13px] text-left hover:bg-accent/50 text-muted-foreground"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
          />
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          node.children.map((c) => (
            <TreeItem
              key={c.path}
              node={c}
              depth={depth + 1}
              selected={selected}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(node.slug!)}
      className={cn(
        "w-full flex items-center gap-1.5 py-1.5 pr-2 text-[13px] text-left hover:bg-accent/50",
        selected === node.slug && "bg-accent",
      )}
      style={{ paddingLeft: `${depth * 12 + 8 + 18}px` }}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{node.title}</span>
    </button>
  );
}

function MetaRow({ meta }: { meta: Record<string, string | string[]> }) {
  const tags = meta?.tags;
  const type = typeof meta?.type === "string" ? meta.type : null;
  const chips: string[] = [];
  if (type) chips.push(type);
  if (Array.isArray(tags)) chips.push(...tags);
  else if (typeof tags === "string" && tags) chips.push(tags);
  if (chips.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span
          key={i}
          className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {c}
        </span>
      ))}
    </div>
  );
}
