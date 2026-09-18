"use client";

/**
 * The meetings graph: meetings, the people and companies in them, and their
 * projects, as nodes you can pan, zoom, drag and click through.
 *
 * SVG rather than canvas on purpose — at this scale (tens to a few hundred
 * nodes) it costs nothing, and it buys theme tokens that just work in dark
 * mode, crisp text, and real focusable elements for the keyboard.
 *
 * Two meetings that share a person are connected *through* that person's
 * node; there are no direct meeting↔meeting lines except explicit follow-ups.
 * That's what keeps this readable.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { format } from "date-fns";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useTheme } from "next-themes";

import type { MeetingGraph } from "@/hooks/use-meetings";
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  categoryColor,
  initials,
} from "@/lib/meeting-meta";
import { cn } from "@/lib/utils";

import { type GroupBy, type LaidOutNode, layoutGraph } from "./graph-layout";

type View = { x: number; y: number; k: number };

type Props = {
  graph: MeetingGraph;
  groupBy: GroupBy;
  selectedKey: string | null;
  focusedEntityId: number | null;
  onSelectMeeting: (key: string) => void;
  onSelectEntity: (entityId: number) => void;
  onSelectProject: (projectId: number) => void;
};

const MIN_K = 0.2;
const MAX_K = 4;
/** Below this zoom, meeting titles are hidden unless the node is in play. */
const LABEL_ZOOM = 1.5;
/** Auto-fit never zooms past this, so it never trips LABEL_ZOOM by itself. */
const MAX_FIT_K = 1.25;
const CLICK_SLOP = 4;
const LEGEND_CLEARANCE = 72;
const NO_MOVES: Map<string, { x: number; y: number }> = new Map();

const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

export function MeetingsGraph({
  graph,
  groupBy,
  selectedKey,
  focusedEntityId,
  onSelectMeeting,
  onSelectEntity,
  onSelectProject,
}: Props) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => layoutGraph(graph, groupBy), [graph, groupBy]);

  /** Positions of nodes the user has dragged, over the computed layout. They
   *  belong to one layout: a new one (new data, new grouping) starts clean. */
  const [drag, setDrag] = useState({ layout, moved: NO_MOVES });
  const moved = drag.layout === layout ? drag.moved : NO_MOVES;

  // The canvas needs pixel dimensions, and they must come from the wrapper —
  // sizing from `window` would break the page's no-scroll invariant.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The view is *derived*: until the user pans or zooms, it is whatever fits
  // the layout into the box (so opening the detail pane re-fits for free).
  // Their own view sticks for as long as this layout does.
  const fitted = useMemo<View>(() => {
    if (!size.w || !size.h) return { x: 0, y: 0, k: 1 };
    const { minX, minY, maxX, maxY } = layout.bounds;
    // Fit into the area above the legend, not underneath it.
    const h = Math.max(120, size.h - LEGEND_CLEARANCE);
    const k = Math.min(
      MAX_FIT_K,
      Math.max(MIN_K, Math.min(size.w / (maxX - minX), h / (maxY - minY))),
    );
    return {
      k,
      x: size.w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
    };
  }, [layout.bounds, size.w, size.h]);
  const [custom, setCustom] = useState<{ layout: unknown; view: View } | null>(
    null,
  );
  const view = custom?.layout === layout ? custom.view : fitted;
  const setView = useCallback(
    (next: View | ((v: View) => View)) =>
      setCustom((prev) => {
        const current = prev?.layout === layout ? prev.view : fitted;
        return {
          layout,
          view: typeof next === "function" ? next(current) : next,
        };
      }),
    [layout, fitted],
  );
  const fit = useCallback(() => setCustom(null), []);

  const nodes = useMemo(
    () => layout.nodes.map((n) => ({ ...n, ...(moved.get(n.id) ?? {}) })),
    [layout.nodes, moved],
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // What's "in play": the hovered node, else the selected meeting / focused
  // entity. Everything outside its neighbourhood dims.
  const anchorId =
    hovered ??
    (selectedKey ? `m:${selectedKey}` : null) ??
    (focusedEntityId != null ? `e:${focusedEntityId}` : null);
  const lit = useMemo(() => {
    if (!anchorId || !byId.has(anchorId)) return null;
    return new Set([anchorId, ...(layout.neighbors.get(anchorId) ?? [])]);
  }, [anchorId, byId, layout.neighbors]);
  // For a meeting, one hop further: the *other meetings* its people and
  // companies are in. Those are its linked meetings — the point of the view —
  // so they stay visible, a step quieter than the direct neighbourhood.
  const linked = useMemo(() => {
    const out = new Set<string>();
    if (!lit || !anchorId?.startsWith("m:")) return out;
    for (const id of lit) {
      if (!id.startsWith("e:")) continue;
      for (const next of layout.neighbors.get(id) ?? []) {
        if (next.startsWith("m:") && !lit.has(next)) out.add(next);
      }
    }
    return out;
  }, [lit, anchorId, layout.neighbors]);

  // ── Pan / zoom / drag ────────────────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<
    | { type: "pan"; startX: number; startY: number; view: View }
    | {
        type: "node";
        id: string;
        startX: number;
        startY: number;
        dragged: boolean;
      }
    | { type: "pinch"; dist: number; view: View; cx: number; cy: number }
    | null
  >(null);

  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      setView((v) => {
        const k = Math.min(MAX_K, Math.max(MIN_K, v.k * factor));
        const ratio = k / v.k;
        return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
      });
    },
    [setView],
  );

  // Wheel must be a non-passive native listener to stop the page zooming.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(
        e.clientX - rect.left,
        e.clientY - rect.top,
        Math.exp(-e.deltaY * 0.0015),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  function local(e: React.PointerEvent) {
    const rect = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent, nodeId?: string) {
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        type: "pinch",
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        view,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      return;
    }
    gesture.current = nodeId
      ? { type: "node", id: nodeId, startX: p.x, startY: p.y, dragged: false }
      : { type: "pan", startX: p.x, startY: p.y, view };
    if (nodeId) e.stopPropagation();
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (g.type === "pinch" && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const k = Math.min(
        MAX_K,
        Math.max(MIN_K, (g.view.k * Math.hypot(a.x - b.x, a.y - b.y)) / g.dist),
      );
      const ratio = k / g.view.k;
      setView({
        k,
        x: g.cx - (g.cx - g.view.x) * ratio,
        y: g.cy - (g.cy - g.view.y) * ratio,
      });
    } else if (g.type === "pan") {
      setView({
        ...g.view,
        x: g.view.x + p.x - g.startX,
        y: g.view.y + p.y - g.startY,
      });
    } else if (g.type === "node") {
      if (!g.dragged && Math.hypot(p.x - g.startX, p.y - g.startY) < CLICK_SLOP)
        return;
      g.dragged = true;
      const id = g.id;
      const at = { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
      setDrag((prev) => ({
        layout,
        moved: new Map(prev.layout === layout ? prev.moved : NO_MOVES).set(
          id,
          at,
        ),
      }));
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    gesture.current = null;
    if (g?.type === "node" && !g.dragged) activate(byId.get(g.id));
  }

  function activate(node: LaidOutNode | undefined) {
    if (!node) return;
    if (node.type === "meeting") onSelectMeeting(node.key);
    else if (node.type === "project") onSelectProject(node.project_id);
    else onSelectEntity(node.entity_id);
  }

  const tip = hovered ? byId.get(hovered) : null;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full min-h-0 min-w-0 overflow-hidden touch-none select-none bg-background"
    >
      <svg
        width={size.w}
        height={size.h}
        className="block cursor-grab active:cursor-grabbing"
        role="group"
        aria-label="Meetings graph"
        onPointerDown={(e) => onPointerDown(e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <marker
            id="mtg-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerUnits="userSpaceOnUse"
            markerWidth="9"
            markerHeight="9"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 z" className="fill-foreground/60" />
          </marker>
        </defs>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {layout.groups.map((g) => (
            <g key={g.key} className="pointer-events-none">
              <circle
                cx={g.x}
                cy={g.y}
                r={g.r}
                className="fill-muted/40 stroke-border"
                strokeDasharray="3 4"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={g.x}
                y={g.y - g.r - 7}
                textAnchor="middle"
                fontSize={12 / Math.min(1, view.k)}
                className="fill-muted-foreground font-medium"
              >
                {truncate(g.label, 28)}
                <tspan className="fill-muted-foreground/60"> · {g.count}</tspan>
              </text>
            </g>
          ))}

          {layout.edges.map((e, i) => {
            const a = byId.get(e.source);
            const b = byId.get(e.target);
            if (!a || !b) return null;
            const on =
              !lit ||
              (lit.has(a.id) &&
                lit.has(b.id) &&
                (a.id === anchorId || b.id === anchorId));
            const second =
              !!lit &&
              !on &&
              ((lit.has(a.id) && linked.has(b.id)) ||
                (lit.has(b.id) && linked.has(a.id)));
            const explicit = e.kind === "follow_up" || e.kind === "related";
            // A link leaving its cluster (your own team sits in every
            // company's meetings), or out to a project hub, is context rather
            // than structure — keep it faint until its node is in play.
            const ga = layout.groupOf.get(a.id);
            const gb = layout.groupOf.get(b.id);
            const crossing =
              !explicit &&
              (e.kind === "project" ||
                (layout.groups.length > 0 && (!ga || !gb || ga !== gb)));
            // Stop the line at the node's edge so the arrowhead is visible.
            const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const tx = b.x - ((b.x - a.x) / len) * (b.r + 3);
            const ty = b.y - ((b.y - a.y) / len) * (b.r + 3);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={explicit ? tx : b.x}
                y2={explicit ? ty : b.y}
                vectorEffect="non-scaling-stroke"
                strokeWidth={explicit ? 1.5 : 1}
                strokeDasharray={
                  e.kind === "mentioned"
                    ? "2 3"
                    : e.kind === "works_at"
                      ? "1 3"
                      : undefined
                }
                markerEnd={
                  e.kind === "follow_up" ? "url(#mtg-arrow)" : undefined
                }
                className={cn(
                  "transition-opacity",
                  explicit
                    ? "stroke-foreground/60"
                    : crossing
                      ? "stroke-foreground/10"
                      : "stroke-foreground/25",
                  lit &&
                    (on
                      ? "stroke-foreground/70"
                      : second
                        ? "stroke-foreground/30"
                        : "opacity-15"),
                )}
              />
            );
          })}

          {nodes.map((n) => {
            const isLit = !lit || lit.has(n.id);
            const isAnchor = n.id === anchorId;
            const selected = n.type === "meeting" && n.key === selectedKey;
            const showLabel =
              n.type !== "meeting" ||
              view.k >= LABEL_ZOOM ||
              (lit != null && isLit) ||
              selected;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                role="button"
                tabIndex={0}
                aria-label={`${n.type}: ${n.label}`}
                className={cn(
                  "cursor-pointer outline-none transition-opacity [&:focus-visible>.ring]:opacity-100",
                  !isLit && (linked.has(n.id) ? "opacity-70" : "opacity-15"),
                )}
                onPointerDown={(e) => onPointerDown(e, n.id)}
                onPointerEnter={() => setHovered(n.id)}
                onPointerLeave={() =>
                  setHovered((h) => (h === n.id ? null : h))
                }
                onFocus={() => setHovered(n.id)}
                onBlur={() => setHovered((h) => (h === n.id ? null : h))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate(n);
                  }
                }}
              >
                {/* Generous invisible hit area — meeting dots are only 12px. */}
                <circle r={Math.max(n.r + 6, 14 / view.k)} fill="transparent" />
                <circle
                  r={n.r + 5}
                  className={cn(
                    "ring fill-none stroke-ring opacity-0",
                    (selected || (isAnchor && !hovered)) && "opacity-100",
                  )}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
                <NodeShape node={n} dark={dark} />
                {showLabel && (
                  <text
                    y={n.r + 12}
                    textAnchor="middle"
                    // Names stay legible when the fit zooms out; they stop
                    // growing once it would be louder than the picture.
                    fontSize={
                      (n.type === "meeting" ? 10 : 11) /
                      Math.max(0.7, Math.min(1, view.k))
                    }
                    className={cn(
                      "pointer-events-none fill-foreground [paint-order:stroke] stroke-background",
                      n.type === "meeting"
                        ? "fill-foreground/80"
                        : "font-medium",
                    )}
                    strokeWidth={3}
                    strokeLinejoin="round"
                  >
                    {truncate(n.label, n.type === "meeting" ? 26 : 22)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md"
          style={{
            left: Math.min(
              Math.max(tip.x * view.k + view.x, 90),
              Math.max(90, size.w - 90),
            ),
            top: tip.y * view.k + view.y + tip.r * view.k + 26,
          }}
        >
          <div className="text-[12px] font-medium leading-snug">
            {tip.label}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {tip.type === "meeting"
              ? `${CATEGORY_META[tip.category]?.label ?? tip.category} · ${format(new Date(tip.started_at), "d MMM yyyy")}`
              : tip.type === "project"
                ? "Project"
                : `${tip.type === "company" ? "Company" : "Person"} · ${tip.meeting_count} meeting${tip.meeting_count === 1 ? "" : "s"}`}
          </div>
        </div>
      )}

      <Legend dark={dark} graph={graph} />

      <div className="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-md border border-border bg-card shadow-sm max-lg:bottom-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {(
          [
            ["Zoom in", Plus, () => zoomAt(size.w / 2, size.h / 2, 1.35)],
            ["Zoom out", Minus, () => zoomAt(size.w / 2, size.h / 2, 1 / 1.35)],
            ["Fit to screen", Maximize2, fit],
          ] as const
        ).map(([label, Icon, run]) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            title={label}
            onClick={run}
            className="tap-target grid size-7 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** Shape carries the node *type*; color (meetings only) carries the category. */
function NodeShape({ node, dark }: { node: LaidOutNode; dark: boolean }) {
  const r = node.r;
  if (node.type === "meeting") {
    return (
      <circle
        r={r}
        fill={categoryColor(node.category, dark)}
        className="stroke-background"
        strokeWidth={2}
      />
    );
  }
  if (node.type === "project") {
    return (
      <rect
        x={-r * 0.8}
        y={-r * 0.8}
        width={r * 1.6}
        height={r * 1.6}
        rx={2}
        transform="rotate(45)"
        fill={node.color}
        className="stroke-background"
        strokeWidth={2}
      />
    );
  }
  const label = (
    <text
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={Math.max(8, r * 0.72)}
      className="pointer-events-none fill-foreground/80 font-medium"
    >
      {initials(node.label)}
    </text>
  );
  return node.type === "company" ? (
    <>
      <rect
        x={-r}
        y={-r}
        width={r * 2}
        height={r * 2}
        rx={5}
        className="fill-muted stroke-foreground/50"
        strokeWidth={1.5}
      />
      {label}
    </>
  ) : (
    <>
      <circle
        r={r}
        className="fill-card stroke-foreground/40"
        strokeWidth={1.5}
      />
      {label}
    </>
  );
}

function Legend({ graph, dark }: { graph: MeetingGraph; dark: boolean }) {
  const present = useMemo(() => {
    const seen = new Set<string>();
    for (const n of graph.nodes) if (n.type === "meeting") seen.add(n.category);
    return CATEGORY_ORDER.filter((c) => seen.has(c));
  }, [graph.nodes]);

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-4.5rem)] rounded-md border border-border bg-card/90 px-2.5 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur max-lg:bottom-[calc(0.75rem+env(safe-area-inset-bottom))]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {present.map((c) => (
          <span key={c} className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-full"
              style={{ background: categoryColor(c, dark) }}
            />
            {CATEGORY_META[c].label}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 pt-1.5">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-full border-[1.5px] border-foreground/40 bg-card" />
          Person
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-[3px] border-[1.5px] border-foreground/50 bg-muted" />
          Company
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rotate-45 rounded-[2px] bg-foreground/50" />
          Project
        </span>
      </div>
    </div>
  );
}
