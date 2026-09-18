/**
 * Force layout for the meetings graph.
 *
 * The simulation is run **synchronously to completion** and the result handed
 * to React as plain coordinates — it is not animated. Three reasons: the
 * picture is stable (nothing drifts while you're trying to click it), it is
 * deterministic (d3-force seeds its own RNG, so the same data lands in the
 * same place on every visit), and it doesn't depend on `requestAnimationFrame`,
 * which browsers freeze in background tabs.
 *
 * Grouping is a layout concern, not a data one: `groupBy` assigns each node a
 * group key, the groups get anchor points, and an extra x/y force pulls
 * members toward their anchor. The enclosing circles are measured afterwards.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { format } from "date-fns";

import type { GraphEdge, GraphNode, MeetingGraph } from "@/hooks/use-meetings";
import { CATEGORY_META } from "@/lib/meeting-meta";

export type GroupBy = "none" | "company" | "project" | "category" | "month";

export type LaidOutNode = GraphNode & { x: number; y: number; r: number };

export type GraphGroup = {
  key: string;
  label: string;
  x: number;
  y: number;
  r: number;
  count: number;
};

export type GraphLayout = {
  nodes: LaidOutNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  /** node id → group key, for telling within-group links from crossing ones. */
  groupOf: Map<string, string>;
  /** id → ids of directly connected nodes, for hover highlighting. */
  neighbors: Map<string, Set<string>>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

type SimNode = SimulationNodeDatum & {
  id: string;
  r: number;
  group: string | null;
  /** Always-on label underneath, so it needs more elbow room. */
  labelled: boolean;
};

const UNGROUPED = "__none__";

export function nodeRadius(node: GraphNode): number {
  if (node.type === "meeting") return 6;
  if (node.type === "project") return 13;
  // Entities grow with how many meetings they're in, within a tight range so
  // one busy person doesn't dwarf the picture.
  const bump = Math.min(8, Math.sqrt(node.meeting_count) * 2.5);
  return (node.type === "company" ? 12 : 9) + bump;
}

/** Which group each node belongs to, plus a display label per group. */
function assignGroups(
  graph: MeetingGraph,
  groupBy: GroupBy,
): { of: Map<string, string>; labels: Map<string, string> } {
  const of = new Map<string, string>();
  const labels = new Map<string, string>();
  if (groupBy === "none") return { of, labels };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = out.get(e.source);
    if (list) list.push(e);
    else out.set(e.source, [e]);
  }

  const companyOf = (entityId: string): string | null => {
    const node = byId.get(entityId);
    if (!node) return null;
    if (node.type === "company") return entityId;
    const employer = out.get(entityId)?.find((e) => e.kind === "works_at");
    return employer?.target ?? null;
  };

  // How many meetings each company touches, directly or through its people.
  const reach = new Map<string, number>();
  if (groupBy === "company") {
    for (const node of graph.nodes) {
      if (node.type !== "meeting") continue;
      const seen = new Set<string>();
      for (const e of out.get(node.id) ?? []) {
        const company = e.kind === "attendee" ? companyOf(e.target) : null;
        if (company) seen.add(company);
      }
      for (const c of seen) reach.set(c, (reach.get(c) ?? 0) + 1);
    }
  }

  for (const node of graph.nodes) {
    let key: string | null = null;
    if (node.type === "meeting") {
      if (groupBy === "category") {
        key = node.category;
        labels.set(key, CATEGORY_META[node.category]?.label ?? node.category);
      } else if (groupBy === "month") {
        const d = new Date(node.started_at);
        key = format(d, "yyyy-MM");
        labels.set(key, format(d, "MMM yyyy"));
      } else if (groupBy === "project") {
        key =
          out.get(node.id)?.find((e) => e.kind === "project")?.target ?? null;
      } else if (groupBy === "company") {
        // Attendees decide it; a company that was only mentioned doesn't. Of
        // the companies in the room, the *rarest* one wins: your own company
        // is in every meeting, so it would otherwise swallow them all, and
        // "the Acme call" is how people think of it anyway.
        const candidates = new Set<string>();
        for (const e of out.get(node.id) ?? []) {
          if (e.kind !== "attendee") continue;
          const company = companyOf(e.target);
          if (company) candidates.add(company);
        }
        key =
          [...candidates].sort(
            (a, b) =>
              (reach.get(a) ?? 0) - (reach.get(b) ?? 0) || a.localeCompare(b),
          )[0] ?? null;
      }
    } else if (groupBy === "company" && node.type !== "project") {
      key = companyOf(node.id);
    } else if (groupBy === "project" && node.type === "project") {
      key = node.id;
    }
    if (key && !labels.has(key)) labels.set(key, byId.get(key)?.label ?? key);
    // Only meetings fall back to an "ungrouped" cluster; a person with no
    // company just floats between the meetings they were in.
    if (!key && node.type === "meeting") {
      key = UNGROUPED;
      labels.set(
        key,
        groupBy === "company"
          ? "No company"
          : groupBy === "project"
            ? "No project"
            : "Other",
      );
    }
    if (key) of.set(node.id, key);
  }
  return { of, labels };
}

/** Anchor points on a ring, biggest groups first, spaced by their size. */
function groupAnchors(
  sizes: Map<string, number>,
  /** Nodes in no group; they settle in the middle, so the ring makes room. */
  freeNodes: number,
): Map<string, { x: number; y: number }> {
  const keys = [...sizes.keys()].sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    return sizes.get(b)! - sizes.get(a)! || a.localeCompare(b);
  });
  const anchors = new Map<string, { x: number; y: number }>();
  if (keys.length === 1) {
    anchors.set(keys[0], { x: 0, y: 0 });
    return anchors;
  }
  const footprint = (k: string) => 80 + Math.sqrt(sizes.get(k)!) * 46;
  const circumference = keys.reduce((sum, k) => sum + footprint(k) * 2, 0);
  const hub = freeNodes ? 120 + Math.sqrt(freeNodes) * 55 : 0;
  const largest = Math.max(...keys.map(footprint));
  const ring = Math.max(220, circumference / (2 * Math.PI), hub + largest);
  let angle = -Math.PI / 2;
  for (const k of keys) {
    const half = (footprint(k) / circumference) * 2 * Math.PI;
    angle += half;
    anchors.set(k, { x: Math.cos(angle) * ring, y: Math.sin(angle) * ring });
    angle += half;
  }
  return anchors;
}

export function layoutGraph(
  graph: MeetingGraph,
  groupBy: GroupBy,
): GraphLayout {
  const { of: groupOf, labels } = assignGroups(graph, groupBy);
  const sizes = new Map<string, number>();
  for (const key of groupOf.values()) sizes.set(key, (sizes.get(key) ?? 0) + 1);
  // The number shown on a cluster is its meetings, not its nodes.
  const meetingCounts = new Map<string, number>();
  for (const n of graph.nodes) {
    const key = n.type === "meeting" ? groupOf.get(n.id) : undefined;
    if (key) meetingCounts.set(key, (meetingCounts.get(key) ?? 0) + 1);
  }
  const anchors = groupAnchors(
    sizes,
    groupBy === "none" ? 0 : graph.nodes.length - groupOf.size,
  );

  const simNodes: SimNode[] = graph.nodes.map((n) => {
    const group = groupOf.get(n.id) ?? null;
    const anchor = group ? anchors.get(group) : undefined;
    return {
      id: n.id,
      r: nodeRadius(n),
      group,
      labelled: n.type !== "meeting",
      x: anchor?.x,
      y: anchor?.y,
    };
  });
  const ids = new Set(simNodes.map((n) => n.id));
  const links: SimulationLinkDatum<SimNode>[] = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

  const grouped = groupBy !== "none";
  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((n) => n.id)
        .distance(grouped ? 46 : 62)
        // Links inside a cluster hold it together. Anything else — across
        // clusters, or out to a node that belongs to none (a person, when
        // grouping by category) — must stay too weak to drag meetings out of
        // their cluster; it only decides where the free node settles.
        .strength((l) => {
          if (!grouped) return 0.5;
          const a = (l.source as SimNode).group;
          const b = (l.target as SimNode).group;
          if (a && b) return a === b ? 0.5 : 0.02;
          return 0.08;
        }),
    )
    .force(
      "charge",
      forceManyBody<SimNode>().strength((n) =>
        !grouped ? -240 : n.group ? -150 : -420,
      ),
    )
    .force(
      "collide",
      forceCollide<SimNode>((n) => n.r + (n.labelled ? 20 : 6)).iterations(3),
    )
    .force(
      "x",
      forceX<SimNode>((n) => (n.group ? anchors.get(n.group)!.x : 0)).strength(
        (n) => (n.group ? 0.4 : 0.03),
      ),
    )
    .force(
      "y",
      forceY<SimNode>((n) => (n.group ? anchors.get(n.group)!.y : 0)).strength(
        (n) => (n.group ? 0.4 : 0.03),
      ),
    )
    .stop();
  sim.tick(320);

  const pos = new Map(simNodes.map((n) => [n.id, n]));
  const nodes: LaidOutNode[] = graph.nodes.map((n) => {
    const p = pos.get(n.id)!;
    return { ...n, x: p.x ?? 0, y: p.y ?? 0, r: p.r };
  });

  // Enclosing circle per group: centroid + farthest member.
  const groups: GraphGroup[] = [];
  for (const key of sizes.keys()) {
    const count = meetingCounts.get(key) ?? 0;
    const members = simNodes.filter((n) => n.group === key);
    const cx = members.reduce((s, n) => s + (n.x ?? 0), 0) / members.length;
    const cy = members.reduce((s, n) => s + (n.y ?? 0), 0) / members.length;
    const r = Math.max(
      ...members.map((n) => Math.hypot((n.x ?? 0) - cx, (n.y ?? 0) - cy) + n.r),
    );
    groups.push({
      key,
      label: labels.get(key) ?? key,
      x: cx,
      y: cy,
      r: r + 18,
      count,
    });
  }

  const neighbors = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    (
      neighbors.get(e.source) ??
      neighbors.set(e.source, new Set()).get(e.source)!
    ).add(e.target);
    (
      neighbors.get(e.target) ??
      neighbors.set(e.target, new Set()).get(e.target)!
    ).add(e.source);
  }

  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const pad = 60;
  const bounds = nodes.length
    ? {
        minX: Math.min(...xs, ...groups.map((g) => g.x - g.r)) - pad,
        minY: Math.min(...ys, ...groups.map((g) => g.y - g.r)) - pad,
        maxX: Math.max(...xs, ...groups.map((g) => g.x + g.r)) + pad,
        maxY: Math.max(...ys, ...groups.map((g) => g.y + g.r)) + pad,
      }
    : { minX: -200, minY: -200, maxX: 200, maxY: 200 };

  return {
    nodes,
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    groups,
    groupOf,
    neighbors,
    bounds,
  };
}
