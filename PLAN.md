# Plan

Goal: every ride is matched against the road network around Sandnes, a map
shows ridden and unridden roads, and a route builder makes loops through
unridden roads and exports GPX.

## Decisions

- **Static site, no backend, no accounts.** The pipeline is pnpm scripts
  run locally; the output is files the site reads.
- **Rides from Intervals.icu.** Personal API key, no OAuth. All Garmin
  rides land there already. Strava bulk export can backfill older history
  if Intervals.icu does not go back far enough (depth: unknown, check in
  phase 1).
- **Roads from OpenStreetMap.** Overpass query for a bounding box around
  Sandnes, cached locally. Kommune polygons from OSM admin boundaries come
  later for Wandrer-style "% of Sandnes" numbers.
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
  roads.ts           Overpass -> cache/roads.json (edges split at intersections)
  match.ts           tracks x edges -> web/public/data/edges.json + stats.json
web/                 Vite + MapLibre site, reads public/data/*
cache/               gitignored
```

**fetch.** Activity types Ride, GravelRide, MountainBikeRide, EBikeRide.
Skip VirtualRide and anything without GPS. Keep a manifest of fetched ids
so reruns only download new rides.

**roads.** `highway=*` minus motorway, motorway_link, steps, and anything
with `access=no`/`private`. Keep track, path and cycleway. Decide the
exact class list when seeing the data; make it a config array. Split ways
at shared nodes into edges with id, geometry, length, tags.

**match.** Spatial index on edges. For each track point, find edges
within 15 m. An edge is ridden when matched points cover at least 80 % of
its length, sampled every 10 m. Per edge store `ridden`, `first_date`,
`first_activity`. Stats: total km, ridden km, percent, and new km per
ride (edges whose `first_activity` is that ride).

**route.** Edge cost = length × (ridden ? 4 : 1). Given start and target
distance D: find the unridden cluster with the most km within D/2 of
start, Dijkstra to it, Dijkstra back with edges used on the way out
penalised again. Export GPX. Own Dijkstra first; the graph for a 20 km
box is small. BRouter with nogo areas is the fallback if loops come out
ugly.

## Phases

Each phase ends on a checkable criterion.

- **Phase 0, repo and plan.** This document. Done.
- **Phase 1, pipeline.** `pnpm fetch && pnpm roads && pnpm match`
  produces `edges.json` and `stats.json` for a 20 km box around Sandnes.
  Done when the ridden set for one known ride matches the roads actually
  ridden on that ride, checked by eye on the map in phase 2 or in a
  GeoJSON viewer.
- **Phase 2, map.** `pnpm dev` shows ridden and unridden roads, total
  percent, and a per-ride list with new km. Done when the last ten rides
  show plausible new-km numbers.
- **Phase 3, route builder.** Click start, choose distance, get a loop.
  Done when a generated 40 km loop has at least half its length on
  unridden roads, downloads as GPX, and loads on the Garmin.
- **Phase 4, optional.** Kommune polygons and per-kommune percent.
  Scheduled GitHub Action with the API key as a secret that regenerates
  data. Privacy zone and GitHub Pages deploy.

## Open questions

- Region: bbox first, kommune polygon later. Which kommuner matter?
- Road classes: which count toward the total? Unknown until the data is
  on a map.
- Intervals.icu history depth: unknown, check in phase 1.
- Wandrer counts an edge once ridden in either direction. Same here, or
  track direction? Start with either direction.
