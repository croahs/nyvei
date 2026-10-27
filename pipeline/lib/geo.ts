// Small geometry helpers. Coordinates are [lon, lat] like GeoJSON.

export type LonLat = [number, number];
export type XY = [number, number];
export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const R = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function lineLength(coords: LonLat[]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1]!, coords[i]!);
  return m;
}

export function bboxOf(coords: LonLat[]): BBox {
  const b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const [lon, lat] of coords) {
    if (lon < b.minLon) b.minLon = lon;
    if (lon > b.maxLon) b.maxLon = lon;
    if (lat < b.minLat) b.minLat = lat;
    if (lat > b.maxLat) b.maxLat = lat;
  }
  return b;
}

export function bboxContains(b: BBox, p: LonLat): boolean {
  return p[0] >= b.minLon && p[0] <= b.maxLon && p[1] >= b.minLat && p[1] <= b.maxLat;
}

/** Grow a bbox by `m` metres on every side. */
export function padBBox(b: BBox, m: number): BBox {
  const dLat = m / 111320;
  const midLat = (b.minLat + b.maxLat) / 2;
  const dLon = m / (111320 * Math.cos(midLat * DEG));
  return { minLon: b.minLon - dLon, minLat: b.minLat - dLat, maxLon: b.maxLon + dLon, maxLat: b.maxLat + dLat };
}

/**
 * Local equirectangular projection to metres around a centre point. Good to
 * well under a percent over a ride's extent, which is all the matcher needs.
 */
export class LocalProjection {
  private readonly kx: number;
  private readonly ky = 111320;
  constructor(private readonly lon0: number, private readonly lat0: number) {
    this.kx = 111320 * Math.cos(lat0 * DEG);
  }
  project(p: LonLat): XY {
    return [(p[0] - this.lon0) * this.kx, (p[1] - this.lat0) * this.ky];
  }
}

/** Ray-casting point-in-ring test; the ring may be closed or open. */
export function pointInRing(p: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A polygon as outer rings only; holes are ignored on purpose. */
export interface Polygon {
  rings: LonLat[][];
  bbox: BBox;
}

export function pointInPolygon(p: LonLat, poly: Polygon): boolean {
  if (!bboxContains(poly.bbox, p)) return false;
  return poly.rings.some((r) => pointInRing(p, r));
}

/** Points along a polyline every `step` metres, endpoints included. Input in metres. */
export function samplePolyline(xy: XY[], step: number): XY[] {
  const out: XY[] = [xy[0]!];
  let carry = 0;
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]!;
    const [bx, by] = xy[i]!;
    const seg = Math.hypot(bx - ax, by - ay);
    let d = step - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = xy[xy.length - 1]!;
  const tail = out[out.length - 1]!;
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > 1) out.push(last);
  return out;
}
