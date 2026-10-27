// Road caches under cache/roads: one raw Overpass response per kommune, and
// one per ride that left the region.

import { existsSync, readdirSync, statSync } from "node:fs";
import { PATHS } from "../config";
import { bboxOf, type BBox, type Polygon } from "./geo";
import { readJson } from "./fs";
import { outerRings, relationsOf, waysOf, type OverpassResponse, type OverpassWay } from "./overpass";

export function kommuneCachePath(slug: string): string {
  return `${PATHS.roads}/${slug}.json`;
}

export function rideCachePath(id: string): string {
  return `${PATHS.roads}/ride-${id}.json`;
}

export interface KommuneRoads {
  ways: OverpassWay[];
  polygon: Polygon;
  bytes: number;
}

export function loadKommuneRoads(slug: string): KommuneRoads | undefined {
  const path = kommuneCachePath(slug);
  const data = readJson<OverpassResponse>(path);
  if (!data) return undefined;
  const rel = relationsOf(data)[0];
  if (!rel) throw new Error(`${path}: no boundary relation in cache; rerun pnpm roads ${slug} --refresh`);
  const rings = outerRings(rel);
  const polygon: Polygon = { rings, bbox: bboxOf(rings.flat()) };
  return { ways: waysOf(data), polygon, bytes: statSync(path).size };
}

export interface RideRoads {
  activity: string;
  /** The padded box that was queried. */
  bbox: BBox;
  fetched: string;
  data: OverpassResponse;
}

export function loadRideRoads(): RideRoads[] {
  if (!existsSync(PATHS.roads)) return [];
  return readdirSync(PATHS.roads)
    .filter((f) => f.startsWith("ride-") && f.endsWith(".json"))
    .map((f) => readJson<RideRoads>(`${PATHS.roads}/${f}`)!);
}
