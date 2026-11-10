// Route builder over the edge graph, run in route.worker.ts: loops, sweeps, a loop with a
// sweep at its target, A to B through via points, and the list of gaps.
//
// Nodes are the OSM node ids at edge ends (`a`/`b`), edges are the features, undirected.
// Edge cost = length × 4 when ridden × 2 when bonus × (1 − k × heat) (PLAN.md, route), so the
// cheapest path prefers unridden roads, uses a track only to reach one, and with "prefer bike
// heat" k > 0 bends towards roads other cyclists ride (heat 0..1 from the Strava heatmap, the
// edge heat file's `tr` for road, max(ROAD_SHARE × `tr`, `tg`) for gravel, the same with `to`
// for off-road). In gravel and off-road mode a track or path whose own heat is at least
// POPULAR_HEAT counts as a road: no bonus factor, and a destination like an unridden road.
// Switches on top, each a no-op when off so routes stay what they were:
// - "avoid main roads": trunk and primary roads cost × MAIN_FACTOR and are nothing to head for
//   (a gravel route took 5.5 km of riksvei without it);
// - "avoid steep": × (1 + STEEP_FACTOR × steep), steep being the share of the edge's length on
//   STEEP_GRADE or more, from the edge's elevation profile `z`.
// Edges a route may not use at all cost Infinity: bonus edges under "roads only"; under "skip
// where no one rides" every edge inside the heat bbox whose heat in the chosen mode is 0, except
// residential streets; under "paved only" every edge tagged unpaved and every untagged bonus edge
// (untagged roads and cycleways in Norway are nearly all asphalt, untagged tracks are not); and
// the edges the owner marked not rideable (setBlocked), in every mode.
//
// Modes (makeRoute):
// - loop: out to the best unridden cluster in reach and back with the outbound edges penalised
//   again, so it closes without retracing;
// - sweep: rides every unridden edge it can reach, nearest first, and heads home when the
//   distance is used up; "gaps only" limits it to the gaps (findGaps);
// - loopsweep: a loop sized for LOOPSWEEP_SHARE of the distance goes out to its cluster, a sweep
//   spends the rest there, and the way home avoids the way out like a loop's;
// - ab: start → vias → end (or back to the start), each leg a cheapest path with the edges of
//   earlier legs penalised, so a round trip does not retrace.
// Edges carry surface `s` and elevations `z` when the pipeline had them; without either
// everything above works, the surface km count as untagged and the elevation fields are null.

import type { EdgeHeatValues } from "./data";
import { P } from "./props";

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
/** A residential street: never skipped for having no heat, because the owner rides every street. */
const STREET = 32;
const STREETS = new Set(["residential", "living_street"]);
/** Trunk or primary road (riksvei, fylkesvei with traffic): what "avoid main roads" avoids. */
const MAIN = 64;
const MAIN_ROADS = new Set(["trunk", "trunk_link", "primary", "primary_link"]);
/** Surface from the edge files: tagged paved, tagged unpaved, or neither (untagged). */
const PAVED = 128;
const UNPAVED = 256;
const RIDDEN_FACTOR = 4;
const BONUS_FACTOR = 2;
const MAIN_FACTOR = 4;
/** Grade from which a stretch counts as steep: the 6 % line PLAN.md measured the sweeps with. */
const STEEP_GRADE = 0.06;
/**
 * Elevations are whole metres, so a 1 m step is rounding, not slope: a z interval counts as
 * steep only when it also rises or falls at least this much. That only bites on intervals
 * shorter than STEEP_MIN_RISE / STEEP_GRADE (33 m), where one metre already reads as 6 %.
 * The ascent has its own, wider deadband (ASCENT_MIN_RISE).
 */
const STEEP_MIN_RISE = 2;
/**
 * Deadband of the ascent. The 19 m DEM pixels wobble by a few metres along a road, which a 2 m
 * band adds up: on three of the owner's hilly rides (73 to 133 km) the DEM climb at 5 m came within
 * 3 to 14 % of the bike computer's barometer, at 2 m it was 20 to 40 % over. Flat rides read a little low.
 */
const ASCENT_MIN_RISE = 5;
const STEEP_FACTOR = 3;
/** "Try another" A to B: the edges of earlier variants cost this much more, so the next one differs. */
const ALT_FACTOR = 2;
/** Share of a loop + sweep's distance the loop is sized for; the sweep gets the rest. */
const LOOPSWEEP_SHARE = 0.7;
/** Largest gap: a cluster of unridden targets this long or shorter, touching a ridden edge. */
const GAP_MAX_M = 500;
/** Share of a route's length that needs elevations before ascent, steep km and profile mean anything. */
const ELEV_MIN_SHARE = 0.8;
const PROFILE_POINTS = 400;
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
/** Each mode's own value in an edge's [t, tr, tg, to] (web/src/data.ts). */
const HEAT_INDEX: Record<HeatMode, number> = { road: 1, gravel: 2, offroad: 3 };
const HEAT_MODES = Object.keys(HEAT_INDEX) as HeatMode[];
/**
 * Road heat's weight in gravel and off-road mode: popular roads still beat dead ones,
 * but a busy gravel track beats a busy asphalt road, so the modes stay apart.
 */
const ROAD_SHARE = 0.5;

/**
 * An edge id `<way id>_<index>` as one number, way × 65536 + index (exact while way ids stay
 * below 2^37), so the graph keeps one Float64Array of ids instead of 400k strings. NaN for an
 * id of another shape, which then matches nothing.
 */
export function edgeKey(id: string): number {
  const i = id.indexOf("_");
  if (i <= 0) return NaN;
  const way = Number(id.slice(0, i));
  const index = Number(id.slice(i + 1));
  return Number.isInteger(way) && Number.isInteger(index) && index >= 0 && index < 65536 ? way * 65536 + index : NaN;
}

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
  edgeFlags: Uint16Array;
  /** edgeKey of each edge's id, for setBlocked. */
  edgeKey: Float64Array;
  /** Heat 0..1 per edge for each mode, 0 where the edge files carry none. */
  edgeHeat: Record<HeatMode, Float32Array>;
  /** Share of each edge's length at STEEP_GRADE or more, 0 without elevations. */
  edgeSteep: Float32Array;
  /** Elevations of edge e, from a to b, are z[zStart[e] .. zStart[e + 1]]: none, or at least 2. */
  zStart: Int32Array;
  z: Int16Array;
  /** True when any edge has heat, so "prefer bike heat" means something. */
  hasHeat: boolean;
  /** True when any edge lies in the heat bbox, so "skip where no one rides" means something. */
  hasDead: boolean;
  /** True when any edge has a surface tag or elevations, so "paved only" and "avoid steep" mean something. */
  hasSurface: boolean;
  hasElev: boolean;
  /** 1 for an edge the owner marked not rideable (setBlocked). */
  blocked: Uint8Array;
  /** Geometry of edge e is coords[2 * coordStart[e] .. 2 * coordStart[e + 1]], from a to b. */
  coordStart: Int32Array;
  coords: Float64Array;
  /** Built on first use and dropped by setBlocked: costs, usable edges with their components, clusters, gaps, per options. */
  costs: Map<string, Float64Array>;
  views: Map<string, View>;
  clusterSets: Map<string, Clusters>;
  gapSets: Map<string, Gaps>;
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

/** Connected components of the destination edges a route may use: cluster per edge, -1 for the rest. */
interface Clusters {
  /** 1 for an edge the route aims for (isTarget among the usable edges, minus main roads under avoidMain). */
  target: Uint8Array;
  edge: Int32Array;
  count: number;
}

/** The clusters that are gaps, with each cluster's edges (CSR) for listing them. */
interface Gaps {
  isGap: Uint8Array;
  len: Float64Array;
  /** Edges of cluster c are edges[start[c] .. start[c + 1]]. */
  start: Int32Array;
  edges: Int32Array;
  count: number;
  totalM: number;
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
  private keys: number[] = [];
  private heat: Record<HeatMode, number[]> = { road: [], gravel: [], offroad: [] };
  private steep: number[] = [];
  private zStart: number[] = [0];
  private z: number[] = [];
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

  /** One edge file, with its edges' heat by id when the heat project has it. */
  add(fc: EdgeCollection, heat?: Record<string, EdgeHeatValues>): void {
    for (const f of fc.features) {
      const p = f.properties;
      const from = p[P.from] as number | undefined;
      const to = p[P.to] as number | undefined;
      const cs = f.geometry.coordinates;
      if (from == null || to == null || cs.length < 2) continue;
      this.a.push(this.node(from, cs[0]!));
      this.b.push(this.node(to, cs[cs.length - 1]!));
      const len = p[P.length] as number;
      this.len.push(len);
      const countable = p[P.countable] === 1;
      const highway = p[P.highway] as string;
      let flags = (countable ? COUNTABLE : 0) | (p[P.firstDate] ? RIDDEN : 0) | (STREETS.has(highway) ? STREET : 0);
      if (MAIN_ROADS.has(highway)) flags |= MAIN;
      if (p[P.surface] === "p") flags |= PAVED;
      else if (p[P.surface] === "u") flags |= UNPAVED;
      if (this.inHeat(cs[0]!) && this.inHeat(cs[cs.length - 1]!)) flags |= IN_HEAT;
      const id = p[P.id] as string;
      const h = heat?.[id];
      const road = (h?.[HEAT_INDEX.road] ?? 0) / 100;
      for (const m of HEAT_MODES) {
        const own = (h?.[HEAT_INDEX[m]] ?? 0) / 100;
        this.heat[m].push(m === "road" ? road : Math.max(ROAD_SHARE * road, own));
        if (!countable && m !== "road" && own >= POPULAR_HEAT) flags |= TRACK[m];
      }
      this.flags.push(flags);
      this.keys.push(typeof id === "string" ? edgeKey(id) : NaN);
      const z = p[P.elev] as number[] | undefined;
      let steepM = 0;
      if (Array.isArray(z) && z.length >= 2) {
        // Evenly spaced from a to b: length / (n − 1) apart.
        const step = len / (z.length - 1);
        const rise = Math.max(STEEP_MIN_RISE, STEEP_GRADE * step);
        for (let i = 1; i < z.length; i++) if (Math.abs(z[i]! - z[i - 1]!) >= rise) steepM += step;
        for (const v of z) this.z.push(v);
      }
      this.zStart.push(this.z.length);
      this.steep.push(len > 0 ? steepM / len : 0);
      for (const c of cs) this.coords.push(c[0]!, c[1]!);
      this.coordStart.push(this.coords.length / 2);
    }
  }

  finish(): Graph {
    const nodes = this.lon.length;
    const edges = this.a.length;
    const edgeA = Int32Array.from(this.a);
    const edgeB = Int32Array.from(this.b);
    const edgeFlags = Uint16Array.from(this.flags);
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
      edgeKey: Float64Array.from(this.keys),
      edgeHeat,
      edgeSteep: Float32Array.from(this.steep),
      zStart: Int32Array.from(this.zStart),
      z: Int16Array.from(this.z),
      hasHeat: edgeHeat.road.some((h) => h > 0),
      hasDead: edgeFlags.some((f) => (f & IN_HEAT) !== 0),
      hasSurface: edgeFlags.some((f) => (f & (PAVED | UNPAVED)) !== 0),
      hasElev: this.z.length > 0,
      blocked: new Uint8Array(edges),
      coordStart: Int32Array.from(this.coordStart),
      coords: Float64Array.from(this.coords),
      costs: new Map(),
      views: new Map(),
      clusterSets: new Map(),
      gapSets: new Map(),
    };
  }
}

/**
 * Marks the edges with these ids (`i`, `<way id>_<index>`) not rideable, replacing the previous
 * set, and drops every cached cost, view, cluster set and gap set, since all of them depend on it.
 * Returns how many edges are now blocked and how many ids matched no edge.
 */
export function setBlocked(g: Graph, ids: readonly string[]): { blocked: number; unknown: number } {
  const want = new Set<number>();
  for (const id of ids) {
    const k = edgeKey(id);
    if (!Number.isNaN(k)) want.add(k);
  }
  const found = new Set<number>();
  let blocked = 0;
  for (let e = 0; e < g.edges; e++) {
    const k = g.edgeKey[e]!;
    const on = want.has(k);
    g.blocked[e] = on ? 1 : 0;
    if (on) {
      blocked++;
      found.add(k);
    }
  }
  g.costs.clear();
  g.views.clear();
  g.clusterSets.clear();
  g.gapSets.clear();
  return { blocked, unknown: ids.length - found.size };
}

/** What decides which edges a route may use and which it aims for. */
export interface EdgeOptions {
  /** Leave out tracks, paths and other bonus edges. */
  roadsOnly: boolean;
  /** Leave out edges in the heat bbox with no heat in the chosen mode (residential streets stay). */
  skipDead: boolean;
  heatMode: HeatMode;
  /** Leave out edges tagged unpaved, and bonus edges with no surface tag. */
  pavedOnly: boolean;
  /** Trunk and primary roads cost × MAIN_FACTOR and are never a destination. */
  avoidMain: boolean;
}

export type Mode = "loop" | "sweep" | "loopsweep" | "ab";

export interface RouteOptions extends EdgeOptions {
  mode: Mode;
  /** Target distance in km; ignored by "ab". */
  km: number;
  /**
   * "Try another": the n-th alternative. A loop and a loop + sweep take the n-th cluster in
   * rank order (wrapping), "ab" the n-th route with the edges of the earlier ones penalised;
   * a sweep ignores it.
   */
  variant: number;
  /** How strongly the route prefers edges with heatMode heat, 0 to MAX_HEAT_K. */
  heatK: number;
  /** Steep edges cost × (1 + STEEP_FACTOR × steep share), and a loop ranks clusters by their less steep km. */
  avoidSteep: boolean;
  /** A sweep ("sweep" only) rides only the gaps (findGaps). */
  gapsOnly: boolean;
}

export interface RouteRequest extends RouteOptions {
  start: LonLat;
  /** "ab" only: where the route ends; without it the route comes back to the start. */
  end?: LonLat;
  /** "ab" only: points to pass, in order, between start and end. */
  via?: LonLat[];
}

/** An unridden edge the route aims for: a countable road, or in gravel and off-road mode a busy track. */
const isTarget = (f: number, mode: HeatMode) => !(f & RIDDEN) && ((f & COUNTABLE) !== 0 || (f & TRACK[mode]) !== 0);

/** No cyclist rides it in this mode, as far as the heatmap can tell. */
const isDead = (g: Graph, mode: HeatMode, e: number) =>
  (g.edgeFlags[e]! & (IN_HEAT | STREET)) === IN_HEAT && g.edgeHeat[mode][e] === 0;

/** Unpaved, or a bonus edge with no surface tag, which in Norway is rarely asphalt. */
const isUnpaved = (f: number) => (f & UNPAVED) !== 0 || ((f & (PAVED | COUNTABLE)) === 0);

// Cache keys. The blocked set is in none of them: setBlocked clears the caches instead.
/** What decides which edges a route may use: the key of its view. */
const viewKey = (g: Graph, o: EdgeOptions) => `${o.heatMode}|${o.roadsOnly}|${o.skipDead && g.hasDead}|${o.pavedOnly}`;
/** What decides which edges it aims for: the key of its clusters and gaps. */
const clusterKey = (g: Graph, o: EdgeOptions) => `${viewKey(g, o)}|${o.avoidMain}`;

function view(g: Graph, o: EdgeOptions): View {
  const skipDead = o.skipDead && g.hasDead;
  const key = viewKey(g, o);
  let v = g.views.get(key);
  if (v) return v;
  const usable = new Uint8Array(g.edges);
  for (let e = 0; e < g.edges; e++) {
    const f = g.edgeFlags[e]!;
    usable[e] =
      g.blocked[e] || (o.roadsOnly && !(f & COUNTABLE)) || (skipDead && isDead(g, o.heatMode, e)) || (o.pavedOnly && isUnpaved(f)) ? 0 : 1;
  }
  v = { usable, comp: components(g, (e) => usable[e] === 1) };
  g.views.set(key, v);
  return v;
}

/** Edge costs for a route: see the header. */
function edgeCosts(g: Graph, o: RouteOptions, k: number): Float64Array {
  const key = `${clusterKey(g, o)}|${o.avoidSteep}|${k}`;
  let cost = g.costs.get(key);
  if (cost) return cost;
  const { usable } = view(g, o);
  const heat = g.edgeHeat[o.heatMode];
  const track = TRACK[o.heatMode];
  cost = new Float64Array(g.edges);
  for (let e = 0; e < g.edges; e++) {
    const f = g.edgeFlags[e]!;
    const bonus = !(f & COUNTABLE) && !(f & track);
    let c = usable[e] ? g.edgeLen[e]! * (f & RIDDEN ? RIDDEN_FACTOR : 1) * (bonus ? BONUS_FACTOR : 1) * (1 - k * heat[e]!) : Infinity;
    // Applied only when on, so with both off every cost is the same float as before they existed.
    if (o.avoidMain && f & MAIN) c *= MAIN_FACTOR;
    if (o.avoidSteep) c *= 1 + STEEP_FACTOR * g.edgeSteep[e]!;
    cost[e] = c;
  }
  g.costs.set(key, cost);
  return cost;
}

/**
 * Clusters of unridden destination edges, among the edges the route may use: one that is left out
 * (a road no one rides, a track under "roads only", a blocked edge) is nothing to head for, and
 * joins no cluster; nor does a main road under "avoid main roads".
 */
function clusters(g: Graph, o: EdgeOptions): Clusters {
  const key = clusterKey(g, o);
  let c = g.clusterSets.get(key);
  if (c) return c;
  const { usable } = view(g, o);
  const target = new Uint8Array(g.edges);
  for (let e = 0; e < g.edges; e++) {
    const f = g.edgeFlags[e]!;
    target[e] = usable[e] === 1 && isTarget(f, o.heatMode) && !(o.avoidMain && f & MAIN) ? 1 : 0;
  }
  const root = unionFind(g.nodes, g.edges, g.edgeA, g.edgeB, (e) => target[e] === 1);
  const edge = new Int32Array(g.edges).fill(-1);
  const ids = new Map<number, number>();
  for (let e = 0; e < g.edges; e++) {
    if (!target[e]) continue;
    const r = root(g.edgeA[e]!);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    edge[e] = id;
  }
  c = { target, edge, count: ids.size };
  g.clusterSets.set(key, c);
  return c;
}

/**
 * Gaps: clusters of at most GAP_MAX_M with a node on a ridden edge, the short unridden stubs
 * left between roads already ridden. An unridden cluster touching nothing ridden is somewhere
 * new, not a gap.
 */
function gapSet(g: Graph, o: EdgeOptions): Gaps {
  const key = clusterKey(g, o);
  let gs = g.gapSets.get(key);
  if (gs) return gs;
  const cl = clusters(g, o);
  const onRidden = new Uint8Array(g.nodes);
  for (let e = 0; e < g.edges; e++) {
    if (g.edgeFlags[e]! & RIDDEN) onRidden[g.edgeA[e]!] = onRidden[g.edgeB[e]!] = 1;
  }
  const len = new Float64Array(cl.count);
  const touches = new Uint8Array(cl.count);
  const start = new Int32Array(cl.count + 1);
  for (let e = 0; e < g.edges; e++) {
    const c = cl.edge[e]!;
    if (c < 0) continue;
    len[c]! += g.edgeLen[e]!;
    start[c + 1]!++;
    if (onRidden[g.edgeA[e]!] || onRidden[g.edgeB[e]!]) touches[c] = 1;
  }
  for (let c = 0; c < cl.count; c++) start[c + 1]! += start[c]!;
  const edges = new Int32Array(start[cl.count]!);
  const fill = start.slice(0, cl.count);
  for (let e = 0; e < g.edges; e++) {
    const c = cl.edge[e]!;
    if (c >= 0) edges[fill[c]!++] = e;
  }
  const isGap = new Uint8Array(cl.count);
  let count = 0;
  let totalM = 0;
  for (let c = 0; c < cl.count; c++) {
    if (touches[c] && len[c]! <= GAP_MAX_M) {
      isGap[c] = 1;
      count++;
      totalM += len[c]!;
    }
  }
  gs = { isGap, len, start, edges, count, totalM };
  g.gapSets.set(key, gs);
  return gs;
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

/** Nearest node whose component passes `ok`. */
function nearestNode(g: Graph, comp: Components, p: LonLat, ok: (c: number) => boolean): number {
  const kx = Math.cos((p[1] * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < g.nodes; n++) {
    const dx = (g.lon[n]! - p[0]) * kx;
    const dy = g.lat[n]! - p[1];
    const d = dx * dx + dy * dy;
    if (d < bestD && ok(comp.node[n]!)) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/** Nearest node on a component with at least `minLen` metres of edges, so a stray fragment is never the start. */
function snap(g: Graph, comp: Components, p: LonLat, minLen: number): number {
  const best = nearestNode(g, comp, p, (c) => comp.len[c]! >= minLen);
  if (best < 0) throw new Error("No road network large enough near the start.");
  return best;
}

/** Straight-line metres between two points (equirectangular, plenty at ride scale). */
function metres(a: LonLat, b: LonLat): number {
  const kx = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (a[0] - b[0]) * kx;
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy) * 111_195;
}

export interface Route {
  mode: Mode;
  /** Track from the snapped start to the snapped end, or back to the start. */
  coords: LonLat[];
  start: LonLat;
  /** "ab" only: the snapped via points in order, and the snapped end (null for a round trip). */
  via: LonLat[] | null;
  end: LonLat | null;
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
  /** Km of the route by surface tag (untagged: no `s`), and on trunk and primary roads; every pass counts. */
  pavedKm: number;
  unpavedKm: number;
  untaggedKm: number;
  mainKm: number;
  /**
   * Elevation, null when less than ELEV_MIN_SHARE of the route's length has elevations: total climb
   * with an ASCENT_MIN_RISE deadband (so DEM wobble on flat ground adds nothing), km at
   * STEEP_GRADE or steeper, and the profile as [km along, metres] thinned to at most PROFILE_POINTS.
   * The profile skips stretches without elevations.
   */
  ascentM: number | null;
  steepKm: number | null;
  profile: [number, number][] | null;
  /** For a loop and a loop + sweep: its cluster's place in the "try another" order (0 = most unridden km), how many are in reach, its km. */
  cluster: { rank: number; inReach: number; km: number } | null;
  /** For a sweep and a loop + sweep: how many unridden edges the sweep rides. */
  swept: number | null;
}

interface Setup {
  k: number;
  heat: Float32Array;
  cost: Float64Array;
  comp: Components;
}

function setup(g: Graph, o: RouteOptions): Setup {
  const k = g.hasHeat ? Math.min(MAX_HEAT_K, Math.max(0, o.heatK)) : 0;
  return { k, heat: g.edgeHeat[o.heatMode], cost: edgeCosts(g, o, k), comp: view(g, o).comp };
}

type Summary = Omit<Route, "mode" | "via" | "end" | "cluster" | "swept">;

/** The summary of a route walked from `s` along `edges`, `total` metres long. */
function summarise(g: Graph, o: RouteOptions, s: number, edges: number[], total: number): Summary {
  const heat = g.edgeHeat[o.heatMode];
  const seen = new Set<number>();
  let countableM = 0;
  let bonusM = 0;
  let popularM = 0;
  let heatM = 0;
  let deadM = 0;
  let pavedM = 0;
  let unpavedM = 0;
  let mainM = 0;
  for (const e of edges) {
    const l = g.edgeLen[e]!;
    const f = g.edgeFlags[e]!;
    if (heat[e]! >= POPULAR_HEAT) popularM += l;
    heatM += heat[e]! * l;
    if (isDead(g, o.heatMode, e)) deadM += l;
    if (f & PAVED) pavedM += l;
    else if (f & UNPAVED) unpavedM += l;
    if (f & MAIN) mainM += l;
    if (seen.has(e)) continue;
    seen.add(e);
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
    pavedKm: pavedM / 1000,
    unpavedKm: unpavedM / 1000,
    untaggedKm: (total - pavedM - unpavedM) / 1000,
    mainKm: mainM / 1000,
    ...elevation(g, s, edges, total),
  };
}

/** Ascent, steep km and profile along `edges` walked from `s`: see Route. */
function elevation(g: Graph, s: number, edges: number[], total: number): Pick<Route, "ascentM" | "steepKm" | "profile"> {
  const none = { ascentM: null, steepKm: null, profile: null };
  if (!g.hasElev || !(total > 0)) return none;
  let withZ = 0;
  for (const e of edges) if (g.zStart[e + 1]! - g.zStart[e]! >= 2) withZ += g.edgeLen[e]!;
  if (withZ < ELEV_MIN_SHARE * total) return none;

  const pts: [number, number][] = [];
  let ascent = 0;
  // Deadband: count a climb only once it is ASCENT_MIN_RISE above the last level held, and move that
  // level down only on a drop as large, so ±1 m rounding on flat ground climbs nothing.
  let level = NaN;
  let steepM = 0;
  let at = 0;
  let n = s;
  for (const e of edges) {
    const l = g.edgeLen[e]!;
    const forward = g.edgeA[e] === n;
    const lo = g.zStart[e]!;
    const cnt = g.zStart[e + 1]! - lo;
    if (cnt >= 2) {
      steepM += g.edgeSteep[e]! * l;
      const step = l / (cnt - 1);
      for (let j = 0; j < cnt; j++) {
        const z = g.z[forward ? lo + j : lo + cnt - 1 - j]!;
        // The first point of an edge is the node the previous edge ended on.
        if (j > 0 || !pts.length || pts[pts.length - 1]![0] !== at / 1000) pts.push([(at + j * step) / 1000, z]);
        if (Number.isNaN(level)) level = z;
        else if (z - level >= ASCENT_MIN_RISE) {
          ascent += z - level;
          level = z;
        } else if (level - z >= ASCENT_MIN_RISE) level = z;
      }
    }
    at += l;
    n = forward ? g.edgeB[e]! : g.edgeA[e]!;
  }

  let profile = pts;
  if (pts.length > PROFILE_POINTS) {
    // Keep the first point at or past each of PROFILE_POINTS − 1 even marks, and the last.
    const every = total / 1000 / (PROFILE_POINTS - 1);
    profile = [];
    let mark = 0;
    for (const p of pts) {
      if (p[0] >= mark) {
        profile.push(p);
        mark = (Math.floor(p[0] / every) + 1) * every;
      }
    }
    const last = pts[pts.length - 1]!;
    if (profile[profile.length - 1] !== last) {
      if (profile.length >= PROFILE_POINTS) profile.pop();
      profile.push(last);
    }
  }
  return { ascentM: ascent, steepKm: steepM / 1000, profile };
}

/** A route for the request, in the mode it asks for: see the header and RouteOptions. */
export function makeRoute(g: Graph, r: RouteRequest): Route {
  switch (r.mode) {
    case "loop":
      return makeLoop(g, r.start, r);
    case "sweep":
      return makeSweep(g, r.start, r);
    case "loopsweep":
      return makeLoopSweep(g, r.start, r);
    case "ab":
      return makeAB(g, r);
    default:
      throw new Error(`Unknown route mode ${String((r as { mode: unknown }).mode)}.`);
  }
}

interface LoopPlan {
  cluster: { rank: number; inReach: number; km: number };
  outEdges: number[];
  backEdges: number[];
  /** Out + back, metres, and the turnaround node with its outbound length. */
  total: number;
  turn: number;
  outLen: number;
}

/**
 * Out and back from `s` for a loop of about D metres. `variant` picks the target cluster: 0 is the
 * one with the most unridden km in reach, each next one heads somewhere else, so "try another"
 * walks the list. With `discountSteep` each edge's km counts × (1 − steep) in the ranking.
 */
function planLoop(g: Graph, o: RouteOptions, su: Setup, s: number, D: number, discountSteep: boolean): LoopPlan {
  const reach = D / 2;
  const { k, heat, cost: baseCost } = su;
  const cl = clusters(g, o);

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
    let w = l * (1 - k + k * heat[e]!);
    if (discountSteep) w *= 1 - g.edgeSteep[e]!;
    clusterScore[c]! += w;
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

  let best: { outEdges: number[]; backEdges: number[]; total: number; turn: number } | null = null;
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
    if (!best || Math.abs(total - D) < Math.abs(best.total - D)) best = { outEdges, backEdges, total, turn: t };
    if (Math.abs(total - D) <= 0.05 * D) break;
    r = Math.min(reach, (r * D) / total);
  }
  if (!best) throw new Error("No way back from the target cluster.");
  return {
    cluster: { rank, inReach: ranked.length, km: clusterLen[cluster]! / 1000 },
    ...best,
    outLen: out.len[best.turn]!,
  };
}

const noAB = { via: null, end: null };

/**
 * A loop of about `km` from `start` through unridden roads, out to a cluster and back: see
 * planLoop. `avoidSteep` also ranks the clusters by their less steep km.
 */
export function makeLoop(g: Graph, start: LonLat, o: RouteOptions): Route {
  const D = o.km * 1000;
  const su = setup(g, o);
  const s = snap(g, su.comp, start, D);
  const p = planLoop(g, o, su, s, D, o.avoidSteep);
  return { mode: "loop", ...summarise(g, o, s, [...p.outEdges, ...p.backEdges], p.total), ...noAB, cluster: p.cluster, swept: null };
}

interface Sweep {
  /** Edges in travel order, the node it ends on, metres used, unridden edges ridden. */
  walk: number[];
  end: number;
  used: number;
  swept: number;
}

/**
 * The sweep itself, from node `from` with `used` metres already behind it, within D metres in all:
 * ride every edge with `target` set and `covered` clear, nearest first, dead ends included, while
 * what is left of D still covers the way home along `home` (a tree from the start under the cost
 * of the way home, undirected, so its paths run both ways). From each node it takes such an edge
 * right there if one fits, else the cheapest path to the nearest one that does; edges with
 * `covered` set (ridden by this route) cost the ridden factor on the way, so it retraces only
 * where it must. Marks what it rides in `covered`.
 */
function sweepFrom(g: Graph, cost: Float64Array, target: Uint8Array, covered: Uint8Array, home: Tree, D: number, from: number, used: number): Sweep {
  const open = (e: number) => !covered[e] && target[e] === 1;
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
  let cur = from;
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
  return { walk, end: cur, used, swept };
}

/**
 * A sweep of about `km` from `start`: sweepFrom the start over every unridden destination edge (as
 * in a loop's clusters), or with `gapsOnly` over the gaps alone, then home along the cheapest path.
 */
export function makeSweep(g: Graph, start: LonLat, o: RouteOptions): Route {
  const D = o.km * 1000;
  const { cost, comp } = setup(g, o);
  const s = snap(g, comp, start, Math.min(D, 5000));
  let { target } = clusters(g, o);
  if (o.gapsOnly) {
    const cl = clusters(g, o);
    const { isGap } = gapSet(g, o);
    target = target.map((t, e) => (t && isGap[cl.edge[e]!] ? 1 : 0));
  }
  // Cheapest way home from every node within the distance (undirected, so a tree from the start).
  const home = dijkstra(g, s, cost, D);
  const sw = sweepFrom(g, cost, target, new Uint8Array(g.edges), home, D, s, 0);
  if (!sw.swept) throw new Error(o.gapsOnly ? "No gaps close enough for a sweep of this distance." : "No unridden roads close enough for a sweep of this distance.");
  // Home: the start's tree path to here, walked backwards.
  const back = pathTo(g, home, sw.end).reverse();
  let used = sw.used;
  for (const e of back) used += g.edgeLen[e]!;
  return { mode: "sweep", ...summarise(g, o, s, [...sw.walk, ...back], used), ...noAB, cluster: null, swept: sw.swept };
}

/**
 * A loop with a sweep at its target, about `km` long: a loop of LOOPSWEEP_SHARE × km (out to a
 * cluster, and home with the outbound edges penalised, so by another road), with a sweep spliced
 * in at its turnaround that spends the rest of the distance there and comes back to the
 * turnaround before the loop heads home. The sweep stops when what is left only covers the way
 * back to the turnaround, so the total lands near km; it treats the loop's own edges as ridden.
 * Splicing rather than sweeping on towards home matters: a sweep whose way home is the start's
 * tree finds a fitting street ever closer to home and zig-zags the whole way back (from Sandnes,
 * 26 of 40 km were sweep and 0.2 km a way home), so it is no longer a sweep at one target.
 * The cluster ranking always discounts steep km: a sweep climbs every side street, so a steep
 * cluster costs far more effort than its km say (PLAN.md, open questions).
 */
export function makeLoopSweep(g: Graph, start: LonLat, o: RouteOptions): Route {
  const D = o.km * 1000;
  const su = setup(g, o);
  const s = snap(g, su.comp, start, D);
  const p = planLoop(g, o, su, s, LOOPSWEEP_SHARE * D, true);
  const covered = new Uint8Array(g.edges);
  for (const e of p.outEdges) covered[e] = 1;
  for (const e of p.backEdges) covered[e] = 1;
  const budget = Math.max(0, D - p.total);
  // The sweep's "home" is the turnaround: a tree from it, within the distance left.
  const home = dijkstra(g, p.turn, su.cost, budget);
  const sw = sweepFrom(g, su.cost, clusters(g, o).target, covered, home, budget, p.turn, 0);
  const ret = pathTo(g, home, sw.end).reverse();
  let used = p.total + sw.used;
  for (const e of ret) used += g.edgeLen[e]!;
  return {
    mode: "loopsweep",
    ...summarise(g, o, s, [...p.outEdges, ...sw.walk, ...ret, ...p.backEdges], used),
    ...noAB,
    cluster: p.cluster,
    swept: sw.swept,
  };
}

/**
 * A to B: start → each via in order → end, or back to the start without an end. Every point snaps
 * onto the start's component, so every leg has a path. Each leg is the cheapest path under the
 * loop's edge costs, with the edges of earlier legs × the ridden factor once more, so a round trip
 * comes back another way. `variant` n routes variants 0..n in turn, each with the edges of all
 * earlier ones × ALT_FACTOR, and returns the last.
 */
export function makeAB(g: Graph, r: RouteRequest): Route {
  const via = r.via ?? [];
  if (!r.end && !via.length) throw new Error("A to B needs an end point or at least one via point to come back from.");
  const points = [r.start, ...via, r.end ?? r.start];
  const su = setup(g, r);
  // The start's component must about span the straight line through all the points, so a stray
  // fragment near the start is never where the route lives (10 % slack for whole-metre lengths).
  let crow = 0;
  for (let i = 1; i < points.length; i++) crow += metres(points[i - 1]!, points[i]!);
  const s = snap(g, su.comp, r.start, Math.max(1000, 0.9 * crow));
  const own = su.comp.node[s]!;
  const nodes = points.map((p, i) => (i === 0 || (!r.end && i === points.length - 1) ? s : nearestNode(g, su.comp, p, (c) => c === own)));

  const alt = new Uint8Array(g.edges);
  let edges: number[] = [];
  let total = 0;
  for (let v = 0; v <= Math.max(0, Math.floor(r.variant)); v++) {
    const cost = su.cost.slice();
    for (let e = 0; e < g.edges; e++) if (alt[e]) cost[e]! *= ALT_FACTOR;
    const used = new Uint8Array(g.edges);
    edges = [];
    total = 0;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1]!;
      const b = nodes[i]!;
      if (a === b) continue;
      const tree = dijkstra(g, a, cost, Infinity, b);
      if (!Number.isFinite(tree.len[b]!)) throw new Error("No path between two of the points.");
      for (const e of pathTo(g, tree, b)) {
        edges.push(e);
        if (!used[e]) {
          used[e] = 1;
          cost[e]! *= RIDDEN_FACTOR;
        }
      }
      total += tree.len[b]!;
    }
    for (const e of edges) alt[e] = 1;
  }
  if (!edges.length) throw new Error("Start and end are the same point.");
  const at = (n: number): LonLat => [g.lon[n]!, g.lat[n]!];
  return {
    mode: "ab",
    ...summarise(g, r, s, edges, total),
    via: nodes.slice(1, 1 + via.length).map(at),
    end: r.end ? at(nodes[nodes.length - 1]!) : null,
    cluster: null,
    swept: null,
  };
}

export interface Gap {
  /** A point on the gap to show it by: the middle vertex of its longest edge. */
  at: LonLat;
  /** Its total length in metres and how many edges it has. */
  m: number;
  edges: number;
  /** Straight-line metres from the asked point to the gap's nearest vertex. */
  distM: number;
  /** One line per edge. */
  coords: LonLat[][];
}

export interface GapList {
  /** The `limit` gaps nearest the point, nearest first. */
  gaps: Gap[];
  /** All gaps in the graph under these options, and their total km. */
  count: number;
  totalKm: number;
}

/** The gaps nearest `p` under these options: see gapSet. */
export function findGaps(g: Graph, p: LonLat, o: EdgeOptions, limit: number): GapList {
  const gs = gapSet(g, o);
  const kx = Math.cos((p[1] * Math.PI) / 180);
  const near: { c: number; d: number }[] = [];
  for (let c = 0; c < gs.isGap.length; c++) {
    if (!gs.isGap[c]) continue;
    let best = Infinity;
    for (let i = gs.start[c]!; i < gs.start[c + 1]!; i++) {
      const e = gs.edges[i]!;
      for (let j = g.coordStart[e]!; j < g.coordStart[e + 1]!; j++) {
        const dx = (g.coords[2 * j]! - p[0]) * kx;
        const dy = g.coords[2 * j + 1]! - p[1];
        best = Math.min(best, dx * dx + dy * dy);
      }
    }
    near.push({ c, d: Math.sqrt(best) * 111_195 });
  }
  near.sort((a, b) => a.d - b.d);
  const gaps = near.slice(0, Math.max(0, limit)).map(({ c, d }): Gap => {
    const coords: LonLat[][] = [];
    let longest = -1;
    for (let i = gs.start[c]!; i < gs.start[c + 1]!; i++) {
      const e = gs.edges[i]!;
      if (longest < 0 || g.edgeLen[e]! > g.edgeLen[longest]!) longest = e;
      const line: LonLat[] = [];
      for (let j = g.coordStart[e]!; j < g.coordStart[e + 1]!; j++) line.push([g.coords[2 * j]!, g.coords[2 * j + 1]!]);
      coords.push(line);
    }
    const mid = (g.coordStart[longest]! + g.coordStart[longest + 1]! - 1) >> 1;
    return { at: [g.coords[2 * mid]!, g.coords[2 * mid + 1]!], m: gs.len[c]!, edges: coords.length, distM: d, coords };
  });
  return { gaps, count: gs.count, totalKm: gs.totalM / 1000 };
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
