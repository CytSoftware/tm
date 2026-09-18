"use client";

/**
 * Obsidian-style link graph for the LLM Wiki.
 *
 * Global mode shows every page; passing `focus` switches to a local graph of
 * the pages within `depth` hops of it (links treated as undirected, like
 * Obsidian). Import this through `next/dynamic` with `ssr: false` — force-graph
 * touches `window` at module load.
 *
 * Page kinds are told apart by shape + Lucide icon, not colour, so the graph
 * stays in the app's monochrome palette.
 */

import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
} from "react-force-graph-2d";
import {
  Building2,
  File,
  FileText,
  FolderKanban,
  Lightbulb,
  type LucideIcon,
  Minus,
  Package,
  Plus,
  Scale,
  Scan,
  User,
} from "lucide-react";
import { useTheme } from "next-themes";

import type { WikiGraph as WikiGraphData } from "@/hooks/use-knowledge";

// ── Kinds ────────────────────────────────────────────────────────────────────
type Shape = "circle" | "square" | "pentagon" | "diamond" | "hexagon" | "octagon" | "document";

const KINDS = {
  person: { label: "People", shape: "circle", icon: User },
  company: { label: "Companies", shape: "square", icon: Building2 },
  product: { label: "Products", shape: "pentagon", icon: Package },
  concept: { label: "Concepts", shape: "diamond", icon: Lightbulb },
  project: { label: "Projects", shape: "hexagon", icon: FolderKanban },
  decision: { label: "Decisions", shape: "octagon", icon: Scale },
  source: { label: "Sources", shape: "document", icon: FileText },
  other: { label: "Other", shape: "circle", icon: File },
} satisfies Record<string, { label: string; shape: Shape; icon: LucideIcon }>;
type Kind = keyof typeof KINDS;

const FOLDER_KIND: Record<string, Kind> = {
  people: "person",
  companies: "company",
  products: "product",
  concepts: "concept",
  projects: "project",
  decisions: "decision",
  sources: "source",
};

/** `entities/people/x` → person, `concepts/x` → concept, `x` → other. */
function kindOf(slug: string): Kind {
  const parts = slug.split("/");
  const folder = parts[0] === "entities" && parts.length > 2 ? parts[1] : parts.length > 1 ? parts[0] : "";
  return FOLDER_KIND[folder] ?? "other";
}

// ── Palette (mirrors the neutral tokens in globals.css) ─────────────────────
const PALETTE = {
  light: {
    fill: "#ffffff",
    stroke: "#d4d4d4",
    muted: "#737373",
    strong: "#171717",
    bg: "#fcfcfc",
    link: "rgba(0,0,0,0.10)",
    linkLit: "rgba(0,0,0,0.55)",
  },
  dark: {
    fill: "#1f1f1f",
    stroke: "#3d3d3d",
    muted: "#a3a3a3",
    strong: "#f5f5f5",
    bg: "#111111",
    link: "rgba(255,255,255,0.10)",
    linkLit: "rgba(255,255,255,0.55)",
  },
};
type Palette = (typeof PALETTE)["light"];
// Icons are rasterised once per theme at 64px so they stay crisp when zoomed.
// Nodes are solid foreground, so icons are drawn in the background colour.
const iconCache = new Map<string, HTMLImageElement>();
function iconKey(kind: Kind, dark: boolean) {
  return `${kind}:${dark ? "d" : "l"}`;
}
function loadIcons(dark: boolean): Promise<unknown> {
  const color = (dark ? PALETTE.dark : PALETTE.light).fill;
  const loads: Promise<void>[] = [];
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const key = iconKey(kind, dark);
    if (iconCache.has(key)) continue;
    const svg = renderToStaticMarkup(
      createElement(KINDS[kind].icon, { size: 64, color, strokeWidth: 2 }),
    );
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    iconCache.set(key, img);
    loads.push(img.decode().catch(() => {}));
  }
  return Promise.all(loads);
}

// ── Drawing ──────────────────────────────────────────────────────────────────
function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i) ctx.lineTo(px, py);
    else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, r: number) {
  switch (shape) {
    case "circle":
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      return;
    case "square":
      ctx.beginPath();
      ctx.roundRect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8, r * 0.4);
      return;
    case "document":
      ctx.beginPath();
      ctx.roundRect(x - r * 0.78, y - r, r * 1.56, r * 2, r * 0.3);
      return;
    case "diamond":
      return polygon(ctx, x, y, r * 1.2, 4, -Math.PI / 2);
    case "pentagon":
      return polygon(ctx, x, y, r * 1.08, 5, -Math.PI / 2);
    case "hexagon":
      return polygon(ctx, x, y, r * 1.05, 6, 0);
    case "octagon":
      return polygon(ctx, x, y, r * 1.02, 8, Math.PI / 8);
  }
}

/** One node: solid shape + centred icon. The focused page gets an outer ring;
 *  `scale` keeps the ring 1.5 screen px at any zoom. */
function drawNode(
  ctx: CanvasRenderingContext2D,
  kind: Kind,
  x: number,
  y: number,
  r: number,
  scale: number,
  p: Palette,
  dark: boolean,
  focus: boolean,
) {
  shapePath(ctx, KINDS[kind].shape, x, y, r);
  ctx.fillStyle = p.strong;
  ctx.fill();
  if (focus) {
    shapePath(ctx, KINDS[kind].shape, x, y, r + 4 / scale);
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = p.strong;
    ctx.stroke();
  }
  const img = iconCache.get(iconKey(kind, dark));
  const s = r * 1.05;
  if (img?.complete) ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
}

// ── Component ────────────────────────────────────────────────────────────────
type Node = { id: string; title: string; kind: Kind; degree: number };
type Link = { source: string | Node; target: string | Node };

const endId = (end: string | Node) => (typeof end === "string" ? end : end.id);
const EMPTY = { nodes: [] as Node[], links: [] as Link[] };
// A small graph fits at a huge zoom; cap it so nodes keep a sane size. The
// local graph has few nodes, so it may zoom further to fill its pane.
const MAX_FIT_ZOOM = { global: 1.6, local: 2.4 };
const CONTROLS = [
  { icon: Plus, label: "Zoom in", zoom: 1.4 },
  { icon: Minus, label: "Zoom out", zoom: 1 / 1.4 },
  { icon: Scan, label: "Fit to view", zoom: 0 },
];

export default function WikiGraph({
  data,
  focus,
  depth = 1,
  onSelect,
}: {
  data: WikiGraphData;
  focus?: string;
  depth?: number;
  onSelect: (slug: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<Node, Link> | undefined>(undefined);
  const fitted = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [iconsFor, setIconsFor] = useState<boolean | null>(null);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const p = dark ? PALETTE.dark : PALETTE.light;

  useEffect(() => {
    let cancelled = false;
    loadIcons(dark).then(() => !cancelled && setIconsFor(dark));
    return () => {
      cancelled = true;
    };
  }, [dark]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) =>
      setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    for (const n of data.nodes) adj.set(n.id, new Set());
    for (const l of data.links) {
      adj.get(l.source)?.add(l.target);
      adj.get(l.target)?.add(l.source);
    }
    return adj;
  }, [data]);

  // Fresh objects every time: force-graph mutates nodes (x/y) and rewrites
  // link ends into node references, so two graphs must not share them.
  const graphData = useMemo(() => {
    let keep: Set<string> | null = null;
    if (focus) {
      keep = new Set([focus]);
      let frontier = [focus];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const id of frontier)
          for (const nb of adjacency.get(id) ?? [])
            if (!keep.has(nb)) {
              keep.add(nb);
              next.push(nb);
            }
        frontier = next;
      }
    }
    const nodes: Node[] = data.nodes
      .filter((n) => !keep || keep.has(n.id))
      .map((n) => ({ id: n.id, title: n.title, kind: kindOf(n.id), degree: adjacency.get(n.id)?.size ?? 0 }));
    const links: Link[] = data.links
      .filter((l) => !keep || (keep.has(l.source) && keep.has(l.target)))
      .map((l) => ({ ...l }));
    return { nodes, links };
  }, [data, focus, depth, adjacency]);

  // Not gated on icons: remounting on a theme switch would drop the forces.
  // `iconsFor` changing re-renders, which repaints once the icons decode.
  const ready = size.w > 0 && size.h > 0;

  // Forces must be set before the data arrives, because the layout settles
  // during warm-up (before the first paint) — hence the empty first render.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    fg.d3Force("charge")?.strength(focus ? -140 : -160);
    fg.d3Force("link")?.distance(focus ? 50 : 55);
    const id = requestAnimationFrame(() => setLive(true));
    return () => cancelAnimationFrame(id);
  }, [ready, focus]);

  useEffect(() => {
    fitted.current = false;
  }, [graphData]);

  function fit(ms = 0) {
    const fg = fgRef.current;
    if (!fg) return;
    fg.zoomToFit(ms, 48);
    const max = focus ? MAX_FIT_ZOOM.local : MAX_FIT_ZOOM.global;
    if (fg.zoom() > max) fg.zoom(max, ms);
  }

  // Refit when the pane changes size (e.g. the file tree is toggled).
  useEffect(() => {
    if (fitted.current) fit(200);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on resize
  }, [size.w, size.h]);

  /** `factor` 0 means fit-to-view. */
  function zoomBy(factor: number) {
    const fg = fgRef.current;
    if (!fg) return;
    if (factor) fg.zoom(fg.zoom() * factor, 200);
    else fit(300);
  }

  const neighbours = hover ? adjacency.get(hover) : undefined;
  const isLit = (id: string) => !hover || id === hover || !!neighbours?.has(id);
  const touchesHover = (l: Link) => !!hover && (endId(l.source) === hover || endId(l.target) === hover);
  const radius = (n: Node) => 7 + Math.sqrt(n.degree) * 1.3;
  // Hubs (top ~15% by links) keep their label at the fitted zoom; the rest
  // fade in as you zoom, so the overview isn't a wall of text.
  const hubCut = useMemo(() => {
    const d = graphData.nodes.map((n) => n.degree).sort((a, b) => b - a);
    return d[Math.floor(d.length * 0.15)] ?? Infinity;
  }, [graphData]);
  const kinds = useMemo(
    () => (Object.keys(KINDS) as Kind[]).filter((k) => graphData.nodes.some((n) => n.kind === k)),
    [graphData],
  );

  return (
    <div ref={boxRef} className="relative h-full w-full min-h-0 min-w-0 overflow-hidden">
      {ready && (
        <ForceGraph2D<Node, Link>
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={live ? graphData : EMPTY}
          warmupTicks={300}
          cooldownTime={3000}
          minZoom={0.2}
          maxZoom={8}
          onEngineTick={() => {
            if (fitted.current || !live || !graphData.nodes.length) return;
            fitted.current = true;
            fit();
          }}
          onNodeHover={(n) => setHover(n?.id ?? null)}
          onNodeClick={(n) => onSelect(n.id)}
          linkColor={(l) => (touchesHover(l) ? p.linkLit : hover ? "transparent" : p.link)}
          linkWidth={(l) => (touchesHover(l) ? 1.2 : 0.7)}
          nodePointerAreaPaint={(n: NodeObject<Node>, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, radius(n) * 1.15, 0, 2 * Math.PI);
            ctx.fill();
          }}
          nodeCanvasObject={(n: NodeObject<Node>, ctx, scale) => {
            const x = n.x ?? 0;
            const y = n.y ?? 0;
            const r = radius(n);
            const lit = isLit(n.id);
            ctx.globalAlpha = lit ? 1 : 0.2;
            drawNode(ctx, n.kind, x, y, r, scale, p, dark, n.id === focus);
            // Labels fade in with zoom (Obsidian-style); always shown for the
            // focused page, hubs, and the hovered neighbourhood.
            const labelAlpha =
              n.id === focus || (hover && lit) || (!hover && n.degree > hubCut)
                ? 1
                : Math.min(1, Math.max(0, (scale - 1.8) / 0.8));
            if (labelAlpha > 0 && lit) {
              ctx.globalAlpha = labelAlpha;
              ctx.font = `500 ${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              const ty = y + r * 1.25 + 3 / scale;
              ctx.lineWidth = 3 / scale;
              ctx.strokeStyle = p.bg;
              ctx.strokeText(n.title, x, ty);
              ctx.fillStyle = hover === n.id || n.id === focus ? p.strong : p.muted;
              ctx.fillText(n.title, x, ty);
            }
            ctx.globalAlpha = 1;
          }}
        />
      )}

      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-md border border-border bg-background/80 shadow-sm backdrop-blur">
        {CONTROLS.map(({ icon: Icon, label, zoom }) => (
          <button
            key={label}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => zoomBy(zoom)}
            className="tap-target grid size-7 place-items-center text-muted-foreground hover:bg-accent hover:text-foreground [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border"
          >
            <Icon className="size-3.5" />
          </button>
        ))}
      </div>

      {!focus && kinds.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-x-3 gap-y-1.5 rounded-md border border-border bg-background/80 px-2.5 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          {kinds.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <KindSwatch kind={k} dark={dark} ready={iconsFor === dark} />
              {KINDS[k].label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Legend swatch drawn with the same `drawNode` as the graph. */
function KindSwatch({ kind, dark, ready }: { kind: Kind; dark: boolean; ready: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !ready) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = 18 * dpr;
    c.height = 18 * dpr;
    ctx.scale(dpr, dpr);
    drawNode(ctx, kind, 9, 9, 7, 1, dark ? PALETTE.dark : PALETTE.light, dark, false);
  }, [kind, dark, ready]);
  return <canvas ref={ref} className="size-[18px] shrink-0" />;
}
