// Pipeline configuration. Decisions live in PLAN.md; this file only encodes them.

export const INTERVALS_URL = "https://intervals.icu";
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const USER_AGENT = "nyvei/0.1 (personal ride coverage pipeline)";

/** First ride in Intervals.icu; nothing older exists. */
export const OLDEST = "2024-06-01";

/** Intervals.icu activity types that count as rides. VirtualRide is deliberately absent. */
export const RIDE_TYPES = new Set(["Ride", "GravelRide", "MountainBikeRide", "EBikeRide"]);

export type Tier = "countable" | "bonus";

/** Tier by OSM highway value. Values missing here are dropped; roads.ts reports them. */
export const TIER: Record<string, Tier> = {
  trunk: "countable",
  trunk_link: "countable",
  primary: "countable",
  primary_link: "countable",
  secondary: "countable",
  secondary_link: "countable",
  tertiary: "countable",
  tertiary_link: "countable",
  unclassified: "countable",
  residential: "countable",
  living_street: "countable",
  cycleway: "countable",
  track: "bonus",
  path: "bonus",
  bridleway: "bonus",
  footway: "bonus",
  pedestrian: "bonus",
  service: "bonus",
};

/**
 * Tag values that drop a way on every tier. Applied in the Overpass query and
 * again when splitting cached data, so a cache fetched before a rule was added
 * still gives the same edges.
 */
export const EXCLUDE: Record<string, string[]> = {
  highway: ["motorway", "motorway_link", "steps"],
  access: ["no", "private"],
  bicycle: ["no"],
  /** Norwegian motortrafikkvei. */
  motorroad: ["yes"],
};

/** Overpass filter shared by kommune and ride-box queries. */
export const HIGHWAY_FILTER =
  '["highway"]' + Object.entries(EXCLUDE).map(([k, v]) => `["${k}"!~"^(${v.join("|")})$"]`).join("");

export function isExcluded(tags: Record<string, string>): boolean {
  return Object.entries(EXCLUDE).some(([k, v]) => tags[k] !== undefined && v.includes(tags[k]!));
}

export const MATCH = {
  /** A track point this close to an edge sample counts as covering it (m). */
  radiusM: 15,
  /** Edge sampling interval (m). */
  sampleM: 10,
  /** Fraction of samples that must be covered for the edge to count as ridden. */
  coverage: 0.8,
  /** Padding around the part of a ride outside the region before fetching roads (m). */
  outsidePadM: 1000,
  /** A ride box wider than this is a GPS glitch or a car transfer, not a ride; it is skipped with a warning. */
  maxOutsideBoxKm: 150,
  /** Track densification spacing (m); gaps longer than maxGapM are not interpolated. */
  densifyM: 5,
  maxGapM: 200,
};

export interface Kommune {
  /** Display name as in OSM. */
  name: string;
  /** Norwegian kommune number, the `ref` tag on the OSM admin_level=7 relation. */
  ref: string;
  /** ASCII file-safe id used for cache files and stats keys. */
  slug: string;
}

/** Rogaland's 23 kommuner. Adding a region later is adding rows here. */
export const KOMMUNER: Kommune[] = [
  { name: "Sandnes", ref: "1108", slug: "sandnes" },
  { name: "Stavanger", ref: "1103", slug: "stavanger" },
  { name: "Sola", ref: "1124", slug: "sola" },
  { name: "Randaberg", ref: "1127", slug: "randaberg" },
  { name: "Klepp", ref: "1120", slug: "klepp" },
  { name: "Time", ref: "1121", slug: "time" },
  { name: "Gjesdal", ref: "1122", slug: "gjesdal" },
  { name: "Hå", ref: "1119", slug: "ha" },
  { name: "Bjerkreim", ref: "1114", slug: "bjerkreim" },
  { name: "Eigersund", ref: "1101", slug: "eigersund" },
  { name: "Sokndal", ref: "1111", slug: "sokndal" },
  { name: "Lund", ref: "1112", slug: "lund" },
  { name: "Strand", ref: "1130", slug: "strand" },
  { name: "Hjelmeland", ref: "1133", slug: "hjelmeland" },
  { name: "Suldal", ref: "1134", slug: "suldal" },
  { name: "Sauda", ref: "1135", slug: "sauda" },
  { name: "Kvitsøy", ref: "1144", slug: "kvitsoy" },
  { name: "Bokn", ref: "1145", slug: "bokn" },
  { name: "Tysvær", ref: "1146", slug: "tysvaer" },
  { name: "Karmøy", ref: "1149", slug: "karmoy" },
  { name: "Haugesund", ref: "1106", slug: "haugesund" },
  { name: "Utsira", ref: "1151", slug: "utsira" },
  { name: "Vindafjord", ref: "1160", slug: "vindafjord" },
];

export const PATHS = {
  activities: "cache/activities",
  manifest: "cache/activities/manifest.json",
  roads: "cache/roads",
  /** One edge file per kommune, <slug>.json */
  kommunerOut: "web/public/data/kommuner",
  /** Edges with no kommune (fetched for rides outside the region), one file per ride box: <index>.json */
  outsideOut: "web/public/data/outside",
  /** One thinned track per ride, <activity id>.json, loaded when a ride is selected */
  tracksOut: "web/public/data/tracks",
  statsOut: "web/public/data/stats.json",
};

/**
 * Strava global heatmap, merged in from gravelheater. Raw tiles are 512 px
 * greyscale per sport layer; black is no data. Personal use only.
 */
export const HEAT = {
  /** [west, south, east, north]. gravelheater's "sandnes" area: Egersund to Nord-Jæren and Suleskard. */
  bbox: [5.5, 58.4, 7.0, 59.15] as [number, number, number, number],
  /** Tile zoom; 15 is about 2.4 m/px here. `--zoom N` overrides. */
  zoom: 15,
  /** Lowest zoom of the overlay pyramid. */
  minZoom: 9,
  size: 512,
  sports: { gravel: "sport_GravelRide", road: "sport_Ride", mtb: "sport_MountainBikeRide" } as Record<string, string>,
  /** `missing=empty` returns a tiny transparent PNG instead of 404 where there is no data. */
  tileUrl: (sport: string, z: number, x: number, y: number) =>
    `https://content-a.strava.com/identified/globalheat/${sport}/grayscale/${z}/${x}/${y}.png?v=20&missing=empty`,
  requestDelayMs: [100, 222] as [number, number],
  concurrency: 4,
  /** Below this a layer is noise (one lone ride). */
  minSignal: 0.08,
  /** road + epsilon in the gravel ratio denominator. */
  epsilon: 0.05,
  /** Display curve: any pixel with signal gets at least alphaFloor, the rest is lifted by alphaGamma (< 1 lifts). */
  alphaFloor: 0.35,
  alphaGamma: 0.5,
  colors: { gravel: [250, 176, 5], offroad: [21, 170, 191] } as Record<string, [number, number, number]>,
  /** Edge heat: a sample reads the brightest pixel within ± this many px (about ±5 m at zoom 15). */
  windowPx: 2,
  sampleM: 10,
  /** Tile positions kept decoded (all three layers, up to 0.8 MB each) while sampling edges. */
  cacheTiles: 600,
};

export const HEAT_PATHS = {
  /** Raw Strava tiles, <layer>/<z>/<x>/<y>.png, same layout as gravelheater's tiles/. */
  raw: "cache/heat/raw",
  /** Overlay tiles and meta.json; served at /heat/ by web/vite.config.ts. */
  tiles: "cache/heat/tiles",
};
