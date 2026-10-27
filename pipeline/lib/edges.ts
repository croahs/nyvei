// Ways -> edges. An edge is the piece of a way between two nodes that are
// shared with another way (or the way's own ends), so every intersection
// starts a new edge.

import { TIER, type Tier } from "../config";
import { bboxOf, lineLength, pointInPolygon, type BBox, type LonLat, type Polygon } from "./geo";
import type { OverpassWay } from "./overpass";

export interface Edge {
  /** `<way id>_<index within way>` */
  id: string;
  way: number;
  coords: LonLat[];
  /** metres */
  length: number;
  tier: Tier;
  /** kommune slug, or null for edges fetched for a ride outside the region */
  kommune: string | null;
  highway: string;
  tags: Record<string, string>;
  bbox: BBox;
}

export interface SourcedWay {
  way: OverpassWay;
  /** Candidate kommuner, in config order; more than one when the way sits on a border. */
  kommuner: string[];
}

export interface SplitResult {
  edges: Edge[];
  /** highway values with no tier, with way counts, for the roads report */
  dropped: Map<string, number>;
}

export function splitWays(ways: SourcedWay[], polygons: Map<string, Polygon>): SplitResult {
  const nodeUse = new Map<number, number>();
  for (const { way } of ways) {
    for (const n of way.nodes) nodeUse.set(n, (nodeUse.get(n) ?? 0) + 1);
  }
  const edges: Edge[] = [];
  const dropped = new Map<string, number>();
  for (const { way, kommuner } of ways) {
    const tags = way.tags ?? {};
    const highway = tags.highway ?? "";
    const tier = TIER[highway];
    if (!tier) {
      dropped.set(highway, (dropped.get(highway) ?? 0) + 1);
      continue;
    }
    if (way.nodes.length !== way.geometry.length || way.nodes.length < 2) continue;
    let start = 0;
    let index = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const last = i === way.nodes.length - 1;
      if (!last && (nodeUse.get(way.nodes[i]!) ?? 0) < 2) continue;
      const coords = way.geometry.slice(start, i + 1).map((p) => [p.lon, p.lat] as LonLat);
      const length = lineLength(coords);
      if (length > 0) {
        edges.push({
          id: `${way.id}_${index}`,
          way: way.id,
          coords,
          length,
          tier,
          kommune: pickKommune(kommuner, coords, polygons),
          highway,
          tags,
          bbox: bboxOf(coords),
        });
      }
      index++;
      start = i;
    }
  }
  return { edges, dropped };
}

function pickKommune(kommuner: string[], coords: LonLat[], polygons: Map<string, Polygon>): string | null {
  if (kommuner.length === 0) return null;
  if (kommuner.length === 1) return kommuner[0]!;
  const mid = coords[Math.floor(coords.length / 2)]!;
  for (const k of kommuner) {
    const poly = polygons.get(k);
    if (poly && pointInPolygon(mid, poly)) return k;
  }
  return kommuner[0]!;
}

export function kmByTier(edges: Iterable<Edge>, pick: (e: Edge) => boolean = () => true): Record<Tier, number> {
  const km: Record<Tier, number> = { countable: 0, bonus: 0 };
  for (const e of edges) if (pick(e)) km[e.tier] += e.length / 1000;
  return km;
}
