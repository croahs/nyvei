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

## Status

Phases 1 (pipeline) and 2 (map) done; the route builder is not started.
