"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText, Plus, Trash2 } from "lucide-react";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  attachInstruction,
  extractInstruction,
} from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";

import { cn } from "@/lib/utils";
import { useMoveDoc, type MoveDocPayload } from "@/hooks/use-wiki";
import type { WikiDoc } from "@/lib/types";

const INDENT = 12; // px per nesting level — must match the row paddingLeft step

type TreeNode = WikiDoc & { children: TreeNode[] };

type WikiDragData = {
  type: "wiki-tree-item";
  id: number;
  key: string;
  parent: number | null;
};
const isWikiDrag = (d: Record<string, unknown>): d is WikiDragData =>
  d.type === "wiki-tree-item";

type Instruction = NonNullable<ReturnType<typeof extractInstruction>>;

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
  const move = useMoveDoc();

  const toggle = useCallback(
    (id: number) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const expand = useCallback(
    (id: number) => setExpanded((prev) => new Set(prev).add(id)),
    [],
  );

  // True when `targetId` is `draggedId` itself or anywhere in its subtree —
  // i.e. dropping there would make a page its own ancestor. Mirrors the
  // backend's cycle guard so we never offer (or send) an illegal move.
  const isSelfOrDescendant = useMemo(() => {
    const parentOf = new Map<number, number | null>();
    for (const d of docs) parentOf.set(d.id, d.parent);
    return (targetId: number, draggedId: number) => {
      let cur: number | null | undefined = targetId;
      while (cur != null) {
        if (cur === draggedId) return true;
        cur = parentOf.get(cur);
      }
      return false;
    };
  }, [docs]);

  const onMove = useCallback(
    (payload: MoveDocPayload) => move.mutate(payload),
    [move],
  );

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
          expand={expand}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
          onDelete={onDelete}
          onMove={onMove}
          isSelfOrDescendant={isSelfOrDescendant}
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
  expand,
  selectedKey,
  onSelect,
  onCreateChild,
  onDelete,
  onMove,
  isSelfOrDescendant,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<number>;
  toggle: (id: number) => void;
  expand: (id: number) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onCreateChild: (parentId: number) => void;
  onDelete: (key: string) => void;
  onMove: (payload: MoveDocPayload) => void;
  isSelfOrDescendant: (targetId: number, draggedId: number) => boolean;
}) {
  const isOpen = expanded.has(node.id);
  const hasChildren = node.children.length > 0;
  const active = node.key === selectedKey;

  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [instruction, setInstruction] = useState<Instruction | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const data: WikiDragData = {
      type: "wiki-tree-item",
      id: node.id,
      key: node.key,
      parent: node.parent,
    };
    return combine(
      draggable({
        element: el,
        getInitialData: () => ({ ...data }),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element: el,
        canDrop: ({ source }) =>
          isWikiDrag(source.data) &&
          !isSelfOrDescendant(node.id, source.data.id),
        getData: ({ input, element }) =>
          attachInstruction(
            { ...data },
            {
              input,
              element,
              currentLevel: depth,
              indentPerLevel: INDENT,
              // Expanded parents: dropping below the row means "first child",
              // so treat everything but the top edge as make-child.
              mode: hasChildren && isOpen ? "expanded" : "standard",
            },
          ),
        onDrag: ({ self }) => setInstruction(extractInstruction(self.data)),
        onDragLeave: () => setInstruction(null),
        onDrop: ({ self, source }) => {
          setInstruction(null);
          if (!isWikiDrag(source.data)) return;
          const instr = extractInstruction(self.data);
          if (!instr) return;
          const key = source.data.key;
          if (instr.type === "make-child") {
            onMove({ key, parent_id: node.id });
            expand(node.id); // reveal the newly nested page
          } else if (instr.type === "reorder-above") {
            onMove({ key, parent_id: node.parent, before_id: node.id });
          } else if (instr.type === "reorder-below") {
            onMove({ key, parent_id: node.parent, after_id: node.id });
          }
        },
        getIsSticky: () => true,
      }),
    );
  }, [
    node.id,
    node.key,
    node.parent,
    depth,
    hasChildren,
    isOpen,
    onMove,
    expand,
    isSelfOrDescendant,
  ]);

  const makeChild = instruction?.type === "make-child";

  return (
    <li>
      <div
        ref={ref}
        className={cn(
          "group relative flex items-center gap-1 pr-1 rounded-md text-[13px] cursor-pointer transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-sidebar-accent/60 text-sidebar-foreground/90",
          dragging && "opacity-40",
          makeChild && "ring-1 ring-inset ring-primary bg-primary/5",
        )}
        style={{ paddingLeft: depth * INDENT + 4 }}
        onClick={() => onSelect(node.key)}
      >
        {instruction?.type === "reorder-above" && (
          <span
            className="absolute left-1 right-1 -top-px h-0.5 rounded-full bg-primary"
            aria-hidden
          />
        )}
        {instruction?.type === "reorder-below" && (
          <span
            className="absolute left-1 right-1 -bottom-px h-0.5 rounded-full bg-primary"
            aria-hidden
          />
        )}
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
          className="hidden group-hover:grid hover-none:grid place-items-center size-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground"
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
          className="hidden group-hover:grid hover-none:grid place-items-center size-5 shrink-0 rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={(e) => {
            e.stopPropagation();
            const label = node.title || "Untitled";
            const extra = node.has_children ? " and all of its sub-pages" : "";
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
              expand={expand}
              selectedKey={selectedKey}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              onDelete={onDelete}
              onMove={onMove}
              isSelfOrDescendant={isSelfOrDescendant}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
