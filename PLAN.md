# Plan

Goal: every ride is matched against the road network, a map shows ridden
and unridden roads, coverage is counted per kommune, and a route builder
makes loops through unridden roads and exports GPX.

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
  points at home. `PRIVACY_ZONE` (lat,lon,radius_m; 100 m to start) lives
  in `.env` locally and as a repository secret in CI. `pnpm match` refuses
  to write without it; `--no-zone` is the explicit local-only escape
  hatch. Edges with a point inside the circle are left out of the edge
  files (they still count in the stats), and tracks are cut where they
  enter it, so a track file is a list of segments.
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
replaced in place when the numbers change. A state file under `cache/`
keeps reruns from touching rides already written. A custom activity
field would be chartable, but none exists yet; the line works without
setup.

**route.** Edge cost = length × (ridden ? 4 : 1), bonus edges × 2 on top
so loops prefer roads but may use a track to reach one. The graph (nodes
are the `a`/`b` OSM node ids, edges undirected) is built in a Web Worker
that fetches the edge files itself; that is faster than handing it
MapLibre's parsed copy, because structured cloning 400k features blocks
the page for seconds. Given start and target distance D: Dijkstra from
the start, cut at D/2 of path length; clusters are connected components
of unridden countable edges, ranked by their countable km inside that
reach, counting only clusters that reach at least 0.35 D out (a cluster
next to the start cannot turn a loop of length D). In the chosen cluster
the turnaround is the node at outbound length r that is cheapest per
metre; Dijkstra back with the outbound edges × 4 again, then r is
rescaled until out + back is within 5 % of D (at most 8 tries). "Try
another" walks the clusters in rank order, discounting any within 45° of
an earlier one's bearing so the next loop heads somewhere else. Export
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
  script against a test point). Built; the first deploy and the Action
  (blocked on Actions billing) are open.

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
- Zone radius: 100 m hides the house but every ride still starts and ends
  at the circle's edge, which points at the block. Strava uses 200 m to
  1 km. One number in the secret to change.
