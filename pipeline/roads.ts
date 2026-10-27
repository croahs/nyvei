// pnpm roads [slug ...] [--refresh]: fetch the road network per kommune from
// Overpass into cache/roads/<slug>.json and report what the split would give.

import { existsSync } from "node:fs";
import { KOMMUNER } from "./config";
import { kmByTier, splitWays } from "./lib/edges";
import { mb, parseArgs, writeJson } from "./lib/fs";
import { kommuneQuery, overpass } from "./lib/overpass";
import { kommuneCachePath, loadKommuneRoads } from "./lib/roadcache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const { slugs, flags } = parseArgs(process.argv.slice(2));
  const unknown = slugs.filter((s) => !KOMMUNER.some((k) => k.slug === s));
  if (unknown.length) throw new Error(`unknown kommune slug(s): ${unknown.join(", ")}`);
  const targets = slugs.length ? KOMMUNER.filter((k) => slugs.includes(k.slug)) : KOMMUNER;
  const started = Date.now();
  const dropped = new Map<string, number>();
  let totalBytes = 0;
  const total = { countable: 0, bonus: 0 };

  for (const k of targets) {
    const path = kommuneCachePath(k.slug);
    let how = "cached";
    if (flags.has("refresh") || !existsSync(path)) {
      const { data, bytes, ms } = await overpass(kommuneQuery(k.ref), k.name);
      writeJson(path, data);
      how = `fetched ${mb(bytes)} in ${(ms / 1000).toFixed(0)} s`;
      await sleep(2000);
    }
    const roads = loadKommuneRoads(k.slug)!;
    totalBytes += roads.bytes;
    const polygons = new Map([[k.slug, roads.polygon]]);
    const split = splitWays(roads.ways.map((way) => ({ way, kommuner: [k.slug] })), polygons);
    const km = kmByTier(split.edges);
    total.countable += km.countable;
    total.bonus += km.bonus;
    for (const [h, n] of split.dropped) dropped.set(h, (dropped.get(h) ?? 0) + n);
    console.log(
      `${k.name.padEnd(11)} ${how.padEnd(26)} ${roads.ways.length} ways, ${split.edges.length} edges, ` +
        `${km.countable.toFixed(0)} km countable, ${km.bonus.toFixed(0)} km bonus, ${roads.polygon.rings.length} ring(s)`,
    );
  }

  console.log(`\n${targets.length} kommune(r): ${mb(totalBytes)} cached, ${total.countable.toFixed(0)} km countable, ${total.bonus.toFixed(0)} km bonus`);
  if (dropped.size) {
    const list = [...dropped].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h || "(empty)"}=${n}`);
    console.log(`highway values without a tier (ways dropped): ${list.join(", ")}`);
  }
  console.log(`${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
