// pnpm heat:tiles [--zoom N]: turn the raw Strava layers into gravelheater's
// two overlays under cache/heat/tiles/, each with a pyramid down to HEAT.minZoom,
// plus meta.json for the site. Strava normalises each layer on its own, so a
// road every group uses reads about equal in all of them and cancels:
//   gravel:  gravel − road           = actual gravel
//   offroad: (mtb + gravel) − road   = off-road of any kind, where gravel alone is too weak
// Both are masked where the driving layer is below minSignal (one lone ride). A
// pixel lands in gravel if that branch fires, else in offroad if that one does.
// The tiles are derived Strava data: web/vite.config.ts only copies them into
// a build with PUBLISH_HEAT=1 (see PLAN.md, heat).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { HEAT, HEAT_PATHS } from "./config";
import { rawTilePath, readRaw, tilesInBbox, zoomArg } from "./lib/heat";

const LAYERS = ["gravel", "offroad"] as const;
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
  rmSync(HEAT_PATHS.tiles, { recursive: true, force: true }); // stale tiles would leak into the pyramid
  const written: Record<Layer, { x: number; y: number }[]> = { gravel: [], offroad: [] };
  let raw = 0;
  for (const { x, y } of tiles) {
    const [gravel, road, mtb] = ["gravel", "road", "mtb"].map((l) => readRaw(rawTilePath(l, z, x, y)));
    if (gravel || road || mtb) raw++;
    if (!gravel && !mtb) continue;
    const score = { gravel: new Float32Array(SIZE * SIZE), offroad: new Float32Array(SIZE * SIZE) };
    const any = { gravel: false, offroad: false };
    for (let i = 0; i < SIZE * SIZE; i++) {
      const g = gravel ? gravel[i]! / 255 : 0;
      const r = road ? road[i]! / 255 : 0;
      const m = mtb ? mtb[i]! / 255 : 0;
      if (g >= HEAT.minSignal && g > r) {
        score.gravel[i] = (g - r) * Math.min(1, g / (r + HEAT.epsilon));
        any.gravel = true;
      } else if (g + m >= HEAT.minSignal && g + m > r) {
        score.offroad[i] = g + m - r;
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
  const meta = {
    generated: new Date().toISOString(),
    bbox: HEAT.bbox,
    minzoom: HEAT.minZoom,
    maxzoom: z,
    layers: LAYERS.filter((l) => written[l].length),
    colors: Object.fromEntries(LAYERS.map((l) => [l, `rgb(${HEAT.colors[l]!.join(", ")})`])),
  };
  writeFileSync(`${HEAT_PATHS.tiles}/meta.json`, JSON.stringify(meta, null, 2));
  console.log(`wrote ${HEAT_PATHS.tiles}/`);
}

main();
