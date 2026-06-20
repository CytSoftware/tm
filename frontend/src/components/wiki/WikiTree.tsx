"use client";

import { useMemo, useState } from "react";
import { ChevronRight, FileText, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { WikiDoc } from "@/lib/types";

type TreeNode = WikiDoc & { children: TreeNode[] };

function buildTree(docs: WikiDoc[]): TreeNode[] {
  const byId = new Map<number, TreeNode>();
  for (const d of docs) byId.set(d.id, { ...d, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent != null ? byId.get(node.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.position - b.position || a.id - b.id);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export type WikiTreeProps = {
  docs: WikiDoc[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onCreateChild: (parentId: number) => void;
  onDelete: (key: string) => void;
};

export function WikiTree({
  docs,
  selectedKey,
  onSelect,
  onCreateChild,
  onDelete,
}: WikiTreeProps) {
  const roots = useMemo(() => buildTree(docs), [docs]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (roots.length === 0) {
    return (
      <p className="px-3 py-2 text-[13px] text-muted-foreground">
        No pages yet.
      </p>
    );
  }

  return (
    <ul className="py-1">
      {roots.map((node) => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          expanded={expanded}
          toggle={toggle}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  toggle,
  selectedKey,
  onSelect,
  onCreateChild,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onCreateChild: (parentId: number) => void;
  onDelete: (key: string) => void;
}) {
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const active = node.key === selectedKey;

  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 pr-1 rounded-md text-[13px] cursor-pointer transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/60 text-sidebar-foreground/90",
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => onSelect(node.key)}
      >
        <button
          type="button"
          aria-label={isOpen ? "Collapse" : "Expand"}
          className={cn(
            "grid place-items-center size-4 shrink-0 rounded text-muted-foreground hover:text-foreground transition-transform",
            !hasChildren && "invisible",
            isOpen && "rotate-90",
          )}
          onClick={(e) => {
            e.stopPropagation();
            toggle(node.id);
          }}
        >
          <ChevronRight className="size-3.5" />
        </button>
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate flex-1 py-1.5">
          {node.title || "Untitled"}
        </span>
        <button
          type="button"
          aria-label="Add sub-page"
          className="hidden group-hover:grid place-items-center size-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            if (!isOpen) toggle(node.id);
            onCreateChild(node.id);
          }}
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Delete page"
          className="hidden group-hover:grid place-items-center size-5 shrink-0 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            const label = node.title || "Untitled";
            const extra = node.has_children
              ? " and all of its sub-pages"
              : "";
            if (confirm(`Delete "${label}"${extra}? This cannot be undone.`)) {
              onDelete(node.key);
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
      {hasChildren && isOpen && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              selectedKey={selectedKey}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
