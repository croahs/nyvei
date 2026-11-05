# Plan

Goal: every ride is matched against the road network, a map shows ridden
and unridden roads, coverage is counted per kommune, and a route builder
makes loops through unridden roads that other cyclists actually ride, and
exports GPX. The map also carries gravelheater's Strava heat overlays; that
project is merged in here.

## Decisions

- **Static site, no backend, no accounts.** The pipeline is pnpm scripts
  run locally; the output is files the site reads.
- **Rides from Intervals.icu.** Personal API key, no OAuth. History goes
  back to the first ride, June 2024, so no backfill is needed.
- **Roads from OpenStreetMap, two tiers.** *Countable* edges are roads
  and cycleways. *Bonus* edges are tracks, paths and other ways a bike
  can use but a map cannot promise are rideable. Trunk roads count as
  roads. Ways with `bicycle=no` or `motorroad=yes` (motortrafikkvei) are
  dropped on every tier, like motorways and steps. Coverage percent
  counts countable edges only; new km per ride counts both tiers. Without
  this split 100 % of a kommune is unreachable.
- **Region: Rogaland, fetched per kommune.** One Overpass query per
  kommune polygon, cached per kommune, so per-kommune percent falls out
  and Rogaland is the sum. Adding a region later is adding kommuner to a
  list.
- **Rides outside the region count too.** When a ride leaves the loaded
  kommuner, the match step fetches roads for that ride's bounding box on
  demand and caches them. Those edges show on the map and in new km but
  belong to no kommune and count toward no percent. The first ride in a
  new place is 100 % new; the second one there is matched against the
  first. A ride box wider than 150 km is a GPS glitch or a car transfer,
  not a ride, and is skipped with a warning.
- **Stack:** Node + TypeScript (`tsx`) for the pipeline, Vite + MapLibre
  GL JS for the site, `flatbush` for the spatial index. Routing runs in
  the browser over the same edge graph; no routing server.
- **Privacy:** ridden roads reveal where I live, so published data never
  points at home. `PRIVACY_ZONE` (lat,lon,radius_m) lives
  in `.env` locally and as a repository secret in CI. `pnpm match` refuses
  to write without it; `--no-zone` is the explicit local-only escape
  hatch. Edges with a point inside the circle are left out of the edge
  files (they still count in the stats), and tracks are cut where they
  enter it, so a track file is a list of segments. The radius is 100 m
  by choice, knowing that ride ends still ring the block around it.
- **Strava heatmap, merged in from gravelheater.** The global heatmap
  (sport layers Ride, GravelRide, MountainBikeRide) does two jobs. As
  gravelheater's overlays, *gravel* (gravel − road) and *offroad* (mtb +
  gravel − road), raster tiles on the map. And as *bike heat* per edge,
  `t` 0..100, which the route builder uses to keep loops on roads people
  ride, so a loop does not pick a road just because it is unridden. Tiles
  are fetched with the cookies of a logged-in strava.com session, for
  personal use only. They are derived Strava data: the overlay tiles go
  into a build only with `PUBLISH_HEAT=1`, which is for once the site is
  behind Cloudflare Access, as gravelheater was. The per-edge `t` numbers
  are published with the edge files. Heat covers gravelheater's "sandnes"
  box (Egersund to Nord-Jæren and Suleskard); edges outside it have no
  heat and route as before.
- **Published on Cloudflare Pages**, repo stays private. GitHub Pages
  and Actions minutes are not available on this account's plan for a
  private repo. `pnpm pages` deploys `web/dist` with wrangler, from this
  machine or from the Publish workflow (nightly, on push, on demand) once
  Actions minutes work. Cloudflare's 25 MB limit per file is why outside
  edges are one file per ride box.

## Architecture

```
pipeline/            pnpm scripts, run locally
  rides.ts           Intervals.icu -> cache/activities/<id>.gpx (incremental by id)
  roads.ts           Overpass per kommune -> cache/roads/<kommune>.json
  match.ts           tracks x edges -> web/public/data/kommuner/<slug>.json,
                     outside/<box>.json, tracks/<id>.json, stats.json
                     (fetches cache/roads/ride-<id>.json for rides outside the region)
  writeback.ts       stats.json -> one "nyvei:" line per activity description on Intervals.icu
  heat.ts            Strava heatmap -> cache/heat/raw/<layer>/<z>/<x>/<y>.png (resumable)
  heattiles.ts       raw layers -> cache/heat/tiles/{gravel,offroad}/ + meta.json
                     (match.ts reads cache/heat/raw for each edge's bike heat)
web/                 Vite + MapLibre site, reads public/data/*
cache/               gitignored
```

**rides.** Activity types Ride, GravelRide, MountainBikeRide, EBikeRide.
Skip VirtualRide and anything without GPS. Keep a manifest of fetched ids
so reruns only download new rides.

**roads.** Kommune list in config (Rogaland's 23 to start). Per kommune:
Overpass query for `highway=*` inside the admin boundary, minus
motorway, motorway_link, steps, `access=no`/`private`, `bicycle=no` and
`motorroad=yes`. Tier by `highway` value, as a config map:

| tier      | highway values                                                                         |
| --------- | -------------------------------------------------------------------------------------- |
| countable | trunk, primary, secondary, tertiary, unclassified, residential, living_street, cycleway, and their `_link` variants |
| bonus     | track, path, bridleway, footway, pedestrian, service                                   |

Adjust the map when the data is on a screen; `service` may move up.
Split ways at shared nodes into edges with id, geometry, length, tier,
kommune and tags.

**match.** Spatial index on edges. For each track point, find edges
within 15 m. An edge is ridden when matched points cover at least 80 % of
its length, sampled every 10 m. Either direction counts. Per edge store
`ridden`, `first_date`, `first_activity`. That blanket rule clears a
road and the cycleway beside it together, so new km per ride counts
only edges the ride was *primary* for: each track point credits its
nearest edge within 15 m, and an edge is primary when those credits
cover 80 % of its samples. Before matching a ride, check
its bounding box against the loaded kommune polygons; the part outside
gets an on-demand Overpass fetch for that box plus 1 km, cached under the
ride id. Stats: per kommune and total, countable km ridden over
countable km, and per ride the new km split by tier (primary edges whose
`first_activity` is that ride).

**site.** Edges go out as one GeoJSON file per kommune plus one per ride
box outside the region (`outside/<box>.json`),
5-decimal coordinates, one-letter property names (the map is in the
header of `match.ts` and in `web/src/data.ts`); about 80 MB for Rogaland
and 40 MB outside. The site loads a file when its bounding box enters the viewport and MapLibre parses it in
its worker, so the main thread only reads `stats.json`. Basemap is
OpenFreeMap Positron, no key. Selecting a ride loads its thinned track
from `tracks/<id>.json` and highlights its first-ridden edges, solid
where they count as its new km.

**writeback.** Each ride's new km goes back to Intervals.icu as one line
in the activity description, `nyvei: 2.5 km ny vei · 8.2 km ny sti`,
replaced in place when the numbers change, with a `?ride=<id>` link to
the site once `SITE_URL` is set. A state file under `cache/`
keeps reruns from touching rides already written. A custom activity
field would be chartable, but none exists yet; the line works without
setup.

**heat.** `pnpm heat` downloads 512 px greyscale tiles at zoom 15
(about 2.4 m/px) for the three sport layers, the layout gravelheater's
`tiles/` already has, so those can be copied in. `pnpm heat:tiles` is
gravelheater's compute step: per pixel, gravel = (g − r) × min(1, g /
(r + 0.05)) where g ≥ 0.08 and g > r, else offroad = g + m − r where
g + m ≥ 0.08 and > r; a pyramid of max-pooled parents down to zoom 9.
Overlays draw gold (gravel) and cyan (offroad), off the colours nyvei
already uses. `pnpm match` gives each edge its bike heat: every 10 m
sample reads the brightest pixel of any layer within ±2 px, the end
samples are dropped because the junction carries the joining road's heat,
and `t` is the mean in percent. Strava normalises each layer on its own,
so the max says how much the busiest group of cyclists uses the road. The
site serves overlay tiles from `cache/heat/tiles` through a Vite plugin in
dev; base maps (Positron, Kartverket topo and gråtone, OSM, OpenTopoMap)
are a raster layer under everything, chosen in the panel.

**route.** Edge cost = length × (ridden ? 4 : 1), bonus edges × 2 on top
so loops prefer roads but may use a track to reach one, × (1 − k × heat)
with heat = `t` / 100 and k the "prefer bike heat" slider (0 to 0.9,
default 0.6), so with k = 0.6 the busiest road costs 0.4 of a dead one. "Roads only"
sets bonus edges to infinite cost and snaps the start to a component of
countable edges, because many bonus ways are hard going on a bike. The graph (nodes
are the `a`/`b` OSM node ids, edges undirected) is built in a Web Worker
that fetches the edge files itself; that is faster than handing it
MapLibre's parsed copy, because structured cloning 400k features blocks
the page for seconds. Given start and target distance D: Dijkstra from
the start, cut at D/2 of path length; clusters are connected components
of unridden countable edges, ranked by their countable km inside that
reach (weighted by (1 − k + k × heat), so a busy cluster outranks a
dead one), counting only clusters that reach at least 0.35 D out (a cluster
next to the start cannot turn a loop of length D). In the chosen cluster
the turnaround is the node at outbound length r that is cheapest per
metre; Dijkstra back with the outbound edges × 4 again, then r is
rescaled until out + back is within 5 % of D (at most 8 tries). "Try
another" walks the clusters in rank order, discounting any within 45° of
an earlier one's bearing so the next loop heads somewhere else. The panel
shows the share of the loop on edges with heat ≥ 25. Export
GPX 1.1. Own Dijkstra first; BRouter with nogo areas is the fallback if
loops come out ugly.

## Phases

Each phase ends on a checkable criterion.

- **Phase 0, repo and plan.** This document. Done.
- **Phase 1, pipeline.** `pnpm rides && pnpm roads && pnpm match`
  produces the edge files and `stats.json` for Sandnes kommune, then all
  of Rogaland. Done when the ridden set for one known ride matches the
  roads actually ridden on that ride, checked by eye in a GeoJSON
  viewer, and one ride outside Rogaland gets its roads fetched and
  matched. Done.
- **Phase 2, map.** `pnpm dev` shows ridden and unridden roads with the
  two tiers told apart, percent per kommune and for Rogaland, and a
  per-ride list with new km. Done when the last ten rides show plausible
  new-km numbers. Done: all of Rogaland plus outside loads in about 8 s,
  and three of the last ten rides were checked against their tracks.
- **Phase 3, route builder.** Click start, choose distance, get a loop.
  Done when a generated 40 km loop has at least half its length on
  unridden countable roads, downloads as GPX, and loads on the Garmin.
  Built: from Sandnes centre the first 40 km loop is 40.8 km with 91 %
  on unridden countable roads, routed in 40-70 ms after a 2-4 s graph
  build, and its GPX opens in a GPX viewer. Loading on the Garmin is
  still open.
- **Phase 4, publish.** Privacy zone, Cloudflare Pages, nightly GitHub
  Action. Done when `pnpm pages` puts the map on the pages.dev URL with
  no published edge or track point inside the zone (checked with a
  script against a test point). Live at https://nyvei.pages.dev, checked
  with a script against the real zone (0 published points inside); the
  Action is blocked on GitHub Actions billing.

- **Phase 5, gravelheater merged in.** Heat overlays, base maps and bike
  heat routing in this site. Done when, from Sandnes with real tiles, a
  40 km loop with "prefer bike heat" on has most of its length on edges
  with heat ≥ 25 and still half on unridden countable roads, checked
  against the overlay on the map. Built and checked on a synthetic grid
  with fake tiles (a 20 km loop went from 19 % to 96 % on busy edges
  between k = 0 and 0.9); the real-data check is open.

## Open questions

- Exact tier map: unknown until the data is on a map. `service` roads
  (driveways, parking aisles) are the likely argument.
- Loop shape: in a dense street grid the way back runs a block or two
  from the way out, so loops come out as narrow corridors (Sandnes to
  Stavanger and back) rather than round. A cost on edges near the
  outbound path would widen them; BRouter is the bigger step.
- Data size: the edge files are about 120 MB in all and the first full
  view takes about 8 s. Vector tiles (PMTiles) would cut that on the
  published site.
- Heat publishing: the overlay tiles stay out of the published build
  until nyvei.pages.dev is behind Cloudflare Access, which also puts the
  whole site behind a login. The Publish workflow has no heat tiles (4 GB,
  cookies that last a day), so a CI run would publish edges without `t`;
  heat runs stay on this machine for now.
- Heat calibration: whether `t` ≥ 25 is the right line for "roads
  cyclists use", and whether k = 0.6 is the right default, needs the real
  tiles on a screen.
- Left behind in gravelheater: point-to-point routing through clicked
  waypoints, surface share along a route, elevation profile, GPX import,
  saved routes, place search and the second area (Stellenbosch). Port
  them here if they are missed.
