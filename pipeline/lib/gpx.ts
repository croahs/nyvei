// Minimal GPX reader: track points only. Intervals.icu GPX is regular enough
// that a regex beats pulling in an XML parser.

import type { LonLat } from "./geo";

const TRKPT = /<trkpt\s+(?:lat="([-\d.]+)"\s+lon="([-\d.]+)"|lon="([-\d.]+)"\s+lat="([-\d.]+)")/g;

export function parseGpxTrack(xml: string): LonLat[] {
  const pts: LonLat[] = [];
  for (const m of xml.matchAll(TRKPT)) {
    const lat = Number(m[1] ?? m[4]);
    const lon = Number(m[2] ?? m[3]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lon, lat]);
  }
  return pts;
}
