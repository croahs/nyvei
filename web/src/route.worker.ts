// Routing worker: fetches the edge files itself, builds the graph once and
// answers route and gap requests, so neither runs on the main thread. Fetching again
// here beats handing over parsed GeoJSON: for all 24 files, fetch and parse in
// the worker took 1.4 s, while parsing on the main thread and posting the
// objects over took 4-5 s, 3 s of it structured cloning that blocks the page.
//
// Messages are handled in the order they arrive: a "blocked" sent before a "route" applies to it.

import type { BBox, EdgeHeat } from "./data";
import { findGaps, GraphBuilder, makeRoute, setBlocked, type EdgeOptions, type GapList, type Graph, type LonLat, type Route, type RouteRequest } from "./route";

export type Request =
  /** Fetch the edge files and build the graph. `blocked` is the owner's not-rideable edge ids (`i`), as for "blocked". */
  | { type: "load"; files: { key: string; url: string }[]; heatUrl?: string; heatBBox?: BBox; blocked?: string[] }
  /** Replace the set of not-rideable edge ids; every route after it avoids them. Answered by "blocked". */
  | { type: "blocked"; ids: string[] }
  /** A route in the mode the options ask for (RouteRequest in route.ts). Answered by "route" or "error" with the same id. */
  | ({ type: "route"; id: number } & RouteRequest)
  /** The `limit` gaps nearest `point`, and the totals, under these options. Answered by "gaps" or "error" with the same id. */
  | ({ type: "gaps"; id: number; point: LonLat; limit: number } & EdgeOptions);

export type Response =
  | { type: "progress"; done: number; of: number }
  /**
   * The graph is built. hasHeat: edges carry heat ("prefer bike heat"); hasDead: some lie in the heat
   * bbox ("skip where no one rides"); hasSurface / hasElev: edges carry `s` / `z` ("paved only",
   * "avoid steep", the elevation fields of a route). `blocked` as in the "blocked" response.
   */
  | { type: "ready"; nodes: number; edges: number; hasHeat: boolean; hasDead: boolean; hasSurface: boolean; hasElev: boolean; blocked: number; unknownBlocked: number; ms: number }
  /** Edges now blocked, and ids that matched no edge (an edge whose id changed since it was marked). */
  | { type: "blocked"; blocked: number; unknown: number }
  | { type: "route"; id: number; route: Route; ms: number }
  | { type: "gaps"; id: number; gaps: GapList; ms: number }
  | { type: "error"; id?: number; message: string };

const post = (r: Response) => postMessage(r);
let graph: Promise<Graph> | undefined;

async function load(files: { key: string; url: string }[], heatUrl?: string, heatBBox?: BBox, blocked: string[] = []): Promise<Graph> {
  const t0 = performance.now();
  const builder = new GraphBuilder(heatBBox);
  // Edge heat is one file from the heat project, joined onto each edge file by its key.
  const heat: EdgeHeat | null = heatUrl ? await fetch(heatUrl).then((r) => (r.ok ? (r.json() as Promise<EdgeHeat>) : null)).catch(() => null) : null;
  let done = 0;
  await Promise.all(
    files.map(async ({ key, url }) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      builder.add(await res.json(), heat?.[key]);
      post({ type: "progress", done: ++done, of: files.length });
    }),
  );
  const g = builder.finish();
  const b = setBlocked(g, blocked);
  post({
    type: "ready",
    nodes: g.nodes,
    edges: g.edges,
    hasHeat: g.hasHeat,
    hasDead: g.hasDead,
    hasSurface: g.hasSurface,
    hasElev: g.hasElev,
    blocked: b.blocked,
    unknownBlocked: b.unknown,
    ms: performance.now() - t0,
  });
  return g;
}

onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data;
  if (m.type === "load") {
    graph = load(m.files, m.heatUrl, m.heatBBox, m.blocked);
    graph.catch((err: unknown) => post({ type: "error", message: String(err) }));
    return;
  }
  const id = m.type === "blocked" ? undefined : m.id;
  try {
    if (!graph) throw new Error("Graph not loaded.");
    const g = await graph;
    const t0 = performance.now();
    if (m.type === "blocked") post({ type: "blocked", ...setBlocked(g, m.ids) });
    else if (m.type === "gaps") post({ type: "gaps", id: m.id, gaps: findGaps(g, m.point, m, m.limit), ms: performance.now() - t0 });
    else post({ type: "route", id: m.id, route: makeRoute(g, m), ms: performance.now() - t0 });
  } catch (err) {
    post({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
};
