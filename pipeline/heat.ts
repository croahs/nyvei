// pnpm heat [--zoom N]: download the Strava global heatmap tiles for HEAT.bbox
// into cache/heat/raw/<layer>/<z>/<x>/<y>.png, one tree per sport layer.
// Needs the CloudFront cookies of a logged-in strava.com session in .env (see
// .env.example); they expire after about a day, refresh them on 401/403.
// Resumable: tiles already on disk are skipped. Personal use only; keeps a low
// request rate. gravelheater's tiles/ folder has the same layout, so copying
// its gravel/, road/ and mtb/ here skips the download.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HEAT } from "./config";
import { loadEnv } from "./lib/env";
import { rawTilePath, tilesInBbox, zoomArg } from "./lib/heat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cookie(): string {
  loadEnv();
  const keys = ["CLOUDFRONT_KEY_PAIR_ID", "CLOUDFRONT_POLICY", "CLOUDFRONT_SIGNATURE", "STRAVA_IDCF"];
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`.env is missing ${missing.join(", ")} (cookies from a logged-in strava.com session)`);
  const e = process.env;
  return [
    `CloudFront-Key-Pair-Id=${e.CLOUDFRONT_KEY_PAIR_ID}`,
    `CloudFront-Policy=${e.CLOUDFRONT_POLICY}`,
    `CloudFront-Signature=${e.CLOUDFRONT_SIGNATURE}`,
    `_strava_idcf=${e.STRAVA_IDCF}`, // without this the CDN answers 401
  ].join("; ");
}

async function main(): Promise<void> {
  const headers = { cookie: cookie(), referer: "https://www.strava.com/maps/global-heatmap" };
  const z = zoomArg(process.argv.slice(2));
  const tiles = tilesInBbox(HEAT.bbox, z);
  const jobs = Object.entries(HEAT.sports).flatMap(([layer, sport]) => tiles.map((t) => ({ layer, sport, ...t })));
  console.log(`${tiles.length} tiles × ${Object.keys(HEAT.sports).length} layers at z${z}`);

  let done = 0;
  let skipped = 0;
  let empty = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { layer, sport, x, y } = jobs[next++]!;
      const path = rawTilePath(layer, z, x, y);
      if (existsSync(path)) {
        skipped++;
        continue;
      }
      const res = await fetch(HEAT.tileUrl(sport, z, x, y), { headers });
      if (res.status === 401 || res.status === 403) throw new Error(`${res.status}: cookies expired or wrong, refresh them in .env`);
      mkdirSync(dirname(path), { recursive: true });
      if (res.status === 404) {
        empty++;
        writeFileSync(path, "");
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} on ${sport} ${z}/${x}/${y}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      if (++done % 200 === 0) console.log(`${done + skipped + empty}/${jobs.length}`);
      const [lo, hi] = HEAT.requestDelayMs;
      await sleep(lo + Math.random() * (hi - lo));
    }
  };
  await Promise.all(Array.from({ length: HEAT.concurrency }, worker));
  console.log(`fetched ${done}, empty ${empty}, already had ${skipped}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
