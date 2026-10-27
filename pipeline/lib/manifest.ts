// The fetch manifest: what Intervals.icu told us about each activity and
// whether its GPX is on disk. Reruns of fetch only touch ids not listed here.

import { PATHS } from "../config";
import { readJson, writeJson } from "./fs";

export interface ManifestEntry {
  id: string;
  name: string;
  type: string;
  /** Local start time, ISO-8601 without zone, as Intervals.icu reports it. */
  date: string;
  /** metres */
  distance: number;
  status: "gpx" | "skipped";
  reason?: string;
}

export interface Manifest {
  updated: string;
  activities: Record<string, ManifestEntry>;
}

export function loadManifest(): Manifest {
  return readJson<Manifest>(PATHS.manifest) ?? { updated: "", activities: {} };
}

export function saveManifest(m: Manifest): void {
  m.updated = new Date().toISOString();
  writeJson(PATHS.manifest, m, true);
}

export function gpxPath(id: string): string {
  return `${PATHS.activities}/${id}.gpx`;
}

/** Rides with a GPX on disk, oldest first. */
export function ridesWithGpx(m: Manifest): ManifestEntry[] {
  return Object.values(m.activities)
    .filter((a) => a.status === "gpx")
    .sort((a, b) => a.date.localeCompare(b.date));
}
