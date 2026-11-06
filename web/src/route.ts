// Loop and sweep builder over the edge graph, run in route.worker.ts.
//
// Nodes are the OSM node ids at edge ends (`a`/`b`), edges are the features,
// undirected. Edge cost = length × 4 when ridden × 2 when bonus × (1 − k × heat)
// (PLAN.md, route), so the cheapest path prefers unridden roads, uses a track only to
// reach one, and with "prefer bike heat" k > 0 bends towards roads other cyclists ride
// (heat 0..1 from the Strava heatmap: the edges' `tr` for road, max(ROAD_SHARE × `tr`,
// `tg`) for gravel, the same with `to` for off-road). In gravel and off-road mode a
// track or path whose own heat is at least POPULAR_HEAT counts as a road: no bonus
// factor, and a destination like an unridden road. Roads only sets bonus edges to
// Infinity; "skip where no one rides" does that for every edge inside the heat bbox
// whose heat in the chosen mode is 0. A loop goes out to the best unridden cluster in
// reach and back with the outbound edges penalised again, so it closes without
// retracing. A sweep instead rides every unridden edge it can reach, nearest first,
// and heads home when the distance is used up.

import { P } from "./data";

export type LonLat = [number, number];

interface EdgeFeature {
  geometry: { coordinates: number[][] };
  properties: Record<string, unknown>;
}
export interface EdgeCollection {
  features: EdgeFeature[];
}

const COUNTABLE = 1;
const RIDDEN = 2;
/** Both ends inside the heat bbox, so no heat means no cyclist, not no data. */
const IN_HEAT = 4;
/** Bonus edge with gravel (8) or off-road (16) heat of at least POPULAR_HEAT: a road in that mode. */
const TRACK: Record<HeatMode, number> = { road: 0, gravel: 8, offroad: 16 };
const RIDDEN_FACTOR = 4;
const BONUS_FACTOR = 2;
/** Smallest outbound length, as a share of the target, a turnaround cluster must reach. */
const MIN_TURN = 0.35;
/** Smallest angle, seen from the start, between the clusters of successive "try another" loops. */
const MIN_SPREAD = Math.PI / 4;
/** Highest heat preference, so every edge keeps a positive cost. */
export const MAX_HEAT_K = 0.9;
/** Edge heat (0..1) from which an edge counts as one cyclists use. */
const POPULAR_HEAT = 0.25;

/**
 * Which heat the route prefers: the Ride layer, or the larger of ROAD_SHARE of it and
 * gravel − road, or of ROAD_SHARE of it and (gravel + mtb) − road.
 */
export type HeatMode = "road" | "gravel" | "offroad";
const HEAT_KEYS: Record<HeatMode, string> = { road: P.roadHeat, gravel: P.gravelHeat, offroad: P.offroadHeat };
const HEAT_MODES = Object.keys(HEAT_KEYS) as HeatMode[];
/**
 * Road heat's weight in gravel and off-road mode: popular roads still beat dead ones,
 * but a busy gravel track beats a busy asphalt road, so the modes stay apart.
 */
const ROAD_SHARE = 0.5;

export interface Graph {
  nodes: number;
  edges: number;
  lon: Float64Array;
  lat: Float64Array;
  /** CSR adjacency: edges of node n are adjEdge[adjStart[n] .. adjStart[n + 1]]. */
  adjStart: Int32Array;
  adjEdge: Int32Array;
  edgeA: Int32Array;
  edgeB: Int32Array;
  edgeLen: Float64Array;
  edgeFlags: Uint8Array;
  /** Heat 0..1 per edge for each mode, 0 where the edge files carry none. */
  edgeHeat: Record<HeatMode, Float32Array>;
  /** True when any edge has heat, so "prefer bike heat" means something. */
  hasHeat: boolean;
  /** True when any edge lies in the heat bbox, so "skip where no one rides" means something. */
  hasDead: boolean;
  /** Geometry of edge e is coords[2 * coordStart[e] .. 2 * coordStart[e + 1]], from a to b. */
  coordStart: Int32Array;
  coords: Float64Array;
  /** Built on first use: costs per options, usable edges and their components per options, clusters per mode. */
  costs: Map<string, Float64Array>;
  views: Map<string, View>;
  clusterSets: Map<HeatMode, Clusters>;
}

interface Components {
  /** Component per node, and each component's length in metres. */
  node: Int32Array;
  len: Float64Array;
}

/** The edges a route may use under some options, and the components they form. */
interface View {
  usable: Uint8Array;
  comp: Components;
}

/** Connected components of the destination edges of a mode: cluster per edge, -1 for the rest. */
interface Clusters {
  edge: Int32Array;
  count: number;
}

/**
 * Collects edge files one at a time so each parsed file can be dropped after `add`.
 * `heatBBox` is where match sampled heat; without it no edge counts as one no one rides.
 */
export class GraphBuilder {
  constructor(private heatBBox?: [number, number, number, number]) {}

  private nodeIndex = new Map<number, number>();
  private lon: number[] = [];
  private lat: number[] = [];
  private a: number[] = [];
  private b: number[] = [];
  private len: number[] = [];
  private flags: number[] = [];
  private heat: Record<HeatMode, number[]> = { road: [], gravel: [], offroad: [] };
  private coordStart: number[] = [0];
  private coords: number[] = [];

  private node(id: number, c: number[]): number {
    let n = this.nodeIndex.get(id);
    if (n === undefined) {
      n = this.lon.length;
      this.nodeIndex.set(id, n);
      this.lon.push(c[0]!);
      this.lat.push(c[1]!);
    }
    return n;
  }

  private inHeat(c: number[]): boolean {
    const bb = this.heatBBox;
    return !!bb && c[0]! >= bb[0] && c[1]! >= bb[1] && c[0]! <= bb[2] && c[1]! <= bb[3];
  }

  add(fc: EdgeCollection): void {
    for (const f of fc.features) {
      const p = f.properties;
      const from = p[P.from] as number | undefined;
      const to = p[P.to] as number | undefined;
      const cs = f.geometry.coordinates;
      if (from == null || to == null || cs.length < 2) continue;
      this.a.push(this.node(from, cs[0]!));
      this.b.push(this.node(to, cs[cs.length - 1]!));
      this.len.push(p[P.length] as number);
      const countable = p[P.countable] === 1;
      let flags = (countable ? COUNTABLE : 0) | (p[P.firstDate] ? RIDDEN : 0);
      if (this.inHeat(cs[0]!) && this.inHeat(cs[cs.length - 1]!)) flags |= IN_HEAT;
      const road = ((p[HEAT_KEYS.road] as number | undefined) ?? 0) / 100;
      for (const m of HEAT_MODES) {
        const own = ((p[HEAT_KEYS[m]] as number | undefined) ?? 0) / 100;
        this.heat[m].push(m === "road" ? road : Math.max(ROAD_SHARE * road, own));
        if (!countable && m !== "road" && own >= POPULAR_HEAT) flags |= TRACK[m];
      }
      this.flags.push(flags);
      for (const c of cs) this.coords.push(c[0]!, c[1]!);
      this.coordStart.push(this.coords.length / 2);
    }
  }

  finish(): Graph {
    const nodes = this.lon.length;
    const edges = this.a.length;
    const edgeA = Int32Array.from(this.a);
    const edgeB = Int32Array.from(this.b);
    const edgeFlags = Uint8Array.from(this.flags);
    const edgeHeat = Object.fromEntries(HEAT_MODES.map((m) => [m, Float32Array.from(this.heat[m])])) as Record<HeatMode, Float32Array>;

    const adjStart = new Int32Array(nodes + 1);
    for (let e = 0; e < edges; e++) {
      adjStart[edgeA[e]! + 1]!++;
      adjStart[edgeB[e]! + 1]!++;
    }
    for (let n = 0; n < nodes; n++) adjStart[n + 1]! += adjStart[n]!;
    const fill = adjStart.slice(0, nodes);
    const adjEdge = new Int32Array(2 * edges);
    for (let e = 0; e < edges; e++) {
      adjEdge[fill[edgeA[e]!]!++] = e;
      adjEdge[fill[edgeB[e]!]!++] = e;
    }

    return {
      nodes,
      edges,
      lon: Float64Array.from(this.lon),
      lat: Float64Array.from(this.lat),
      adjStart,
      adjEdge,
      edgeA,
      edgeB,
      edgeLen: Float64Array.from(this.len),
      edgeFlags,
      edgeHeat,
      hasHeat: edgeHeat.road.some((h) => h > 0),
      hasDead: edgeFlags.some((f) => (f & IN_HEAT) !== 0),
      coordStart: Int32Array.from(this.coordStart),
      coords: Float64Array.from(this.coords),
      costs: new Map(),
      views: new Map(),
      clusterSets: new Map(),
    };
  }
}

export interface LoopOptions {
  km: number;
  variant: number;
  roadsOnly: boolean;
  /** Leave out edges in the heat bbox with no heat in the chosen mode. */
  skipDead: boolean;
  heatK: number;
  heatMode: HeatMode;
  /** A sweep through every unridden edge nearby instead of a loop to one cluster. */
  sweep: boolean;
}

/** An unridden edge the route aims for: a countable road, or in gravel and off-road mode a busy track. */
const isTarget = (f: number, mode: HeatMode) => !(f & RIDDEN) && ((f & COUNTABLE) !== 0 || (f & TRACK[mode]) !== 0);

/** No cyclist rides it in this mode, as far as the heatmap can tell. */
const isDead = (g: Graph, mode: HeatMode, e: number) => (g.edgeFlags[e]! & IN_HEAT) !== 0 && g.edgeHeat[mode][e] === 0;

function view(g: Graph, o: LoopOptions): View {
  const skipDead = o.skipDead && g.hasDead;
  const key = `${o.heatMode}|${o.roadsOnly}|${skipDead}`;
  let v = g.views.get(key);
  if (v) return v;
  const usable = new Uint8Array(g.edges);
  for (let e = 0; e < g.edges; e++) {
    const f = g.edgeFlags[e]!;
    usable[e] = (o.roadsOnly && !(f & COUNTABLE)) || (skipDead && isDead(g, o.heatMode, e)) ? 0 : 1;
  }
  v = { usable, comp: components(g, (e) => usable[e] === 1) };
  g.views.set(key, v);
  return v;
}

/** Edge costs for a route: see the header. */
function edgeCosts(g: Graph, o: LoopOptions, k: number): Float64Array {
  const key = `${o.heatMode}|${o.roadsOnly}|${o.skipDead && g.hasDead}|${k}`;
  let cost = g.costs.get(key);
  if (cost) return cost;
  const { usable } = view(g, o);
  const heat = g.edgeHeat[o.heatMode];
  const track = TRACK[o.heatMode];
  cost = new Float64Array(g.edges);
  for (let e = 0; e < g.edges; e++) {
    const f = g.edgeFlags[e]!;
    const bonus = !(f & COUNTABLE) && !(f & track);
    cost[e] = usable[e] ? g.edgeLen[e]! * (f & RIDDEN ? RIDDEN_FACTOR : 1) * (bonus ? BONUS_FACTOR : 1) * (1 - k * heat[e]!) : Infinity;
  }
  g.costs.set(key, cost);
  return cost;
}

function clusters(g: Graph, mode: HeatMode): Clusters {
  let c = g.clusterSets.get(mode);
  if (c) return c;
  const target = (e: number) => isTarget(g.edgeFlags[e]!, mode);
  const root = unionFind(g.nodes, g.edges, g.edgeA, g.edgeB, target);
  const edge = new Int32Array(g.edges).fill(-1);
  const ids = new Map<number, number>();
  for (let e = 0; e < g.edges; e++) {
    if (!target(e)) continue;
    const r = root(g.edgeA[e]!);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    edge[e] = id;
  }
  c = { edge, count: ids.size };
  g.clusterSets.set(mode, c);
  return c;
}

/** Components over the edges `use` accepts; a node no such edge touches is its own component of length 0. */
function components(g: Graph, use: (e: number) => boolean): Components {
  const root = unionFind(g.nodes, g.edges, g.edgeA, g.edgeB, use);
  const node = new Int32Array(g.nodes);
  const ids = new Map<number, number>();
  for (let n = 0; n < g.nodes; n++) {
    const r = root(n);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    node[n] = id;
  }
  const len = new Float64Array(ids.size);
  for (let e = 0; e < g.edges; e++) if (use(e)) len[node[g.edgeA[e]!]!]! += g.edgeLen[e]!;
  return { node, len };
}

/** Union-find over the nodes joined by the edges `use` accepts; returns the root lookup. */
function unionFind(nodes: number, edges: number, a: Int32Array, b: Int32Array, use: (e: number) => boolean): (n: number) => number {
  const parent = new Int32Array(nodes);
  for (let n = 0; n < nodes; n++) parent[n] = n;
  const find = (n: number): number => {
    while (parent[n] !== n) {
      parent[n] = parent[parent[n]!]!;
      n = parent[n]!;
    }
    return n;
  };
  for (let e = 0; e < edges; e++) {
    if (!use(e)) continue;
    const ra = find(a[e]!);
    const rb = find(b[e]!);
    if (ra !== rb) parent[ra] = rb;
  }
  return find;
}

/** Binary min-heap of nodes keyed by cost, with lazy deletion. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (k[up]! <= key) break;
      k[i] = k[up]!;
      v[i] = v[up]!;
      i = up;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0]!;
    const key = k.pop()!;
    const val = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1]! < k[c]!) c++;
        if (k[c]! >= key) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = key;
      v[i] = val;
    }
    return top;
  }
}

interface Tree {
  /** Cost and length of the cheapest path from the source; Infinity when not reached. */
  cost: Float64Array;
  len: Float64Array;
  /** Edge the cheapest path arrives by, -1 at the source and unreached nodes. */
  via: Int32Array;
}

/** Dijkstra from `source` under `cost`; paths longer than `maxLen` metres are cut, `target` stops early. */
function dijkstra(g: Graph, source: number, cost: Float64Array, maxLen = Infinity, target = -1): Tree {
  const dist = new Float64Array(g.nodes).fill(Infinity);
  const len = new Float64Array(g.nodes).fill(Infinity);
  const via = new Int32Array(g.nodes).fill(-1);
  const done = new Uint8Array(g.nodes);
  const heap = new Heap();
  dist[source] = 0;
  len[source] = 0;
  heap.push(0, source);
  while (heap.size) {
    const n = heap.pop();
    if (done[n]) continue;
    done[n] = 1;
    if (n === target) break;
    for (let i = g.adjStart[n]!; i < g.adjStart[n + 1]!; i++) {
      const e = g.adjEdge[i]!;
      const m = g.edgeA[e] === n ? g.edgeB[e]! : g.edgeA[e]!;
      if (done[m]) continue;
      const l = len[n]! + g.edgeLen[e]!;
      if (l > maxLen) continue;
      const d = dist[n]! + cost[e]!;
      if (d < dist[m]!) {
        dist[m] = d;
        len[m] = l;
        via[m] = e;
        heap.push(d, m);
      }
    }
  }
  return { cost: dist, len, via };
}

/** Edges of the tree path from its source to `to`, in travel order. */
function pathTo(g: Graph, tree: Tree, to: number): number[] {
  const edges: number[] = [];
  for (let n = to; tree.via[n]! >= 0; ) {
    const e = tree.via[n]!;
    edges.push(e);
    n = g.edgeA[e] === n ? g.edgeB[e]! : g.edgeA[e]!;
  }
  return edges.reverse();
}

/** Nearest node on a component with at least `minLen` metres of edges, so a stray fragment is never the start. */
function snap(g: Graph, comp: Components, p: LonLat, minLen: number): number {
  const kx = Math.cos((p[1] * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < g.nodes; n++) {
    const dx = (g.lon[n]! - p[0]) * kx;
    const dy = g.lat[n]! - p[1];
    const d = dx * dx + dy * dy;
    if (d < bestD && comp.len[comp.node[n]!]! >= minLen) {
      bestD = d;
      best = n;
    }
  }
  if (best < 0) throw new Error("No road network large enough near the start.");
  return best;
}

export interface Loop {
  /** Track from the snapped start and back to it. */
  coords: LonLat[];
  start: LonLat;
  totalKm: number;
  /** Unridden km on the route, each edge counted once however often the route uses it. */
  unriddenCountableKm: number;
  unriddenBonusKm: number;
  /** Km of the route where no cyclist rides in the chosen mode, null when the graph has no heat bbox. */
  deadKm: number | null;
  /** unriddenCountableKm / totalKm */
  share: number;
  /** Share of the route's length on edges with heat (of the chosen mode) of at least POPULAR_HEAT, null without heat data. */
  popularShare: number | null;
  heatMode: HeatMode;
  /** Length-weighted mean heat of the chosen mode along the route, 0..1, null without heat data. */
  meanHeat: number | null;
  /** For a loop: its cluster's place in the "try another" order (0 = most unridden km), how many are in reach, its km. */
  cluster: { rank: number; inReach: number; km: number } | null;
  /** For a sweep: how many unridden edges it rides. */
  swept: number | null;
}

function setup(g: Graph, o: LoopOptions) {
  const k = g.hasHeat ? Math.min(MAX_HEAT_K, Math.max(0, o.heatK)) : 0;
  return { k, heat: g.edgeHeat[o.heatMode], cost: edgeCosts(g, o, k), comp: view(g, o).comp };
}

/** The summary of a route walked from `s` along `edges`, `total` metres long. */
function summarise(g: Graph, o: LoopOptions, s: number, edges: number[], total: number): Omit<Loop, "cluster" | "swept"> {
  const heat = g.edgeHeat[o.heatMode];
  const seen = new Set<number>();
  let countableM = 0;
  let bonusM = 0;
  let popularM = 0;
  let heatM = 0;
  let deadM = 0;
  for (const e of edges) {
    const l = g.edgeLen[e]!;
    if (heat[e]! >= POPULAR_HEAT) popularM += l;
    heatM += heat[e]! * l;
    if (isDead(g, o.heatMode, e)) deadM += l;
    if (seen.has(e)) continue;
    seen.add(e);
    const f = g.edgeFlags[e]!;
    if (f & RIDDEN) continue;
    if (f & COUNTABLE) countableM += l;
    else bonusM += l;
  }
  return {
    coords: trace(g, s, edges),
    start: [g.lon[s]!, g.lat[s]!],
    totalKm: total / 1000,
    unriddenCountableKm: countableM / 1000,
    unriddenBonusKm: bonusM / 1000,
    deadKm: g.hasDead ? deadM / 1000 : null,
    share: countableM / total,
    popularShare: g.hasHeat ? popularM / total : null,
    heatMode: o.heatMode,
    meanHeat: g.hasHeat ? heatM / total : null,
  };
}

/**
 * A loop of about `km` from `start` through unridden roads. `variant`
 * picks the target cluster: 0 is the one with the most unridden km in
 * reach, each next one heads somewhere else, so "try another" walks the list.
 * `roadsOnly` keeps the loop off tracks, paths and other bonus edges, `skipDead`
 * off every edge no cyclist rides; `heatK` (0 to MAX_HEAT_K) is how strongly it
 * prefers edges with `heatMode` heat.
 */
export function makeLoop(g: Graph, start: LonLat, o: LoopOptions): Loop {
  const D = o.km * 1000;
  const reach = D / 2;
  const { k, heat, cost: baseCost, comp } = setup(g, o);
  const cl = clusters(g, o.heatMode);
  const s = snap(g, comp, start, D);

  // Out: cheapest paths from the start, cut at D/2.
  const out = dijkstra(g, s, baseCost, reach);

  // Unridden km per cluster inside that reach, and how far out each cluster goes.
  // Ranking uses the km weighted by heat as far as k asks, so a busy cluster beats a dead one.
  const clusterLen = new Float64Array(cl.count);
  const clusterScore = new Float64Array(cl.count);
  const clusterFar = new Float64Array(cl.count);
  // Length-weighted offset of each cluster from the start, for its bearing.
  const clusterDx = new Float64Array(cl.count);
  const clusterDy = new Float64Array(cl.count);
  const kx = Math.cos((g.lat[s]! * Math.PI) / 180);
  for (let e = 0; e < g.edges; e++) {
    const c = cl.edge[e]!;
    const a = g.edgeA[e]!;
    const la = out.len[a]!;
    const lb = out.len[g.edgeB[e]!]!;
    if (c < 0 || la > reach || lb > reach) continue;
    const l = g.edgeLen[e]!;
    clusterLen[c]! += l;
    clusterScore[c]! += l * (1 - k + k * heat[e]!);
    clusterFar[c] = Math.max(clusterFar[c]!, la, lb);
    clusterDx[c]! += (g.lon[a]! - g.lon[s]!) * kx * l;
    clusterDy[c]! += (g.lat[a]! - g.lat[s]!) * l;
  }
  // A cluster that ends close to the start cannot turn a loop of length D; rank only those
  // reaching far enough out, unless there are none.
  let ranked: number[] = [];
  for (let c = 0; c < cl.count; c++) if (clusterLen[c]! > 0) ranked.push(c);
  if (!ranked.length) throw new Error("No unridden roads in reach of the start.");
  const far = ranked.filter((c) => clusterFar[c]! >= MIN_TURN * D);
  if (far.length) ranked = far;
  // Neighbouring clusters in one direction give near-identical loops, so each variant takes the
  // cluster with the most km after discounting those within MIN_SPREAD of an earlier variant's.
  const bearing = (c: number) => Math.atan2(clusterDx[c]!, clusterDy[c]!);
  const rank = o.variant % ranked.length;
  const order: number[] = [];
  const left = new Set(ranked);
  while (order.length <= rank) {
    let best = -1;
    let bestScore = -1;
    for (const c of left) {
      let apart = Math.PI;
      for (const p of order) {
        const d = Math.abs(bearing(c) - bearing(p));
        apart = Math.min(apart, d, 2 * Math.PI - d);
      }
      const score = clusterScore[c]! * Math.min(1, apart / MIN_SPREAD);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    order.push(best);
    left.delete(best);
  }
  const cluster = order[rank]!;

  // Turnaround candidates: reached nodes of the cluster.
  const candidates = new Set<number>();
  for (let e = 0; e < g.edges; e++) {
    if (cl.edge[e] !== cluster) continue;
    for (const n of [g.edgeA[e]!, g.edgeB[e]!]) if (out.len[n]! <= reach) candidates.add(n);
  }

  // Pick the turnaround at outbound length r, cheapest per metre (most unridden on the way),
  // then rescale r until out + back comes close to D.
  const pick = (r: number): number => {
    let best = -1;
    let bestScore = Infinity;
    let nearest = -1;
    let nearestGap = Infinity;
    for (const n of candidates) {
      const l = out.len[n]!;
      const gap = Math.abs(l - r);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = n;
      }
      if (gap <= 0.2 * r && l > 0) {
        const score = out.cost[n]! / l;
        if (score < bestScore) {
          bestScore = score;
          best = n;
        }
      }
    }
    return best >= 0 ? best : nearest;
  };

  let best: { outEdges: number[]; backEdges: number[]; total: number } | null = null;
  const tried = new Set<number>();
  let r = 0.42 * D;
  for (let i = 0; i < 8; i++) {
    const t = pick(r);
    if (tried.has(t)) break;
    tried.add(t);
    const outEdges = pathTo(g, out, t);
    // Back: the outbound edges cost the ridden factor once more.
    const cost = baseCost.slice();
    for (const e of outEdges) cost[e]! *= RIDDEN_FACTOR;
    const back = dijkstra(g, t, cost, Infinity, s);
    if (!Number.isFinite(back.len[s]!)) continue;
    const backEdges = pathTo(g, back, s);
    const total = out.len[t]! + back.len[s]!;
    if (!best || Math.abs(total - D) < Math.abs(best.total - D)) best = { outEdges, backEdges, total };
    if (Math.abs(total - D) <= 0.05 * D) break;
    r = Math.min(reach, (r * D) / total);
  }
  if (!best) throw new Error("No way back from the target cluster.");

  return {
    ...summarise(g, o, s, [...best.outEdges, ...best.backEdges], best.total),
    cluster: { rank, inReach: ranked.length, km: clusterLen[cluster]! / 1000 },
    swept: null,
  };
}

/**
 * A sweep of about `km` from `start`: ride every unridden destination edge (as in a loop's
 * clusters) it can reach, nearest first, dead ends included, and go home when what is left
 * of the distance only just covers the way back. From each node it takes an unridden edge
 * right there if one fits, else the cheapest path to the nearest one that does; edges the
 * sweep has ridden cost the ridden factor on the way, so it retraces only where it must.
 */
export function makeSweep(g: Graph, start: LonLat, o: LoopOptions): Loop {
  const D = o.km * 1000;
  const { cost, comp } = setup(g, o);
  const s = snap(g, comp, start, Math.min(D, 5000));
  // Cheapest way home from every node within the distance (undirected, so a tree from the start).
  const home = dijkstra(g, s, cost, D);
  const covered = new Uint8Array(g.edges);
  const open = (e: number) => !covered[e] && Number.isFinite(cost[e]!) && isTarget(g.edgeFlags[e]!, o.heatMode);
  const other = (e: number, n: number) => (g.edgeA[e] === n ? g.edgeB[e]! : g.edgeA[e]!);

  // An open edge at n that still leaves the way home within D after `used` metres, or -1.
  const fits = (n: number, used: number): number => {
    for (let i = g.adjStart[n]!; i < g.adjStart[n + 1]!; i++) {
      const e = g.adjEdge[i]!;
      if (open(e) && used + g.edgeLen[e]! + home.len[other(e, n)]! <= D) return e;
    }
    return -1;
  };

  // Dijkstra with reused arrays, reset through the list of nodes it touched.
  const dist = new Float64Array(g.nodes).fill(Infinity);
  const len = new Float64Array(g.nodes).fill(Infinity);
  const via = new Int32Array(g.nodes).fill(-1);
  const done = new Uint8Array(g.nodes);
  const touched: number[] = [];
  const nearestOpen = (from: number, used: number): number[] | null => {
    for (const n of touched) {
      dist[n] = Infinity;
      len[n] = Infinity;
      via[n] = -1;
      done[n] = 0;
    }
    touched.length = 0;
    const heap = new Heap();
    dist[from] = 0;
    len[from] = 0;
    touched.push(from);
    heap.push(0, from);
    while (heap.size) {
      const n = heap.pop();
      if (done[n]) continue;
      done[n] = 1;
      if (n !== from && fits(n, used + len[n]!) >= 0) {
        const path: number[] = [];
        for (let m = n; via[m]! >= 0; m = other(via[m]!, m)) path.push(via[m]!);
        return path.reverse();
      }
      for (let i = g.adjStart[n]!; i < g.adjStart[n + 1]!; i++) {
        const e = g.adjEdge[i]!;
        const m = other(e, n);
        if (done[m]) continue;
        const l = len[n]! + g.edgeLen[e]!;
        if (used + l + home.len[m]! > D) continue;
        const d = dist[n]! + cost[e]! * (covered[e] ? RIDDEN_FACTOR : 1);
        if (d < dist[m]!) {
          if (dist[m] === Infinity) touched.push(m);
          dist[m] = d;
          len[m] = l;
          via[m] = e;
          heap.push(d, m);
        }
      }
    }
    return null;
  };

  const walk: number[] = [];
  let cur = s;
  let used = 0;
  let swept = 0;
  for (;;) {
    const e = fits(cur, used);
    if (e >= 0) {
      covered[e] = 1;
      swept++;
      walk.push(e);
      used += g.edgeLen[e]!;
      cur = other(e, cur);
      continue;
    }
    const path = nearestOpen(cur, used);
    if (!path) break;
    for (const p of path) {
      covered[p] = 1;
      walk.push(p);
      used += g.edgeLen[p]!;
      cur = other(p, cur);
    }
  }
  if (!swept) throw new Error("No unridden roads close enough for a sweep of this distance.");
  // Home: the start's tree path to here, walked backwards.
  const back = pathTo(g, home, cur).reverse();
  for (const e of back) used += g.edgeLen[e]!;

  return { ...summarise(g, o, s, [...walk, ...back], used), cluster: null, swept };
}

/** Coordinates along `edges` walked from node `from`, each edge flipped to the travel direction. */
function trace(g: Graph, from: number, edges: number[]): LonLat[] {
  const out: LonLat[] = [[g.lon[from]!, g.lat[from]!]];
  let n = from;
  for (const e of edges) {
    const forward = g.edgeA[e] === n;
    const lo = g.coordStart[e]!;
    const hi = g.coordStart[e + 1]!;
    // Skip the first point of each edge: it is the node the previous edge ended on.
    if (forward) for (let i = lo + 1; i < hi; i++) out.push([g.coords[2 * i]!, g.coords[2 * i + 1]!]);
    else for (let i = hi - 2; i >= lo; i--) out.push([g.coords[2 * i]!, g.coords[2 * i + 1]!]);
    n = forward ? g.edgeB[e]! : g.edgeA[e]!;
  }
  return out;
}
