// Loader for the files pipeline/match.ts writes under public/data/.
//
// Edge files (kommuner/<slug>.json, outside.json) are GeoJSON LineStrings with
// short property names, mirrored from the comment at the top of match.ts:
//   i id, a from node, b to node, c 1 countable / 0 bonus, h highway, n name,
//   l length (m), d first ridden date, r first activity id, p 1 if counted as
//   new km for that ride. n, d, r and p are absent when empty.
// MapLibre fetches and parses the edge files in its worker; only stats.json and
// the selected ride's track are parsed here.

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
  if (stats.outside.boxes.length) files.push({ key: "outside", url: `${base}/outside.json`, boxes: stats.outside.boxes });
  return files;
}

/** A ride's thinned track as segments: one, or more where the privacy zone cut it. */
export async function loadTrack(id: string): Promise<[number, number][][]> {
  const res = await fetch(`${base}/tracks/${id}.json`);
  if (!res.ok) throw new Error(`track ${id}: HTTP ${res.status}`);
  return res.json();
}
