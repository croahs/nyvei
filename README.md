# nyvei

A personal [Wandrer](https://wandrer.earth): which roads around Sandnes have
I ridden, which have I not, and loops that take me through the ones I have
not. Static site, no backend, no accounts.

## How it works

1. **fetch**: rides come from Intervals.icu (personal API key, GPX per
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
pnpm run fetch   # rides -> cache/activities (pnpm's own `fetch` command shadows the bare form)
pnpm roads       # roads per kommune -> cache/roads; `pnpm roads sandnes` for one
pnpm match       # -> web/public/data/edges.json + stats.json
```

`pnpm match --skip-outside` matches without fetching roads for rides that
leave the loaded kommuner, for runs with a partial kommune list.

## Status

Phase 1 (pipeline) done; the map and route builder are not started.
