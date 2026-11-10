// The routing worker behind promises: one place that owns route.worker.ts, so the route panel,
// the gaps section and the not-rideable list can each ask it things without sharing message ids.

import type { BBox, EdgeFile } from "./data";
import type { EdgeOptions, GapList, LonLat, Route, RouteRequest } from "./route";
import type { Request, Response } from "./route.worker";

export type Ready = Extract<Response, { type: "ready" }>;
export interface BlockedCount {
  blocked: number;
  unknown: number;
}

export interface Router {
  /** Resolves when the graph is built; rejects when loading it failed. */
  ready: Promise<Ready>;
  route(r: RouteRequest): Promise<{ route: Route; ms: number }>;
  gaps(point: LonLat, limit: number, o: EdgeOptions): Promise<{ gaps: GapList; ms: number }>;
  /** Replaces the not-rideable set; routes asked for after this call avoid it. */
  setBlocked(ids: string[]): Promise<BlockedCount>;
}

interface Waiter {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
}

export function startRouter(
  files: EdgeFile[],
  opts: { heatUrl?: string; heatBBox?: BBox; blocked: string[]; onProgress: (done: number, of: number) => void },
): Router {
  const worker = new Worker(new URL("./route.worker.ts", import.meta.url), { type: "module" });
  const send = (r: Request) => worker.postMessage(r);
  let nextId = 0;
  const pending = new Map<number, Waiter>();
  // "blocked" answers carry no id; the worker handles messages in order, so they come back in order.
  const blockedQueue: Waiter[] = [];
  let built = false;
  let readyResolve!: (r: Ready) => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<Ready>((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  worker.onmessage = (e: MessageEvent<Response>) => {
    const m = e.data;
    if (m.type === "progress") opts.onProgress(m.done, m.of);
    else if (m.type === "ready") {
      built = true;
      readyResolve(m);
    } else if (m.type === "blocked") blockedQueue.shift()?.resolve({ blocked: m.blocked, unknown: m.unknown } as never);
    else if (m.type === "error") {
      const err = new Error(m.message);
      if (m.id !== undefined) {
        pending.get(m.id)?.reject(err);
        pending.delete(m.id);
      } else if (!built) readyReject(err);
      else blockedQueue.shift()?.reject(err);
    } else {
      const w = pending.get(m.id);
      pending.delete(m.id);
      w?.resolve((m.type === "route" ? { route: m.route, ms: m.ms } : { gaps: m.gaps, ms: m.ms }) as never);
    }
  };

  const ask = <T>(r: Request & { id: number }) =>
    new Promise<T>((resolve, reject) => {
      pending.set(r.id, { resolve: resolve as (v: never) => void, reject });
      send(r);
    });

  send({
    type: "load",
    files: files.map((f) => ({ key: f.key, url: new URL(f.url, location.href).href })),
    heatUrl: opts.heatUrl,
    heatBBox: opts.heatBBox,
    blocked: opts.blocked,
  });

  return {
    ready,
    route: (r) => ask({ type: "route", id: ++nextId, ...r }),
    gaps: (point, limit, o) =>
      ask({
        type: "gaps",
        id: ++nextId,
        point,
        limit,
        roadsOnly: o.roadsOnly,
        skipDead: o.skipDead,
        heatMode: o.heatMode,
        pavedOnly: o.pavedOnly,
        avoidMain: o.avoidMain,
      }),
    setBlocked: (ids) =>
      new Promise<BlockedCount>((resolve, reject) => {
        blockedQueue.push({ resolve: resolve as (v: never) => void, reject });
        send({ type: "blocked", ids });
      }),
  };
}
