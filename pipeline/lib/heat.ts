// Strava heatmap tiles: slippy-map math, raw tile decoding and per-edge heat.
// Ported from gravelheater (src/tiles.js, src/compute.js, src/graph.js).

import { existsSync, readFileSync, statSync } from "node:fs";
import { PNG } from "pngjs";
import { HEAT, HEAT_PATHS } from "../config";
import { LocalProjection, samplePolyline, type LonLat } from "./geo";

export type HeatBBox = [number, number, number, number];

export function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

export function latToY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

/** All tiles covering a bbox at zoom z. */
export function tilesInBbox([west, south, east, north]: HeatBBox, z: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let x = lonToX(west, z); x <= lonToX(east, z); x++) {
    for (let y = latToY(north, z); y <= latToY(south, z); y++) out.push({ x, y });
  }
  return out;
}

export const rawTilePath = (layer: string, z: number, x: number, y: number) => `${HEAT_PATHS.raw}/${layer}/${z}/${x}/${y}.png`;

/** A raw tile as 0..255 intensities (red channel), or null when missing or empty. */
export function readRaw(path: string): Uint8Array | null {
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const png = PNG.sync.read(readFileSync(path));
  const n = HEAT.size * HEAT.size;
  if (png.width !== HEAT.size || png.height !== HEAT.size) throw new Error(`unexpected tile size in ${path}`);
  const out = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if ((out[i] = png.data[i * 4]!)) any = true;
  return any ? out : null;
}

/** `--zoom N` from argv, else the configured zoom. */
export function zoomArg(argv: string[]): number {
  const i = argv.indexOf("--zoom");
  if (i < 0) return HEAT.zoom;
  const z = Number(argv[i + 1]);
  if (!Number.isInteger(z) || z < HEAT.minZoom || z > 16) throw new Error("--zoom takes a whole number between 9 and 16");
  return z;
}

/**
 * Bike heat per edge: every sample reads the brightest pixel of any sport layer
 * within ± windowPx, and the edge's heat is the mean over its samples, 0..100.
 * Strava normalises each layer on its own, so the max of the three says how
 * much a road is ridden by its busiest group of cyclists.
 */
export class HeatSampler {
  private cache = new Map<string, Uint8Array | null>();
  readonly zoom: number;

  private constructor(zoom: number) {
    this.zoom = zoom;
  }

  /** A sampler over the raw tiles at the zoom that has some, or undefined when there are none. */
  static open(): HeatSampler | undefined {
    for (const z of [HEAT.zoom, 16, 14, 13, 12]) {
      if (Object.keys(HEAT.sports).some((layer) => existsSync(`${HEAT_PATHS.raw}/${layer}/${z}`))) return new HeatSampler(z);
    }
    return undefined;
  }

  /** Max of the sport layers for one tile, decoded on first use and kept in an LRU. */
  private tile(tx: number, ty: number): Uint8Array | null {
    const key = `${tx}/${ty}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    let merged: Uint8Array | null = null;
    for (const layer of Object.keys(HEAT.sports)) {
      const t = readRaw(rawTilePath(layer, this.zoom, tx, ty));
      if (!t) continue;
      if (!merged) merged = t;
      else for (let i = 0; i < t.length; i++) if (t[i]! > merged[i]!) merged[i] = t[i]!;
    }
    this.cache.set(key, merged);
    if (this.cache.size > HEAT.cacheTiles) this.cache.delete(this.cache.keys().next().value!);
    return merged;
  }

  private pixel(px: number, py: number): number {
    const s = HEAT.size;
    const t = this.tile(Math.floor(px / s), Math.floor(py / s));
    return t ? t[(((py % s) + s) % s) * s + (((px % s) + s) % s)]! : 0;
  }

  /** Brightest pixel within the window around a point, 0..255. */
  at([lon, lat]: LonLat): number {
    const n = 2 ** this.zoom * HEAT.size;
    const rad = (lat * Math.PI) / 180;
    const px = Math.floor(((lon + 180) / 360) * n);
    const py = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    const w = HEAT.windowPx;
    let best = 0;
    for (let y = py - w; y <= py + w; y++) for (let x = px - w; x <= px + w; x++) best = Math.max(best, this.pixel(x, y));
    return best;
  }

  /** Mean heat along a polyline, 0..100, leaving out the samples at its ends. */
  edge(coords: LonLat[]): number {
    const [lon0, lat0] = coords[0]!;
    const proj = new LocalProjection(lon0, lat0);
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    let samples = samplePolyline(coords.map((p) => proj.project(p)), HEAT.sampleM);
    // The end samples sit in the junction, where the heat of the road joined bleeds in.
    if (samples.length > 2) samples = samples.slice(1, -1);
    let sum = 0;
    for (const [x, y] of samples) sum += this.at([lon0 + x / kx, lat0 + y / 111320]);
    return Math.round((100 * sum) / (255 * samples.length));
  }
}
