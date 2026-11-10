// Loader for the files pipeline/match.ts writes under public/data/.
//
// Edge files (kommuner/<slug>.json, outside/<box>.json) are GeoJSON LineStrings with
// short property names, mirrored from the comment at the top of match.ts:
//   i id, a from node, b to node, c 1 countable / 0 bonus, h highway, n name,
//   l length (m), d first ridden date, r first activity id, p 1 if counted as
//   new km for that ride. n, d, r and p are absent when empty.
// MapLibre fetches and parses the edge files in its worker; only stats.json and
// the selected ride's track are parsed here. Heat comes from the heat project
// (HEAT_BASE): overlay tiles, meta.json and edges.json, joined onto edges by id.

/** Property names in the edge files. */
export const P = {
  id: "i",
  from: "a",
  to: "b",
  countable: "c",
  highway: "h",
  name: "n",
  length: "l",
  firstDate: "d",
  firstActivity: "r",
  counted: "p",
} as const;

/** [minLon, minLat, maxLon, maxLat] */
export type BBox = [number, number, number, number];

export interface KommuneStats {
  name: string;
  countable_km: number;
  countable_ridden_km: number;
  percent: number;
  bonus_km: number;
  bonus_ridden_km: number;
  bbox: BBox | null;
}

export interface RideStats {
  id: string;
  name: string;
  /** ISO date-time of the start */
  date: string;
  distance_km: number;
  new_countable_km: number;
  new_bonus_km: number;
  matched_edges: number;
}

export interface Stats {
  generated: string;
  total: {
    countable_km: number;
    countable_ridden_km: number;
    percent: number;
    bonus_km: number;
    bonus_ridden_km: number;
    outside_ridden_km: { countable: number; bonus: number };
  };
  kommuner: Record<string, KommuneStats>;
  outside: { boxes: BBox[] };
  rides: RideStats[];
}

/** The heat (cache/heat/tiles): the heat branch of the Pages project, the local copy in dev. */
const HEAT_BASE = import.meta.env.DEV ? `${import.meta.env.BASE_URL}heat/` : "https://heat.nyvei.pages.dev/";

/**
 * The heat project serves only to its key (pipeline/heatworker.js). The owner gives it once as
 * ?heat=<key>; it stays in this browser and leaves the address bar. A visitor without it gets the
 * site without heat. Dev reads the local copy and needs none.
 */
const HEAT_KEY = "nyvei.heat-key";
function heatKey(): string | null {
  try {
    const url = new URL(location.href);
    const given = url.searchParams.get("heat");
    if (given !== null) {
      if (given) localStorage.setItem(HEAT_KEY, given);
      else localStorage.removeItem(HEAT_KEY);
      url.searchParams.delete("heat");
      history.replaceState(null, "", url);
    }
    return localStorage.getItem(HEAT_KEY);
  } catch {
    return null;
  }
}
const key = heatKey();
const hasHeat = import.meta.env.DEV || !!key;
/** The absolute URL of a file in the heat project, with the key. */
export const heatUrl = (path: string): string =>
  new URL(HEAT_BASE, location.href).href + path + (import.meta.env.DEV ? "" : `?k=${encodeURIComponent(key ?? "")}`);

/** Overlay tiles from pnpm heat:tiles (meta.json); bbox is also where match sampled edge heat. */
export interface HeatMeta {
  bbox: BBox;
  minzoom: number;
  maxzoom: number;
  /** Layers that stop before maxzoom; the map stretches their last level. */
  layerMaxzoom?: Record<string, number>;
  layers: string[];
  colors: Record<string, string>;
}

/** A JSON file of the heat project, or null when there is none. */
async function heatJson<T>(name: string): Promise<T | null> {
  if (!hasHeat) return null;
  try {
    const res = await fetch(heatUrl(name));
    // Pages answers unknown paths with index.html, so check the type too.
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const loadHeatMeta = () => heatJson<HeatMeta>("meta.json");

/** Heat per edge: [t, tr, tg, to], each 0..100 (pipeline/match.ts); an edge that is missing has none. */
export type EdgeHeatValues = [number, number, number, number];
/** Per edge file key (EdgeFile.key), per edge id. */
export type EdgeHeat = Record<string, Record<string, EdgeHeatValues>>;
export const EDGE_HEAT_URL = heatUrl("edges.json");
let edgeHeat: Promise<EdgeHeat | null> | undefined;
export const loadEdgeHeat = () => (edgeHeat ??= heatJson<EdgeHeat>("edges.json"));

/** One lazily loaded edge file and the boxes it has edges in. */
export interface EdgeFile {
  key: string;
  url: string;
  boxes: BBox[];
}

const base = `${import.meta.env.BASE_URL}data`;

export async function loadStats(): Promise<Stats> {
  const res = await fetch(`${base}/stats.json`);
  if (!res.ok) throw new Error(`stats.json: HTTP ${res.status}. Run pnpm match first.`);
  return res.json();
}

export function edgeFiles(stats: Stats): EdgeFile[] {
  const files: EdgeFile[] = [];
  for (const [slug, k] of Object.entries(stats.kommuner)) {
    if (k.bbox) files.push({ key: slug, url: `${base}/kommuner/${slug}.json`, boxes: [k.bbox] });
  }
  stats.outside.boxes.forEach((box, i) => files.push({ key: `outside-${i}`, url: `${base}/outside/${i}.json`, boxes: [box] }));
  return files;
}

/** A ride's thinned track as segments: one, or more where the privacy zone cut it. */
export async function loadTrack(id: string): Promise<[number, number][][]> {
  const res = await fetch(`${base}/tracks/${id}.json`);
  if (!res.ok) throw new Error(`track ${id}: HTTP ${res.status}`);
  return res.json();
}
