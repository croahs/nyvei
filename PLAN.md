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
  can use but a map cannot promise are rideable. Coverage percent counts
  countable edges only; new km per ride counts both tiers. Without this
  split 100 % of a kommune is unreachable.
- **Region: Rogaland, fetched per kommune.** One Overpass query per
  kommune polygon, cached per kommune, so per-kommune percent falls out
  and Rogaland is the sum. Adding a region later is adding kommuner to a
  list.
- **Rides outside the region count too.** When a ride leaves the loaded
  kommuner, the match step fetches roads for that ride's bounding box on
  demand and caches them. Those edges show on the map and in new km but
  belong to no kommune and count toward no percent. The first ride in a
  new place is 100 % new; the second one there is matched against the
  first.
- **Stack:** Node + TypeScript (`tsx`) for the pipeline, Vite + MapLibre
  GL JS for the site, `flatbush` for the spatial index. Routing runs in
  the browser over the same edge graph; no routing server.
- **Privacy:** ridden roads reveal where I live. The site is local-first
  (`pnpm dev`). Publishing anywhere requires a privacy zone that drops
  edges near home from the published data.

## Architecture

```
pipeline/            pnpm scripts, run locally
  fetch.ts           Intervals.icu -> cache/activities/<id>.gpx (incremental by id)
  roads.ts           Overpass per kommune -> cache/roads/<kommune>.json
  match.ts           tracks x edges -> web/public/data/edges.json + stats.json
                     (fetches cache/roads/ride-<id>.json for rides outside the region)
web/                 Vite + MapLibre site, reads public/data/*
cache/               gitignored
```

**fetch.** Activity types Ride, GravelRide, MountainBikeRide, EBikeRide.
Skip VirtualRide and anything without GPS. Keep a manifest of fetched ids
so reruns only download new rides.

**roads.** Kommune list in config (Rogaland's 23 to start). Per kommune:
Overpass query for `highway=*` inside the admin boundary, minus
motorway, motorway_link, steps, and `access=no`/`private`. Tier by
`highway` value, as a config map:

| tier      | highway values                                                                         |
| --------- | -------------------------------------------------------------------------------------- |
| countable | primary, secondary, tertiary, unclassified, residential, living_street, cycleway, and their `_link` variants |
| bonus     | track, path, bridleway, footway, pedestrian, service                                   |

Adjust the map when the data is on a screen; `service` may move up.
Split ways at shared nodes into edges with id, geometry, length, tier,
kommune and tags.

**match.** Spatial index on edges. For each track point, find edges
within 15 m. An edge is ridden when matched points cover at least 80 % of
its length, sampled every 10 m. Either direction counts. Per edge store
`ridden`, `first_date`, `first_activity`. Before matching a ride, check
its bounding box against the loaded kommune polygons; the part outside
gets an on-demand Overpass fetch for that box plus 1 km, cached under the
ride id. Stats: per kommune and total, countable km ridden over
countable km, and per ride the new km split by tier (edges whose
`first_activity` is that ride).

**route.** Edge cost = length × (ridden ? 4 : 1), bonus edges × 2 on top
so loops prefer roads but may use a track to reach one. Given start and
target distance D: find the unridden cluster with the most countable km
within D/2 of start, Dijkstra to it, Dijkstra back with edges used on
the way out penalised again. Export GPX. Own Dijkstra first; BRouter with
nogo areas is the fallback if loops come out ugly.

## Phases

Each phase ends on a checkable criterion.

- **Phase 0, repo and plan.** This document. Done.
- **Phase 1, pipeline.** `pnpm fetch && pnpm roads && pnpm match`
  produces `edges.json` and `stats.json` for Sandnes kommune, then all
  of Rogaland. Done when the ridden set for one known ride matches the
  roads actually ridden on that ride, checked by eye in a GeoJSON
  viewer, and one ride outside Rogaland gets its roads fetched and
  matched.
- **Phase 2, map.** `pnpm dev` shows ridden and unridden roads with the
  two tiers told apart, percent per kommune and for Rogaland, and a
  per-ride list with new km. Done when the last ten rides show plausible
  new-km numbers.
- **Phase 3, route builder.** Click start, choose distance, get a loop.
  Done when a generated 40 km loop has at least half its length on
  unridden countable roads, downloads as GPX, and loads on the Garmin.
- **Phase 4, optional.** Scheduled GitHub Action with the API key as a
  secret that regenerates data. Privacy zone and GitHub Pages deploy.

## Open questions

- Exact tier map: unknown until the data is on a map. `service` roads
  (driveways, parking aisles) are the likely argument.
- Overpass load for all of Rogaland: 23 queries of a few MB each should
  be fine; if it is not, Geofabrik's Norway extract plus `osmium` is the
  fallback.
