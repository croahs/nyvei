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
