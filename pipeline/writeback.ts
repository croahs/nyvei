// pnpm writeback [--dry-run] [--limit N]: write each ride's new km into its
// Intervals.icu activity, as one line in the description:
//   nyvei: 2.5 km ny vei · 8.2 km ny sti
// Idempotent: cache/activities/writeback.json remembers the line written per
// ride, so reruns only touch rides whose numbers changed (a later ride cannot
// change an earlier ride's new km, but a rematch after a rule change can).
// An existing nyvei line in the description is replaced, anything else kept.

import { INTERVALS_URL, PATHS, USER_AGENT } from "./config";
import { loadEnv } from "./lib/env";
import { parseArgs, readJson, writeJson } from "./lib/fs";

interface RideStats {
  id: string;
  date: string;
  name: string;
  new_countable_km: number;
  new_bonus_km: number;
}
interface Stats {
  rides: RideStats[];
}
type State = Record<string, string>;

const STATE_PATH = `${PATHS.activities}/writeback.json`;
const LINE = /^nyvei:.*$/m;
const CONCURRENCY = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

loadEnv();
const key = process.env.INTERVALS_API_KEY;
if (!key) {
  console.error("INTERVALS_API_KEY must be set, in .env (copy .env.example) or the environment.");
  process.exit(1);
}
const headers = {
  Authorization: `Basic ${Buffer.from(`API_KEY:${key}`).toString("base64")}`,
  "User-Agent": USER_AGENT,
  "Content-Type": "application/json",
};

const line = (r: RideStats) => `nyvei: ${r.new_countable_km.toFixed(1)} km ny vei · ${r.new_bonus_km.toFixed(1)} km ny sti`;

/** Fetch with Retry-After handling for 429, like rides.ts. */
async function request(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, headers });
    if (res.status !== 429 || attempt >= 6) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : 5_000 * attempt);
  }
}

function merged(description: string | null | undefined, text: string): string {
  const current = description ?? "";
  if (LINE.test(current)) return current.replace(LINE, text);
  return current.trim() ? `${current.trimEnd()}\n\n${text}` : text;
}

async function writeOne(ride: RideStats, dryRun: boolean): Promise<string> {
  const text = line(ride);
  const url = `${INTERVALS_URL}/api/v1/activity/${ride.id}`;
  const got = await request(url);
  if (!got.ok) throw new Error(`GET ${ride.id}: HTTP ${got.status}`);
  const activity = (await got.json()) as { description?: string | null };
  const description = merged(activity.description, text);
  if (description === (activity.description ?? "")) return text;
  if (dryRun) {
    console.log(`  would write ${ride.date.slice(0, 10)} ${ride.id} "${ride.name}": ${text}`);
    return text;
  }
  const put = await request(url, { method: "PUT", body: JSON.stringify({ description }) });
  if (!put.ok) throw new Error(`PUT ${ride.id}: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  console.log(`  ${ride.date.slice(0, 10)} ${ride.id} "${ride.name}": ${text}`);
  return text;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has("dry-run");
  const limitArg = process.argv.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

  const stats = readJson<Stats>(PATHS.statsOut);
  if (!stats) throw new Error(`${PATHS.statsOut} missing; run pnpm match first`);
  const state = readJson<State>(STATE_PATH) ?? {};
  const todo = [...stats.rides]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((r) => state[r.id] !== line(r))
    .slice(0, limit);
  console.log(`${stats.rides.length} rides in stats, ${todo.length} to write${dryRun ? " (dry run)" : ""}`);

  let failed = 0;
  const queue = [...todo];
  async function worker(): Promise<void> {
    for (let r = queue.shift(); r; r = queue.shift()) {
      try {
        const written = await writeOne(r, dryRun);
        if (!dryRun) state[r.id] = written;
      } catch (err) {
        failed++;
        console.warn(`  ${r.id}: ${err instanceof Error ? err.message : err}`);
      }
      if (!dryRun && Object.keys(state).length % 20 === 0) writeJson(STATE_PATH, state, true);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!dryRun) writeJson(STATE_PATH, state, true);
  console.log(`done: ${todo.length - failed} written, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
