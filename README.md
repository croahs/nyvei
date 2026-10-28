# nyvei

A personal [Wandrer](https://wandrer.earth): which roads around Sandnes have
I ridden, which have I not, and loops that take me through the ones I have
not. Static site, no backend, no accounts.

## How it works

1. **rides**: rides come from Intervals.icu (personal API key, GPX per
   activity), cached locally.
2. **roads**: the road network comes from OpenStreetMap, split into edges
   at every intersection.
3. **match**: an edge counts as ridden when a track covers most of its
   length within a few metres. Roads and cycleways count toward coverage;
   tracks and paths only count as new kilometres on a ride. Rides outside
   Rogaland get their roads fetched on demand.
4. **site**: a MapLibre map shows ridden and unridden roads, coverage per
   kommune, and new kilometres per ride.
5. **route**: pick a start and a distance in the browser, get a loop that
   prefers unridden roads, download it as GPX.
6. **writeback**: each ride's new km goes back into its Intervals.icu
   activity description.

See [PLAN.md](PLAN.md) for decisions, phases and open questions.

## Running the pipeline

Needs Node 24 and pnpm. Copy `.env.example` to `.env` and fill in the
Intervals.icu API key and athlete id.

```bash
pnpm install
pnpm rides   # rides -> cache/activities
pnpm roads   # roads per kommune -> cache/roads; `pnpm roads sandnes` for one
pnpm match   # -> web/public/data/ (edge files per kommune, tracks, stats.json)
```

`pnpm match --skip-outside` matches without fetching roads for rides that
leave the loaded kommuner, for runs with a partial kommune list.

## Running the site

After `pnpm match`:

```bash
pnpm dev     # map at http://localhost:5173
```

The map loads each kommune's roads as it comes into view. Hover a road
for its name, type and first-ridden date; click a ride in the list to see
its track and the roads it rode first. `pnpm build` writes a static build
to `web/dist/`, data included, so it is for local use until phase 4 adds
the privacy zone.

## Building a route

The Route section in the panel builds loops in the browser; there is no
routing server. Set a start with **Pick start on map** (then click the
map) or **Start at map centre**, choose a distance and press
**Generate**. The loop heads out to the biggest patch of unridden roads
within half the distance and comes back another way, preferring
unridden roads and using tracks only to reach them. The panel shows the
loop's length, its unridden road and track km, and the share of the loop
on unridden roads. **Try another** picks a different patch, in another
direction where there is one; **Download GPX** saves the loop as a GPX
1.1 track. The route graph builds in the background while the map loads,
in a few seconds.

## Publishing

The site lives on Cloudflare Pages (project `nyvei`). `pnpm match` needs
`PRIVACY_ZONE` in `.env` (`lat,lon,radius_m`, the circle around home that
published data never points at), or `--no-zone` for data that stays on
this machine.

First time: `pnpm exec wrangler login`, then
`pnpm exec wrangler pages project create nyvei --production-branch main`.
After that, publishing from this machine is:

```bash
pnpm rides
pnpm ship
pnpm writeback
```

`pnpm ship` runs match, build and pages in one go, and works in any shell
(Windows PowerShell 5.1 has no `&&`). It stops at match when
`PRIVACY_ZONE` is missing. Writeback comes last because it reads the
numbers match just wrote.

`pnpm writeback` puts each ride's new km into its Intervals.icu activity
description as a `nyvei:` line (`--dry-run` shows what it would change,
`--limit N` stops after N rides). With `SITE_URL` set in `.env` (and as a
repository variable for the workflow) the line ends with a link that
opens the site on that ride, `?ride=<activity id>`.

The `Publish` workflow (`.github/workflows/publish.yml`) does the same
nightly, on every push to `main`, and on demand from the Actions tab. It
needs five repository secrets: `INTERVALS_API_KEY`, `INTERVALS_ATHLETE_ID`,
`PRIVACY_ZONE`, `CLOUDFLARE_API_TOKEN` (a token with Cloudflare Pages
edit) and `CLOUDFLARE_ACCOUNT_ID`. Ride GPX files and road data are kept
in the Actions cache between runs; roads are refreshed from Overpass on
the first of the month. Actions on a private repo use paid minutes, so
the workflow runs only once billing on the GitHub account is in order.

## Status

Phases 1 (pipeline), 2 (map) and 3 (route builder) done; phase 4
(publishing) is set up. Loading a GPX on the Garmin is still to be
checked.
