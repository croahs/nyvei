// Overpass client plus the two query shapes the pipeline uses.

import { HIGHWAY_FILTER, OVERPASS_URL, USER_AGENT } from "../config";
import type { BBox, LonLat } from "./geo";

export interface OverpassWay {
  type: "way";
  id: number;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface OverpassRelationMember {
  type: "way" | "node" | "relation";
  ref: number;
  role: string;
  geometry?: { lat: number; lon: number }[];
}

export interface OverpassRelation {
  type: "relation";
  id: number;
  members: OverpassRelationMember[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: (OverpassWay | OverpassRelation | { type: "node" })[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST a query; retries on the usual Overpass overload responses. */
export async function overpass(
  query: string,
  label: string,
): Promise<{ data: OverpassResponse; bytes: number; ms: number }> {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    });
    if (res.ok) {
      const text = await res.text();
      let data: OverpassResponse;
      try {
        data = JSON.parse(text) as OverpassResponse;
      } catch {
        throw new Error(`Overpass ${label}: response is not JSON (${text.slice(0, 200)})`);
      }
      if (!Array.isArray(data.elements)) throw new Error(`Overpass ${label}: no elements in response`);
      return { data, bytes: Buffer.byteLength(text), ms: Date.now() - started };
    }
    // 429 too many requests, 502 server at capacity, 503/504 overloaded: back off and retry.
    const retryable = [429, 502, 503, 504].includes(res.status);
    if (!retryable || attempt >= 6) {
      throw new Error(`Overpass ${label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const wait = 20_000 * 2 ** (attempt - 1);
    console.warn(`  overpass ${label}: HTTP ${res.status}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

/** The kommune boundary relation (with member geometry) plus every road in it. */
export function kommuneQuery(ref: string): string {
  return `[out:json][timeout:300];
rel["boundary"="administrative"]["admin_level"="7"]["ref"="${ref}"]->.r;
.r map_to_area->.a;
(
  .r;
  way(area.a)${HIGHWAY_FILTER};
);
out geom;`;
}

/** Every road touching a bounding box. */
export function bboxQuery(b: BBox): string {
  const box = [b.minLat, b.minLon, b.maxLat, b.maxLon].map((v) => v.toFixed(6)).join(",");
  return `[out:json][timeout:300];
way(${box})${HIGHWAY_FILTER};
out geom;`;
}

export function waysOf(data: OverpassResponse): OverpassWay[] {
  return data.elements.filter((e): e is OverpassWay => e.type === "way" && "geometry" in e);
}

export function relationsOf(data: OverpassResponse): OverpassRelation[] {
  return data.elements.filter((e): e is OverpassRelation => e.type === "relation");
}

/**
 * Stitch a boundary relation's outer ways into closed rings. Ways are chained
 * by matching end points; a ring that fails to close is kept as is, which the
 * ray-casting test tolerates.
 */
export function outerRings(rel: OverpassRelation): LonLat[][] {
  const pieces: LonLat[][] = rel.members
    .filter((m) => m.type === "way" && m.role === "outer" && m.geometry && m.geometry.length > 1)
    .map((m) => m.geometry!.map((p) => [p.lon, p.lat] as LonLat));
  const key = (p: LonLat) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const rings: LonLat[][] = [];
  const used: boolean[] = new Array(pieces.length).fill(false);
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const ring = [...pieces[i]!];
    for (;;) {
      if (key(ring[0]!) === key(ring[ring.length - 1]!)) break;
      const tail = key(ring[ring.length - 1]!);
      let extended = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        const p = pieces[j]!;
        if (key(p[0]!) === tail) {
          ring.push(...p.slice(1));
        } else if (key(p[p.length - 1]!) === tail) {
          ring.push(...p.slice(0, -1).reverse());
        } else continue;
        used[j] = true;
        extended = true;
        break;
      }
      if (!extended) break;
    }
    rings.push(ring);
  }
  return rings;
}
