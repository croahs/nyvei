// Elevation per edge from Terrarium tiles (config DEM), cached under
// cache/dem/<z>/<x>/<y>.png. match collects the tiles its edges touch, fetches
// the missing ones, then samples synchronously.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { DEM, PATHS, USER_AGENT } from "../config";
import { LocalProjection, type LonLat } from "./geo";

const tilePath = (key: string) => `${PATHS.dem}/${DEM.zoom}/${key}.png`;

/** Global pixel position at the DEM zoom, shifted half a pixel so integers are pixel centres. */
function pixel([lon, lat]: LonLat): [number, number] {
  const n = 2 ** DEM.zoom * DEM.size;
  const rad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [x - 0.5, y - 0.5];
}

/** The four pixels around a point as tile key and index, for bilinear sampling. */
function corners(p: LonLat): { fx: number; fy: number; at: [string, number][] } {
  const [x, y] = pixel(p);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const s = DEM.size;
  const n = 2 ** DEM.zoom * s;
  const at: [string, number][] = [];
  for (const py of [y0, y0 + 1]) {
    const cy = Math.min(n - 1, Math.max(0, py));
    for (const px of [x0, x0 + 1]) {
      const cx = ((px % n) + n) % n;
      at.push([`${Math.floor(cx / s)}/${Math.floor(cy / s)}`, (cy % s) * s + (cx % s)]);
    }
  }
  return { fx: x - x0, fy: y - y0, at };
}

/**
 * Where an edge's elevations are read: n = max(2, ceil(length / stepM) + 1)
 * points evenly spaced from the first coordinate to the last.
 */
export function profilePoints(coords: LonLat[], length: number): LonLat[] {
  const n = Math.max(2, Math.ceil(length / DEM.stepM) + 1);
  const [lon0, lat0] = coords[0]!;
  const proj = new LocalProjection(lon0, lat0);
  const xy = coords.map((p) => proj.project(p));
  const along = [0];
  for (let i = 1; i < xy.length; i++) along.push(along[i - 1]! + Math.hypot(xy[i]![0] - xy[i - 1]![0], xy[i]![1] - xy[i - 1]![1]));
  const total = along[along.length - 1]!;
  const out: LonLat[] = [];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const t = (total * k) / (n - 1);
    while (seg < coords.length - 1 && along[seg]! < t) seg++;
    const span = along[seg]! - along[seg - 1]!;
    const u = span > 0 ? Math.min(1, Math.max(0, (t - along[seg - 1]!) / span)) : 0;
    const [ax, ay] = coords[seg - 1]!;
    const [bx, by] = coords[seg]!;
    out.push([ax + (bx - ax) * u, ay + (by - ay) * u]);
  }
  return out;
}

/** Tile keys (`x/y`) the bilinear samples at these points read. */
export function tilesFor(points: Iterable<LonLat>, into = new Set<string>()): Set<string> {
  for (const p of points) for (const [key] of corners(p).at) into.add(key);
  return into;
}

/** Fetches the tiles not yet cached. Returns the keys that could not be fetched. */
export async function fetchTiles(keys: Set<string>): Promise<{ fetched: number; failed: Set<string> }> {
  const todo = [...keys].filter((k) => !existsSync(tilePath(k)));
  const failed = new Set<string>();
  let fetched = 0;
  const worker = async () => {
    for (let key = todo.pop(); key !== undefined; key = todo.pop()) {
      const [x, y] = key.split("/");
      try {
        const res = await fetch(DEM.tileUrl(DEM.zoom, Number(x), Number(y)), { headers: { "User-Agent": USER_AGENT } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        // Nothing the sampler would reject may land in the cache, or it is never fetched again:
        // check the decoded size, and write through a temporary name so a failed write leaves no tile.
        const png = PNG.sync.read(buf);
        if (png.width !== DEM.size || png.height !== DEM.size) throw new Error("not a DEM tile");
        mkdirSync(dirname(tilePath(key)), { recursive: true });
        writeFileSync(`${tilePath(key)}.tmp`, buf);
        renameSync(`${tilePath(key)}.tmp`, tilePath(key));
        fetched++;
      } catch {
        failed.add(key);
      }
    }
  };
  await Promise.all(Array.from({ length: DEM.concurrency }, worker));
  return { fetched, failed };
}

/** Bilinear elevation from cached tiles, with an LRU of decoded tiles like HeatSampler's. */
export class DemSampler {
  private cache = new Map<string, Float32Array | null>();

  /** Tiles to treat as missing, e.g. the ones that failed to download. */
  constructor(private readonly missing: Set<string>) {}

  private tile(key: string): Float32Array | null {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    let tile: Float32Array | null = null;
    if (!this.missing.has(key) && existsSync(tilePath(key))) {
      try {
        const png = PNG.sync.read(readFileSync(tilePath(key)));
        if (png.width === DEM.size && png.height === DEM.size) {
          tile = new Float32Array(DEM.size * DEM.size);
          for (let i = 0; i < tile.length; i++) {
            tile[i] = png.data[i * 4]! * 256 + png.data[i * 4 + 1]! + png.data[i * 4 + 2]! / 256 - 32768;
          }
        }
      } catch {
        tile = null;
      }
      if (!tile) {
        // An unreadable cached tile is removed so the next run fetches it again.
        this.missing.add(key);
        rmSync(tilePath(key), { force: true });
      }
    }
    this.cache.set(key, tile);
    if (this.cache.size > DEM.cacheTiles) this.cache.delete(this.cache.keys().next().value!);
    return tile;
  }

  /** Elevation in metres, or undefined when a tile it needs is missing. */
  at(p: LonLat): number | undefined {
    const { fx, fy, at } = corners(p);
    const v: number[] = [];
    for (const [key, i] of at) {
      const t = this.tile(key);
      if (!t) return undefined;
      v.push(t[i]!);
    }
    const [a, b, c, d] = v as [number, number, number, number];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  /**
   * Whole metres at profilePoints, or undefined when any is unreadable. With
   * `ends`, only the two ends are read and the rest is a straight line between
   * them: the DEM under a bridge is the water and over a tunnel the hill.
   * Clamped at 0, since a 19 m pixel on the shore blends in the sea floor.
   */
  profile(points: LonLat[], ends: boolean): number[] | undefined {
    const h = (p: LonLat) => this.at(p);
    let z: (number | undefined)[];
    if (ends) {
      const a = h(points[0]!);
      const b = h(points[points.length - 1]!);
      if (a === undefined || b === undefined) return undefined;
      z = points.map((_, k) => a + ((b - a) * k) / (points.length - 1));
    } else z = points.map(h);
    if (z.some((v) => v === undefined)) return undefined;
    return z.map((v) => Math.max(0, Math.round(v!)));
  }
}

/** Bridges and tunnels: the ground under or over them is not the road. */
export function isStructure(tags: Record<string, string>): boolean {
  return tags.tunnel === "yes" || (tags.bridge !== undefined && tags.bridge !== "no");
}
