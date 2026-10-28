// pnpm match [slug ...] [--skip-outside] [--no-zone]: match every cached ride
// against the road edges and write the site's data under web/public/data/: one
// edge file per kommune, outside.json, one track per ride and stats.json.
//
// Published data never points at home: PRIVACY_ZONE (lat,lon,radius_m, from
// .env or the environment) drops every edge with a point inside the circle
// from the edge files and cuts the tracks there. Without it, match refuses to
// write; --no-zone is the explicit escape hatch for a local-only run.
//
// Pass 1 makes sure every ride has roads: points outside the loaded kommuner
// (and outside earlier ride boxes) get an Overpass fetch for their bounding
// box plus padding, cached as cache/roads/ride-<id>.json. --skip-outside only
// reports those rides, for runs with a partial kommune list.
// Pass 2 builds edges from all cached ways and matches rides oldest first, so
// the first ride over an edge owns it. Two rules per ride: an edge is *ridden*
// when any track point within 15 m covers 80 % of its samples (so a road and
// the cycleway beside it clear together), and *primary* when the track points
// whose nearest edge it is cover 80 % (so new km per ride counts the way
// actually ridden, not its neighbours).
//
// Edge files (kommuner/<slug>.json, outside/<box>.json) are GeoJSON FeatureCollections
// of LineStrings with 5-decimal coordinates and short property names:
//   i  edge id, `<way id>_<index>`       a  OSM node id at the start (`from`)
//   b  OSM node id at the end (`to`)     c  1 countable, 0 bonus
//   h  highway                           n  name, absent when the way has none
//   l  length in metres                  d  first ridden date, absent when unridden
//   r  first activity id, absent when unridden
//   p  1 when the first ride counted the edge as new km (primary), else absent
// The kommune is the file name; outside files are numbered like the ride boxes
// in stats.json. Files stay under 25 MB, Cloudflare Pages' limit per file.
// web/src/data.ts mirrors this mapping.

import { readFileSync, rmSync } from "node:fs";
import Flatbush from "flatbush";
import { KOMMUNER, MATCH, PATHS, type Tier } from "./config";
import { kmByTier, splitWays, type Edge, type SourcedWay } from "./lib/edges";
import {
  bboxContains,
  bboxOf,
  haversine,
  LocalProjection,
  nearestOnPolyline,
  padBBox,
  pointInPolygon,
  samplePolyline,
  type BBox,
  type LonLat,
  type Polygon,
  type XY,
} from "./lib/geo";
import { loadEnv, privacyZone } from "./lib/env";
import { mb, parseArgs, writeJson } from "./lib/fs";
import { parseGpxTrack } from "./lib/gpx";
import { gpxPath, loadManifest, ridesWithGpx, type ManifestEntry } from "./lib/manifest";
import { bboxQuery, overpass, waysOf } from "./lib/overpass";
import { loadKommuneRoads, loadRideRoads, rideCachePath, type RideRoads } from "./lib/roadcache";

interface Track {
  ride: ManifestEntry;
  points: LonLat[];
}

interface Ridden {
  first_date: string;
  first_activity: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const km = (m: number) => (m / 1000).toFixed(1);

/** Region membership memoised on a ~100 m grid; borders are padded by 1 km anyway. */
function makeRegionTest(polygons: Polygon[]): (p: LonLat) => boolean {
  const memo = new Map<string, boolean>();
  return (p) => {
    const key = `${Math.floor(p[0] * 500)}_${Math.floor(p[1] * 1000)}`;
    let v = memo.get(key);
    if (v === undefined) {
      v = polygons.some((poly) => pointInPolygon(p, poly));
      memo.set(key, v);
    }
    return v;
  };
}

/** Insert points so consecutive track points are at most `step` apart; GPS gaps stay gaps. */
function densify(xy: XY[], step: number, maxGap: number): XY[] {
  const out: XY[] = [xy[0]!];
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]!;
    const [bx, by] = xy[i]!;
    const d = Math.hypot(bx - ax, by - ay);
    if (d > step && d <= maxGap) {
      const n = Math.ceil(d / step);
      for (let k = 1; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    out.push([bx, by]);
  }
  return out;
}

async function ensureRoadsForRides(
  tracks: Track[],
  inRegion: (p: LonLat) => boolean,
  rideRoads: RideRoads[],
  skipOutside: boolean,
): Promise<void> {
  const boxes = rideRoads.map((r) => r.bbox);
  for (const { ride, points } of tracks) {
    const outside: LonLat[] = [];
    for (let i = 0; i < points.length; i += 5) {
      const p = points[i]!;
      if (inRegion(p) || boxes.some((b) => bboxContains(b, p))) continue;
      outside.push(p);
    }
    if (outside.length === 0) continue;
    const bbox = padBBox(bboxOf(outside), MATCH.outsidePadM);
    const where = `${ride.date.slice(0, 10)} ${ride.id} "${ride.name}"`;
    if (skipOutside) {
      console.log(`  outside region, not fetched: ${where} (${outside.length * 5} points)`);
      continue;
    }
    const sideKm = Math.max((bbox.maxLat - bbox.minLat) * 111, (bbox.maxLon - bbox.minLon) * 111 * Math.cos((bbox.minLat * Math.PI) / 180));
    if (sideKm > MATCH.maxOutsideBoxKm) {
      console.warn(`  outside region, box ${sideKm.toFixed(0)} km wide is over the limit, skipped: ${where}`);
      continue;
    }
    const { data, bytes, ms } = await overpass(bboxQuery(bbox), ride.id);
    const cached: RideRoads = { activity: ride.id, bbox, fetched: new Date().toISOString(), data };
    writeJson(rideCachePath(ride.id), cached);
    rideRoads.push(cached);
    boxes.push(bbox);
    console.log(`  outside region: ${where}: fetched ${waysOf(data).length} ways, ${mb(bytes)} in ${(ms / 1000).toFixed(0)} s`);
    await sleep(2000);
  }
}

function collectWays(slugs: string[], polygons: Map<string, Polygon>, rideRoads: RideRoads[]): SourcedWay[] {
  const byId = new Map<number, SourcedWay>();
  for (const slug of slugs) {
    for (const way of loadKommuneRoads(slug)!.ways) {
      const seen = byId.get(way.id);
      if (seen) seen.kommuner.push(slug);
      else byId.set(way.id, { way, kommuner: [slug] });
    }
  }
  let outsideWays = 0;
  for (const r of rideRoads) {
    for (const way of waysOf(r.data)) {
      if (byId.has(way.id)) continue;
      byId.set(way.id, { way, kommuner: [] });
      outsideWays++;
    }
  }
  void polygons;
  if (rideRoads.length) console.log(`${outsideWays} ways from ${rideRoads.length} ride box(es) outside the region`);
  return [...byId.values()];
}

interface RideMatch {
  /** edges marked ridden by this ride (blanket rule) */
  matched: number;
  /** ids of edges this ride was the nearest edge for */
  primary: Set<string>;
}

function matchRide(track: Track, edges: Edge[], index: Flatbush, ridden: Map<string, Ridden>): RideMatch {
  const { ride, points } = track;
  const primary = new Set<string>();
  const tb = bboxOf(points);
  const proj = new LocalProjection((tb.minLon + tb.maxLon) / 2, (tb.minLat + tb.maxLat) / 2);
  const xy = densify(points.map((p) => proj.project(p)), MATCH.densifyM, MATCH.maxGapM);
  const trackIndex = new Flatbush(xy.length);
  for (const [x, y] of xy) trackIndex.add(x, y, x, y);
  trackIndex.finish();

  const r = MATCH.radiusM;
  const search = padBBox(tb, r);
  const candidates = index.search(search.minLon, search.minLat, search.maxLon, search.maxLat);
  if (candidates.length === 0) return { matched: 0, primary };

  // Project the candidates once, in metres, and index them for the nearest-edge pass.
  const exyOf = new Map<number, XY[]>();
  const boxOf = new Map<number, [number, number, number, number]>();
  const candIndex = new Flatbush(candidates.length);
  for (const ei of candidates) {
    const exy = edges[ei]!.coords.map((p) => proj.project(p));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of exy) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    exyOf.set(ei, exy);
    boxOf.set(ei, [minX, minY, maxX, maxY]);
    candIndex.add(minX, minY, maxX, maxY);
  }
  candIndex.finish();

  // Ridden: any track point within r covers 80 % of the samples.
  let matched = 0;
  const sampleCount = new Map<number, number>();
  for (const ei of candidates) {
    const [minX, minY, maxX, maxY] = boxOf.get(ei)!;
    let near = false;
    trackIndex.search(minX - r, minY - r, maxX + r, maxY + r, () => {
      near = true;
      return false;
    });
    if (!near) continue;
    const samples = samplePolyline(exyOf.get(ei)!, MATCH.sampleM);
    sampleCount.set(ei, samples.length);
    const need = Math.ceil(samples.length * MATCH.coverage);
    let covered = 0;
    for (let i = 0; i < samples.length; i++) {
      if (covered + (samples.length - i) < need) break;
      const [sx, sy] = samples[i]!;
      if (trackIndex.neighbors(sx, sy, 1, r).length > 0) covered++;
    }
    if (covered < need) continue;
    matched++;
    const edge = edges[ei]!;
    if (!ridden.has(edge.id)) ridden.set(edge.id, { first_date: ride.date.slice(0, 10), first_activity: ride.id });
  }

  // Primary: each track point credits only its nearest edge, at the sample it projects onto.
  const credits = new Map<number, Set<number>>();
  for (const [x, y] of xy) {
    let best = -1;
    let bestD = r;
    let bestT = 0;
    candIndex.search(x - r, y - r, x + r, y + r, (ci) => {
      const ei = candidates[ci]!;
      const { d, t } = nearestOnPolyline(exyOf.get(ei)!, x, y);
      if (d < bestD) {
        bestD = d;
        best = ei;
        bestT = t;
      }
      return false;
    });
    if (best < 0) continue;
    let set = credits.get(best);
    if (!set) credits.set(best, (set = new Set()));
    set.add(Math.round(bestT / MATCH.sampleM));
  }
  for (const [ei, set] of credits) {
    const n = sampleCount.get(ei) ?? samplePolyline(exyOf.get(ei)!, MATCH.sampleM).length;
    if (Math.min(set.size, n) >= Math.ceil(n * MATCH.coverage)) primary.add(edges[ei]!.id);
  }
  return { matched, primary };
}

async function main(): Promise<void> {
  const started = Date.now();
  const { slugs, flags } = parseArgs(process.argv.slice(2));
  loadEnv();
  const zone = flags.has("no-zone") ? null : privacyZone();
  if (zone === undefined) {
    throw new Error(
      "PRIVACY_ZONE is not set, so nothing is written under web/public/data/. Set it in .env as lat,lon,radius_m, or pass --no-zone for a local-only run.",
    );
  }
  const inZone = (p: LonLat): boolean => zone !== null && haversine(p, [zone.lon, zone.lat]) <= zone.radiusM;
  const unknown = slugs.filter((s) => !KOMMUNER.some((k) => k.slug === s));
  if (unknown.length) throw new Error(`unknown kommune slug(s): ${unknown.join(", ")}`);
  const targets = slugs.length ? KOMMUNER.filter((k) => slugs.includes(k.slug)) : KOMMUNER;

  const polygons = new Map<string, Polygon>();
  for (const k of targets) {
    const roads = loadKommuneRoads(k.slug);
    if (!roads) throw new Error(`no roads cached for ${k.name}; run pnpm roads ${k.slug}`);
    polygons.set(k.slug, roads.polygon);
  }

  const manifest = loadManifest();
  const tracks: Track[] = [];
  for (const ride of ridesWithGpx(manifest)) {
    const points = parseGpxTrack(readFileSync(gpxPath(ride.id), "utf8"));
    if (points.length > 1) tracks.push({ ride, points });
  }
  console.log(`${tracks.length} rides with tracks, ${targets.length} kommune(r) loaded`);

  const rideRoads = loadRideRoads();
  await ensureRoadsForRides(tracks, makeRegionTest([...polygons.values()]), rideRoads, flags.has("skip-outside"));

  const ways = collectWays(targets.map((k) => k.slug), polygons, rideRoads);
  const { edges } = splitWays(ways, polygons);
  const index = new Flatbush(edges.length);
  for (const e of edges) index.add(e.bbox.minLon, e.bbox.minLat, e.bbox.maxLon, e.bbox.maxLat);
  index.finish();
  console.log(`${edges.length} edges from ${ways.length} ways; matching...`);

  const ridden = new Map<string, Ridden>();
  /** edges whose first ride was also primary for them, i.e. counted as new km */
  const counted = new Set<string>();
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const rides: {
    id: string;
    name: string;
    date: string;
    distance_km: number;
    new_countable_km: number;
    new_bonus_km: number;
    matched_edges: number;
  }[] = [];
  for (const track of tracks) {
    const { ride } = track;
    const { matched, primary } = matchRide(track, edges, index, ridden);
    // New km: primary edges this ride was the first to ride.
    const fresh: Record<Tier, number> = { countable: 0, bonus: 0 };
    for (const id of primary) {
      if (ridden.get(id)?.first_activity !== ride.id) continue;
      counted.add(id);
      const e = edgeById.get(id)!;
      fresh[e.tier] += e.length;
    }
    rides.push({
      id: ride.id,
      name: ride.name,
      date: ride.date,
      distance_km: Number((ride.distance / 1000).toFixed(1)),
      new_countable_km: Number(km(fresh.countable)),
      new_bonus_km: Number(km(fresh.bonus)),
      matched_edges: matched,
    });
    console.log(
      `${ride.date.slice(0, 10)} ${ride.id} ${km(ride.distance).padStart(6)} km  new ${km(fresh.countable).padStart(5)} + ${km(fresh.bonus).padStart(5)} km  ${matched} edges  ${ride.name}`,
    );
  }

  // Stats: percent is countable only and kommune only; outside edges count as new km but toward no percent.
  const isRidden = (e: Edge) => ridden.has(e.id);
  const kommuner: Record<string, unknown> = {};
  const bboxByKommune = new Map<string | null, BBox>();
  for (const e of edges) {
    const b = bboxByKommune.get(e.kommune);
    if (!b) bboxByKommune.set(e.kommune, { ...e.bbox });
    else {
      b.minLon = Math.min(b.minLon, e.bbox.minLon);
      b.minLat = Math.min(b.minLat, e.bbox.minLat);
      b.maxLon = Math.max(b.maxLon, e.bbox.maxLon);
      b.maxLat = Math.max(b.maxLat, e.bbox.maxLat);
    }
  }
  const total = { countable_km: 0, countable_ridden_km: 0, bonus_km: 0, bonus_ridden_km: 0 };
  for (const k of targets) {
    const own = edges.filter((e) => e.kommune === k.slug);
    const all = kmByTier(own);
    const done = kmByTier(own, isRidden);
    kommuner[k.slug] = {
      name: k.name,
      countable_km: round(all.countable),
      countable_ridden_km: round(done.countable),
      percent: round(all.countable ? (100 * done.countable) / all.countable : 0),
      bonus_km: round(all.bonus),
      bonus_ridden_km: round(done.bonus),
      bbox: bboxArray(bboxByKommune.get(k.slug)),
    };
    total.countable_km += all.countable;
    total.countable_ridden_km += done.countable;
    total.bonus_km += all.bonus;
    total.bonus_ridden_km += done.bonus;
  }
  const outsideDone = kmByTier(edges.filter((e) => e.kommune === null), isRidden);
  const stats = {
    generated: new Date().toISOString(),
    total: {
      countable_km: round(total.countable_km),
      countable_ridden_km: round(total.countable_ridden_km),
      percent: round(total.countable_km ? (100 * total.countable_ridden_km) / total.countable_km : 0),
      bonus_km: round(total.bonus_km),
      bonus_ridden_km: round(total.bonus_ridden_km),
      outside_ridden_km: { countable: round(outsideDone.countable), bonus: round(outsideDone.bonus) },
    },
    kommuner,
    /** Where outside.json has edges: the ride boxes fetched outside the region. */
    outside: { boxes: rideRoads.map((r) => bboxArray(r.bbox)) },
    rides,
  };

  // Edge files grouped by kommune, or by ride box for edges outside the region;
  // see the property map at the top of this file. Edges touching the privacy
  // zone are left out; they still count in the stats above.
  const outsideBoxes = rideRoads.map((r) => r.bbox);
  const outsideFile = (e: Edge): string => {
    let i = outsideBoxes.findIndex((b) => e.coords.some((p) => bboxContains(b, p)));
    if (i < 0) {
      // Overpass returns ways that only touch the box; file them with the nearest box.
      const [lon, lat] = e.coords[0]!;
      let bestD = Infinity;
      outsideBoxes.forEach((b, j) => {
        const d = Math.hypot((b.minLon + b.maxLon) / 2 - lon, (b.minLat + b.maxLat) / 2 - lat);
        if (d < bestD) (bestD = d), (i = j);
      });
    }
    return `${PATHS.outsideOut}/${i}.json`;
  };
  const byFile = new Map<string, unknown[]>();
  let zonedEdges = 0;
  for (const e of edges) {
    if (e.coords.some(inZone)) {
      zonedEdges++;
      continue;
    }
    const r = ridden.get(e.id);
    const file = e.kommune === null ? outsideFile(e) : `${PATHS.kommunerOut}/${e.kommune}.json`;
    let list = byFile.get(file);
    if (!list) byFile.set(file, (list = []));
    list.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: e.coords.map(([lon, lat]) => [round5(lon), round5(lat)]) },
      properties: {
        i: e.id,
        a: e.from,
        b: e.to,
        c: e.tier === "countable" ? 1 : 0,
        h: e.highway,
        n: e.tags.name,
        l: Math.round(e.length),
        d: r?.first_date,
        r: r?.first_activity,
        p: counted.has(e.id) ? 1 : undefined,
      },
    });
  }
  // Clear the old output first so a shorter kommune list or an older layout leaves nothing stale.
  for (const path of [PATHS.kommunerOut, PATHS.tracksOut, PATHS.outsideOut, "web/public/data/edges.json", "web/public/data/outside.json"]) {
    rmSync(path, { recursive: true, force: true });
  }
  let edgesBytes = 0;
  for (const [path, features] of byFile) edgesBytes += writeJson(path, { type: "FeatureCollection", features });

  // Tracks for the ride highlight, thinned to a point every 10 m and cut where
  // they enter the privacy zone, so each file is a list of segments.
  let trackBytes = 0;
  let zonedPoints = 0;
  for (const { ride, points } of tracks) {
    const kept: LonLat[] = [points[0]!];
    for (const p of points) if (haversine(kept[kept.length - 1]!, p) >= 10) kept.push(p);
    const segments: number[][][] = [];
    let segment: number[][] = [];
    for (const p of kept) {
      if (inZone(p)) {
        zonedPoints++;
        if (segment.length > 1) segments.push(segment);
        segment = [];
        continue;
      }
      segment.push([round5(p[0]), round5(p[1])]);
    }
    if (segment.length > 1) segments.push(segment);
    trackBytes += writeJson(`${PATHS.tracksOut}/${ride.id}.json`, segments);
  }
  if (zone) console.log(`privacy zone ${zone.radiusM} m: ${zonedEdges} edges and ${zonedPoints} track points left out`);
  else console.log("no privacy zone (--no-zone): this data is for local use only");
  const statsBytes = writeJson(PATHS.statsOut, stats, true);

  console.log(
    `\n${stats.total.countable_ridden_km} of ${stats.total.countable_km} km countable ridden (${stats.total.percent} %), ` +
      `${stats.total.bonus_ridden_km} of ${stats.total.bonus_km} km bonus, ` +
      `${stats.total.outside_ridden_km.countable + stats.total.outside_ridden_km.bonus} km outside the region`,
  );
  console.log(
    `${byFile.size} edge files ${mb(edgesBytes)}, ${tracks.length} tracks ${mb(trackBytes)}, ` +
      `${PATHS.statsOut} ${mb(statsBytes)}, ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
}

function round(n: number): number {
  return Number(n.toFixed(1));
}
function round5(n: number): number {
  return Number(n.toFixed(5));
}
function bboxArray(b: BBox | undefined): number[] | null {
  return b ? [b.minLon, b.minLat, b.maxLon, b.maxLat].map(round5) : null;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
