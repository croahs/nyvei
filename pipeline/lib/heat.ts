// Strava heatmap tiles: slippy-map math, raw tile decoding, gravelheater's
// per-pixel scores and per-edge heat.
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

/** Gravel score of one pixel (layers 0..1): gravel − road, scaled down where road nearly matches it. */
export function gravelScore(g: number, r: number): number {
  return g >= HEAT.minSignal && g > r ? (g - r) * Math.min(1, g / (r + HEAT.epsilon)) : 0;
}

/** Off-road score of one pixel (layers 0..1): (gravel + mtb) − road, up to 2. */
export function offroadScore(g: number, m: number, r: number): number {
  return g + m >= HEAT.minSignal && g + m > r ? g + m - r : 0;
}

/** Heat of one edge, each 0..1. */
export interface EdgeHeat {
  /** Brightest of the three sport layers. */
  any: number;
  /** The Ride layer. */
  road: number;
  /** gravelScore. */
  gravel: number;
  /** offroadScore capped at 1. Unlike the overlay it also counts where gravel fires. */
  offroad: number;
}

const LAYERS = ["gravel", "road", "mtb"] as const;
type Tile = Record<(typeof LAYERS)[number], Uint8Array | null>;

/**
 * Heat per edge: every sample reads the brightest pixel of each sport layer
 * within ± windowPx, the scores come from those three values, and each heat
 * is the mean over the edge's samples. Strava normalises each layer on its
 * own, so `any` (the max of the three) says how much a road is ridden by its
 * busiest group of cyclists.
 */
export class HeatSampler {
  private cache = new Map<string, Tile | null>();
  readonly zoom: number;

  private constructor(zoom: number) {
    this.zoom = zoom;
  }

  /** A sampler over the raw tiles at the zoom that has some, or undefined when there are none. */
  static open(): HeatSampler | undefined {
    for (const z of [HEAT.zoom, 16, 14, 13, 12]) {
      if (LAYERS.some((layer) => existsSync(`${HEAT_PATHS.raw}/${layer}/${z}`))) return new HeatSampler(z);
    }
    return undefined;
  }

  /** The sport layers of one tile, decoded on first use and kept in an LRU. */
  private tile(tx: number, ty: number): Tile | null {
    const key = `${tx}/${ty}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const t = Object.fromEntries(LAYERS.map((l) => [l, readRaw(rawTilePath(l, this.zoom, tx, ty))])) as Tile;
    const tile = LAYERS.some((l) => t[l]) ? t : null;
    this.cache.set(key, tile);
    if (this.cache.size > HEAT.cacheTiles) this.cache.delete(this.cache.keys().next().value!);
    return tile;
  }

  /** Brightest pixel of each layer (gravel, road, mtb) within the window around a point, 0..1. */
  private at([lon, lat]: LonLat): [number, number, number] {
    const s = HEAT.size;
    const n = 2 ** this.zoom * s;
    const rad = (lat * Math.PI) / 180;
    const px = Math.floor(((lon + 180) / 360) * n);
    const py = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
    const w = HEAT.windowPx;
    let g = 0;
    let r = 0;
    let m = 0;
    for (let y = py - w; y <= py + w; y++) {
      for (let x = px - w; x <= px + w; x++) {
        const t = this.tile(Math.floor(x / s), Math.floor(y / s));
        if (!t) continue;
        const i = (((y % s) + s) % s) * s + (((x % s) + s) % s);
        g = Math.max(g, t.gravel?.[i] ?? 0);
        r = Math.max(r, t.road?.[i] ?? 0);
        m = Math.max(m, t.mtb?.[i] ?? 0);
      }
    }
    return [g / 255, r / 255, m / 255];
  }

  /** Mean heat along a polyline, leaving out the samples at its ends. */
  edge(coords: LonLat[]): EdgeHeat {
    const [lon0, lat0] = coords[0]!;
    const proj = new LocalProjection(lon0, lat0);
    const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
    let samples = samplePolyline(coords.map((p) => proj.project(p)), HEAT.sampleM);
    // The end samples sit in the junction, where the heat of the road joined bleeds in.
    if (samples.length > 2) samples = samples.slice(1, -1);
    const sum = { any: 0, road: 0, gravel: 0, offroad: 0 };
    for (const [x, y] of samples) {
      const [g, r, m] = this.at([lon0 + x / kx, lat0 + y / 111320]);
      sum.any += Math.max(g, r, m);
      sum.road += r;
      sum.gravel += gravelScore(g, r);
      sum.offroad += Math.min(1, offroadScore(g, m, r));
    }
    const n = samples.length;
    return { any: sum.any / n, road: sum.road / n, gravel: sum.gravel / n, offroad: sum.offroad / n };
  }
}

export type HeatMode = Exclude<keyof EdgeHeat, "any">;

/**
 * Per mode, the 95th percentile of that heat over the edges that have any:
 * the edge files divide by it, so the three heats share a scale. Gravel − road
 * is a difference and mostly small, so unscaled a gravel preference barely
 * moves a loop.
 */
export function heatScale(heats: (EdgeHeat | undefined)[]): Record<HeatMode, number> {
  const p95 = (m: HeatMode) => {
    const v = heats.flatMap((h) => (h && h[m] > 0 ? [h[m]] : [])).sort((a, b) => a - b);
    return v.length ? v[Math.floor(0.95 * (v.length - 1))]! : 1;
  };
  return { road: p95("road"), gravel: p95("gravel"), offroad: p95("offroad") };
}
