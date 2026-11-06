// Routing worker: fetches the edge files itself, builds the graph once and
// answers loop requests, so neither runs on the main thread. Fetching again
// here beats handing over parsed GeoJSON: for all 24 files, fetch and parse in
// the worker took 1.4 s, while parsing on the main thread and posting the
// objects over took 4-5 s, 3 s of it structured cloning that blocks the page.

import type { EdgeHeat } from "./data";
import { GraphBuilder, makeLoop, makeSweep, type Graph, type Loop, type LoopOptions, type LonLat } from "./route";

export type Request =
  | { type: "load"; files: { key: string; url: string }[]; heatUrl?: string; heatBBox?: [number, number, number, number] }
  | ({ type: "loop"; id: number; start: LonLat } & LoopOptions);

export type Response =
  | { type: "progress"; done: number; of: number }
  | { type: "ready"; nodes: number; edges: number; hasHeat: boolean; hasDead: boolean; ms: number }
  | { type: "loop"; id: number; loop: Loop; ms: number }
  | { type: "error"; id?: number; message: string };

const post = (r: Response) => postMessage(r);
let graph: Promise<Graph> | undefined;

async function load(files: { key: string; url: string }[], heatUrl?: string, heatBBox?: [number, number, number, number]): Promise<Graph> {
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
  post({ type: "ready", nodes: g.nodes, edges: g.edges, hasHeat: g.hasHeat, hasDead: g.hasDead, ms: performance.now() - t0 });
  return g;
}

onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data;
  if (m.type === "load") {
    graph = load(m.files, m.heatUrl, m.heatBBox);
    graph.catch((err: unknown) => post({ type: "error", message: String(err) }));
    return;
  }
  try {
    if (!graph) throw new Error("Graph not loaded.");
    const g = await graph;
    const t0 = performance.now();
    const loop = (m.sweep ? makeSweep : makeLoop)(g, m.start, m);
    post({ type: "loop", id: m.id, loop, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: "error", id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
