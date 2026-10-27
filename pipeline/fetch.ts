// pnpm fetch: list rides in Intervals.icu and download the GPX of every ride
// not yet in the manifest. Idempotent; reruns only touch new ids.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { INTERVALS_URL, OLDEST, PATHS, RIDE_TYPES, USER_AGENT } from "./config";
import { gpxPath, loadManifest, saveManifest, type ManifestEntry } from "./lib/manifest";

interface Activity {
  id: string;
  name?: string;
  type?: string;
  start_date_local?: string;
  distance?: number;
  stream_types?: string[];
  trainer?: boolean;
  source?: string;
}

const PAGE = 500;
/** Intervals.icu rate-limits bursts of file downloads; two workers plus Retry-After keeps it happy. */
const CONCURRENCY = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(".env")) {
  console.error("Missing .env. Copy .env.example to .env and fill in INTERVALS_API_KEY and INTERVALS_ATHLETE_ID.");
  process.exit(1);
}
process.loadEnvFile(".env");
const key = process.env.INTERVALS_API_KEY;
const athlete = process.env.INTERVALS_ATHLETE_ID;
if (!key || !athlete) {
  console.error("INTERVALS_API_KEY and INTERVALS_ATHLETE_ID must both be set in .env.");
  process.exit(1);
}
const headers = {
  Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString("base64")}`,
  "User-Agent": USER_AGENT,
};

async function listActivities(): Promise<Activity[]> {
  const all = new Map<string, Activity>();
  let newest: string | undefined;
  for (;;) {
    const url = new URL(`${INTERVALS_URL}/api/v1/athlete/${athlete}/activities`);
    url.searchParams.set("oldest", OLDEST);
    if (newest) url.searchParams.set("newest", newest);
    url.searchParams.set("limit", String(PAGE));
    url.searchParams.set("fields", "id,name,type,start_date_local,distance,stream_types,trainer,source");
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Intervals.icu list: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const batch = (await res.json()) as Activity[];
    let added = 0;
    for (const a of batch) {
      if (!all.has(a.id)) {
        all.set(a.id, a);
        added++;
      }
    }
    const oldestInBatch = batch[batch.length - 1]?.start_date_local;
    if (batch.length < PAGE || added === 0 || !oldestInBatch) break;
    newest = oldestInBatch;
  }
  return [...all.values()];
}

function classify(a: Activity): ManifestEntry {
  const entry: ManifestEntry = {
    id: a.id,
    name: a.name ?? "",
    type: a.type ?? "",
    date: a.start_date_local ?? "",
    distance: a.distance ?? 0,
    status: "skipped",
  };
  if (!RIDE_TYPES.has(entry.type)) entry.reason = `type ${entry.type || "unknown"}`;
  else if (a.trainer) entry.reason = "trainer";
  else if (!a.stream_types?.includes("latlng")) entry.reason = "no gps";
  else if (a.source === "STRAVA") entry.reason = "strava source, no file access";
  else entry.status = "gpx";
  return entry;
}

/** Writes the GPX, or marks the entry skipped. A rate limit that outlasts the retries leaves it for the next run. */
async function downloadGpx(entry: ManifestEntry): Promise<void> {
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(`${INTERVALS_URL}/api/v1/activity/${entry.id}/gpx-file?power=false&hr=false`, { headers });
    if (res.status !== 429) break;
    if (attempt >= 6) {
      console.warn(`  ${entry.id}: still rate limited after ${attempt} attempts, left for the next run`);
      return;
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 5_000 * attempt);
  }
  if (!res.ok) {
    entry.status = "skipped";
    entry.reason = `gpx HTTP ${res.status}`;
    return;
  }
  const xml = await res.text();
  if (!xml.includes("<trkpt")) {
    entry.status = "skipped";
    entry.reason = "gpx without track points";
    return;
  }
  writeFileSync(gpxPath(entry.id), xml);
}

async function main(): Promise<void> {
  const started = Date.now();
  mkdirSync(PATHS.activities, { recursive: true });
  const manifest = loadManifest();
  const known = Object.keys(manifest.activities).length;

  const activities = await listActivities();
  console.log(`${activities.length} activities since ${OLDEST}, ${known} already in manifest`);

  for (const a of activities) {
    if (!manifest.activities[a.id]) manifest.activities[a.id] = classify(a);
  }
  // Also picks up files a previous run could not download.
  const todo = Object.values(manifest.activities).filter((e) => e.status === "gpx" && !existsSync(gpxPath(e.id)));
  const skipped = Object.values(manifest.activities).filter((e) => e.status === "skipped");
  const reasons = new Map<string, number>();
  for (const e of skipped) reasons.set(e.reason ?? "", (reasons.get(e.reason ?? "") ?? 0) + 1);
  for (const [reason, n] of reasons) console.log(`  skipped ${n}: ${reason}`);
  console.log(`${todo.length} GPX files to download`);

  let done = 0;
  const queue = [...todo];
  async function worker(): Promise<void> {
    for (let e = queue.shift(); e; e = queue.shift()) {
      await downloadGpx(e);
      done++;
      if (done % 20 === 0) {
        saveManifest(manifest);
        console.log(`  ${done}/${todo.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveManifest(manifest);

  const withGpx = Object.values(manifest.activities).filter((e) => e.status === "gpx").length;
  console.log(`done: ${withGpx} rides with GPX in ${PATHS.activities} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
