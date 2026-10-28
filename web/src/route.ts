// Loop builder over the edge graph, run in route.worker.ts.
//
// Nodes are the OSM node ids at edge ends (`a`/`b`), edges are the features,
// undirected. Edge cost = length × 4 when ridden × 2 when bonus (PLAN.md,
// route), so the cheapest path prefers unridden roads and uses a track only to
// reach one. Roads only sets bonus edges to Infinity, so no path uses them. A loop goes out to the best unridden cluster in reach and back
// with the outbound edges penalised again, so it closes without retracing.

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
const RIDDEN_FACTOR = 4;
const BONUS_FACTOR = 2;
/** Smallest outbound length, as a share of the target, a turnaround cluster must reach. */
const MIN_TURN = 0.35;
/** Smallest angle, seen from the start, between the clusters of successive "try another" loops. */
const MIN_SPREAD = Math.PI / 4;

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
  edgeCost: Float64Array;
  /** edgeCost with bonus edges at Infinity, for roads-only loops. */
  roadCost: Float64Array;
  /** Geometry of edge e is coords[2 * coordStart[e] .. 2 * coordStart[e + 1]], from a to b. */
  coordStart: Int32Array;
  coords: Float64Array;
  /** Connected component of unridden countable edges, -1 for every other edge. */
  edgeCluster: Int32Array;
  clusters: number;
  /** Connected components of the whole graph, and of countable edges only for roads-only loops. */
  all: Components;
  roads: Components;
}

interface Components {
  /** Component per node, and each component's length in metres. */
  node: Int32Array;
  len: Float64Array;
}

/** Collects edge files one at a time so each parsed file can be dropped after `add`. */
export class GraphBuilder {
  private nodeIndex = new Map<number, number>();
  private lon: number[] = [];
  private lat: number[] = [];
  private a: number[] = [];
  private b: number[] = [];
  private len: number[] = [];
  private flags: number[] = [];
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
      this.flags.push((p[P.countable] === 1 ? COUNTABLE : 0) | (p[P.firstDate] ? RIDDEN : 0));
      for (const c of cs) this.coords.push(c[0]!, c[1]!);
      this.coordStart.push(this.coords.length / 2);
    }
  }

  finish(): Graph {
    const nodes = this.lon.length;
    const edges = this.a.length;
    const edgeA = Int32Array.from(this.a);
    const edgeB = Int32Array.from(this.b);
    const edgeLen = Float64Array.from(this.len);
    const edgeFlags = Uint8Array.from(this.flags);
    const edgeCost = new Float64Array(edges);
    for (let e = 0; e < edges; e++) {
      const f = edgeFlags[e]!;
      edgeCost[e] = edgeLen[e]! * (f & RIDDEN ? RIDDEN_FACTOR : 1) * (f & COUNTABLE ? 1 : BONUS_FACTOR);
    }
    const roadCost = edgeCost.map((c, e) => (edgeFlags[e]! & COUNTABLE ? c : Infinity));

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

    // Clusters: union-find over the endpoints of unridden countable edges.
    const unridden = (e: number) => edgeFlags[e] === COUNTABLE;
    const clusterRoot = unionFind(nodes, edges, edgeA, edgeB, unridden);
    const edgeCluster = new Int32Array(edges).fill(-1);
    const clusterId = new Map<number, number>();
    for (let e = 0; e < edges; e++) {
      if (!unridden(e)) continue;
      const root = clusterRoot(edgeA[e]!);
      let id = clusterId.get(root);
      if (id === undefined) clusterId.set(root, (id = clusterId.size));
      edgeCluster[e] = id;
    }

    // Components over the edges `use` accepts; a node no such edge touches is its own component of length 0.
    const components = (use: (e: number) => boolean): Components => {
      const root = unionFind(nodes, edges, edgeA, edgeB, use);
      const node = new Int32Array(nodes);
      const ids = new Map<number, number>();
      for (let n = 0; n < nodes; n++) {
        const r = root(n);
        let id = ids.get(r);
        if (id === undefined) ids.set(r, (id = ids.size));
        node[n] = id;
      }
      const len = new Float64Array(ids.size);
      for (let e = 0; e < edges; e++) if (use(e)) len[node[edgeA[e]!]!]! += edgeLen[e]!;
      return { node, len };
    };

    return {
      nodes,
      edges,
      lon: Float64Array.from(this.lon),
      lat: Float64Array.from(this.lat),
      adjStart,
      adjEdge,
      edgeA,
      edgeB,
      edgeLen,
      edgeFlags,
      edgeCost,
      roadCost,
      coordStart: Int32Array.from(this.coordStart),
      coords: Float64Array.from(this.coords),
      edgeCluster,
      clusters: clusterId.size,
      all: components(() => true),
      roads: components((e) => (edgeFlags[e]! & COUNTABLE) !== 0),
    };
  }
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
  /** Unridden km on the loop, each edge counted once however often the loop uses it. */
  unriddenCountableKm: number;
  unriddenBonusKm: number;
  /** unriddenCountableKm / totalKm */
  share: number;
  /** Position of the target cluster in the "try another" order (0 = most unridden countable km), and how many are in reach. */
  clusterRank: number;
  clustersInReach: number;
  clusterKm: number;
}

/**
 * A loop of about `targetKm` from `start` through unridden roads. `variant`
 * picks the target cluster: 0 is the one with the most unridden countable km in
 * reach, each next one heads somewhere else, so "try another" walks the list.
 * `roadsOnly` keeps the loop off tracks, paths and other bonus edges.
 */
export function makeLoop(g: Graph, start: LonLat, targetKm: number, variant: number, roadsOnly: boolean): Loop {
  const D = targetKm * 1000;
  const reach = D / 2;
  const baseCost = roadsOnly ? g.roadCost : g.edgeCost;
  const s = snap(g, roadsOnly ? g.roads : g.all, start, D);

  // Out: cheapest paths from the start, cut at D/2.
  const out = dijkstra(g, s, baseCost, reach);

  // Unridden countable km per cluster inside that reach, and how far out each cluster goes.
  const clusterLen = new Float64Array(g.clusters);
  const clusterFar = new Float64Array(g.clusters);
  // Length-weighted offset of each cluster from the start, for its bearing.
  const clusterDx = new Float64Array(g.clusters);
  const clusterDy = new Float64Array(g.clusters);
  const kx = Math.cos((g.lat[s]! * Math.PI) / 180);
  for (let e = 0; e < g.edges; e++) {
    const c = g.edgeCluster[e]!;
    const a = g.edgeA[e]!;
    const la = out.len[a]!;
    const lb = out.len[g.edgeB[e]!]!;
    if (c < 0 || la > reach || lb > reach) continue;
    const l = g.edgeLen[e]!;
    clusterLen[c]! += l;
    clusterFar[c] = Math.max(clusterFar[c]!, la, lb);
    clusterDx[c]! += (g.lon[a]! - g.lon[s]!) * kx * l;
    clusterDy[c]! += (g.lat[a]! - g.lat[s]!) * l;
  }
  // A cluster that ends close to the start cannot turn a loop of length D; rank only those
  // reaching far enough out, unless there are none.
  let ranked: number[] = [];
  for (let c = 0; c < g.clusters; c++) if (clusterLen[c]! > 0) ranked.push(c);
  if (!ranked.length) throw new Error("No unridden roads in reach of the start.");
  const far = ranked.filter((c) => clusterFar[c]! >= MIN_TURN * D);
  if (far.length) ranked = far;
  // Neighbouring clusters in one direction give near-identical loops, so each variant takes the
  // cluster with the most km after discounting those within MIN_SPREAD of an earlier variant's.
  const bearing = (c: number) => Math.atan2(clusterDx[c]!, clusterDy[c]!);
  const rank = variant % ranked.length;
  const order: number[] = [];
  const left = new Set(ranked);
  while (order.length <= rank) {
    let best = -1;
    let bestScore = -1;
    for (const c of left) {
      let apart = Math.PI;
      for (const o of order) {
        const d = Math.abs(bearing(c) - bearing(o));
        apart = Math.min(apart, d, 2 * Math.PI - d);
      }
      const score = clusterLen[c]! * Math.min(1, apart / MIN_SPREAD);
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
    if (g.edgeCluster[e] !== cluster) continue;
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

  const edges = [...best.outEdges, ...best.backEdges];
  const seen = new Set<number>();
  let countableM = 0;
  let bonusM = 0;
  for (const e of edges) {
    if (seen.has(e)) continue;
    seen.add(e);
    const f = g.edgeFlags[e]!;
    if (f & RIDDEN) continue;
    if (f & COUNTABLE) countableM += g.edgeLen[e]!;
    else bonusM += g.edgeLen[e]!;
  }

  return {
    coords: trace(g, s, edges),
    start: [g.lon[s]!, g.lat[s]!],
    totalKm: best.total / 1000,
    unriddenCountableKm: countableM / 1000,
    unriddenBonusKm: bonusM / 1000,
    share: countableM / best.total,
    clusterRank: rank,
    clustersInReach: ranked.length,
    clusterKm: clusterLen[cluster]! / 1000,
  };
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
