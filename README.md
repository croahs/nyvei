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
   length within a few metres. Output is one GeoJSON of edges with a
   `ridden` flag plus a stats file.
4. **site**: a MapLibre map shows ridden and unridden roads, coverage per
   area, and new kilometres per ride.
5. **route**: pick a start and a distance in the browser, get a loop that
   prefers unridden roads, download it as GPX.

See [PLAN.md](PLAN.md) for decisions, phases and open questions.

## Status

Phase 0: plan only, no code yet.
