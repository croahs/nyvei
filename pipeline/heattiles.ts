// pnpm heat:tiles [--zoom N]: turn the raw Strava layers into three overlays
// under cache/heat/tiles/, each with a pyramid down to HEAT.minZoom, plus
// meta.json for the site. Road is the Ride layer as it is. The other two are
// gravelheater's: Strava normalises each layer on its own, so a road every
// group uses reads about equal in all of them and cancels:
//   gravel:  gravel − road           = actual gravel
//   offroad: (mtb + gravel) − road   = off-road of any kind, where gravel alone is too weak
// All are masked where the driving layer is below minSignal (one lone ride);
// the formulas are gravelScore and offroadScore in lib/heat.ts. A pixel lands
// in gravel if that branch fires, else in offroad if that one does. Road stops
// at HEAT.roadMaxZoom (meta.json layerMaxzoom) to keep a deploy's file count down.
// cache/heat/tiles is the whole heat project (PLAN.md, heat): pnpm heat:pages
// deploys it on its own, apart from the site.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { HEAT, HEAT_PATHS } from "./config";
import { gravelScore, offroadScore, rawTilePath, readRaw, tilesInBbox, zoomArg } from "./lib/heat";

// Road first, so it draws under the other two on the map.
const LAYERS = ["road", "gravel", "offroad"] as const;
type Layer = (typeof LAYERS)[number];
const SIZE = HEAT.size;

// Score (0..1) to stored alpha (0..255) and back, so the pyramid reads raw scores.
const toAlpha = (s: number) => (s <= 0 ? 0 : Math.round(255 * (HEAT.alphaFloor + (1 - HEAT.alphaFloor) * s ** HEAT.alphaGamma)));
const fromAlpha = (a: number) => (a === 0 ? 0 : Math.max(0, (a / 255 - HEAT.alphaFloor) / (1 - HEAT.alphaFloor)) ** (1 / HEAT.alphaGamma));

const outPath = (layer: Layer, z: number, x: number, y: number) => `${HEAT_PATHS.tiles}/${layer}/${z}/${x}/${y}.png`;

/** One colour per layer; alpha carries the lifted score so the base map stays readable. */
function writeTile(path: string, score: Float32Array, [r, g, b]: [number, number, number]): void {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let i = 0; i < score.length; i++) {
    if (score[i]! <= 0) continue;
    png.data[i * 4] = r;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = b;
    png.data[i * 4 + 3] = toAlpha(Math.min(1, score[i]!));
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

function readScore(path: string): Float32Array | null {
  if (!existsSync(path)) return null;
  const png = PNG.sync.read(readFileSync(path));
  const score = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < score.length; i++) score[i] = fromAlpha(png.data[i * 4 + 3]!);
  return score;
}

/** Parent tiles: each 2×2 block of a child becomes one parent pixel with the max score, so thin lines survive zooming out. */
function buildPyramid(layer: Layer, z: number, tiles: { x: number; y: number }[]): void {
  let level = new Set(tiles.map(({ x, y }) => `${x}/${y}`));
  for (let pz = z - 1; pz >= HEAT.minZoom; pz--) {
    const parents = new Set([...level].map((k) => k.split("/").map(Number)).map(([x, y]) => `${x! >> 1}/${y! >> 1}`));
    for (const key of parents) {
      const [px, py] = key.split("/").map(Number) as [number, number];
      const score = new Float32Array(SIZE * SIZE);
      let any = false;
      for (const dx of [0, 1]) {
        for (const dy of [0, 1]) {
          const child = readScore(outPath(layer, pz + 1, px * 2 + dx, py * 2 + dy));
          if (!child) continue;
          any = true;
          const ox = dx * (SIZE / 2);
          const oy = dy * (SIZE / 2);
          for (let y = 0; y < SIZE; y += 2) {
            for (let x = 0; x < SIZE; x += 2) {
              const i = (oy + y / 2) * SIZE + ox + x / 2;
              for (const j of [y * SIZE + x, y * SIZE + x + 1, (y + 1) * SIZE + x, (y + 1) * SIZE + x + 1]) {
                if (child[j]! > score[i]!) score[i] = child[j]!;
              }
            }
          }
        }
      }
      if (any) writeTile(outPath(layer, pz, px, py), score, HEAT.colors[layer]!);
    }
    console.log(`${layer} z${pz}: ${parents.size} overview tiles`);
    level = parents;
  }
}

function main(): void {
  const z = zoomArg(process.argv.slice(2));
  const tiles = tilesInBbox(HEAT.bbox, z);
  // Stale tiles would leak into the pyramid; edges.json (pnpm match) stays.
  for (const layer of LAYERS) rmSync(`${HEAT_PATHS.tiles}/${layer}`, { recursive: true, force: true });
  const written: Record<Layer, { x: number; y: number }[]> = { road: [], gravel: [], offroad: [] };
  let raw = 0;
  for (const { x, y } of tiles) {
    const [gravel, road, mtb] = ["gravel", "road", "mtb"].map((l) => readRaw(rawTilePath(l, z, x, y)));
    if (gravel || road || mtb) raw++;
    if (!gravel && !road && !mtb) continue;
    const score = { road: new Float32Array(SIZE * SIZE), gravel: new Float32Array(SIZE * SIZE), offroad: new Float32Array(SIZE * SIZE) };
    const any = { road: false, gravel: false, offroad: false };
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = gravel ? gravel[i]! / 255 : 0;
      const r = road ? road[i]! / 255 : 0;
      const m = mtb ? mtb[i]! / 255 : 0;
      if (r >= HEAT.minSignal) {
        score.road[i] = r;
        any.road = true;
      }
      const gs = gravelScore(g, r);
      const os = gs ? 0 : offroadScore(g, m, r);
      if (gs) {
        score.gravel[i] = gs;
        any.gravel = true;
      } else if (os) {
        score.offroad[i] = os;
        any.offroad = true;
      }
    }
    for (const layer of LAYERS) {
      if (!any[layer]) continue;
      writeTile(outPath(layer, z, x, y), score[layer], HEAT.colors[layer]!);
      written[layer].push({ x, y });
    }
  }
  if (!raw) throw new Error(`No raw tiles at z${z} under cache/heat/raw. Run pnpm heat first.`);
  for (const layer of LAYERS) {
    console.log(`${layer}: ${written[layer].length} tiles at z${z}`);
    buildPyramid(layer, z, written[layer]);
  }
  // Road covers nearly every road, so its deepest levels are dropped; the map stretches the last one.
  const layerMaxzoom: Record<string, number> = {};
  if (z > HEAT.roadMaxZoom) {
    for (let dz = z; dz > HEAT.roadMaxZoom; dz--) rmSync(`${HEAT_PATHS.tiles}/road/${dz}`, { recursive: true, force: true });
    layerMaxzoom.road = HEAT.roadMaxZoom;
  }
  const meta = {
    generated: new Date().toISOString(),
    bbox: HEAT.bbox,
    minzoom: HEAT.minZoom,
    maxzoom: z,
    layerMaxzoom,
    layers: LAYERS.filter((l) => written[l].length),
    colors: Object.fromEntries(LAYERS.map((l) => [l, `rgb(${HEAT.colors[l]!.join(", ")})`])),
  };
  writeFileSync(`${HEAT_PATHS.tiles}/meta.json`, JSON.stringify(meta, null, 2));
  // The site fetches the heat project from another origin, and WebGL needs CORS for tiles.
  writeFileSync(`${HEAT_PATHS.tiles}/_headers`, "/*\n  Access-Control-Allow-Origin: *\n");
  console.log(`wrote ${HEAT_PATHS.tiles}/`);
}

main();
