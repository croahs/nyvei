# Plan

Goal: every ride is matched against the road network, a map shows ridden
and unridden roads, coverage is counted per kommune and over time, and a
route builder makes loops, sweeps and A to B routes through unridden roads
that other cyclists actually ride, and exports GPX. The map also carries gravelheater's Strava heat overlays; that
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
  `stats.timeline` counts the edges in the zone, like the totals do, so
  the month they were first ridden can be worked out from the published
  edges; accepted, because the hole in the map says more.
- **Strava heatmap, merged in from gravelheater.** The global heatmap
  (sport layers Ride, GravelRide, MountainBikeRide) does two jobs. As
  overlays, raster tiles on the map: *road* (the Ride layer as it is) and
  gravelheater's *gravel* (gravel − road) and *offroad* (mtb + gravel −
  road). And as heat per edge, 0..100:
  *bike heat* `t` for the map, and road, gravel and off-road heat (`tr`,
  `tg`, `to`), one of which the route builder prefers so loops stay on
  roads people ride, so a loop does not pick a road just because it is unridden. Tiles
  are fetched with the cookies of a logged-in strava.com session, for
  personal use only. All heat is one folder, `cache/heat/tiles`: the
  overlay tiles, meta.json and edges.json (per edge file and edge id, its
  four heats, written by `pnpm match`). That folder is the `heat` branch
  of the Pages project, heat.nyvei.pages.dev, deployed with `pnpm
  heat:pages` from the owner's machine whenever the heat is refreshed,
  which is rare; production deploys of the site never touch it. It is
  served by `pipeline/heatworker.js`, deployed with it as `_worker.js`:
  every file needs `?k=` equal to the `HEAT_KEY` secret of the Pages
  project's preview environment, and goes out with
  `Access-Control-Allow-Origin: *`. The owner gives the site the key once
  as `?heat=<key>`; it stays in that browser's localStorage, and every
  other visitor gets the site without heat. (Its own project was the first
  plan, but wrangler now creates new Pages projects as Workers, and that
  failed.) The site build and the edge
  files carry no heat, so the nightly workflow can rebuild and deploy
  the site without it; the browser fetches the heat project and joins it
  onto the edges by id (the router in its worker, the map colouring as
  feature-state). The site is not behind Cloudflare Access: it is
  personal and of no interest to anyone else. Edge ids come from each
  side's own road data, so an edge whose id changed since the last local
  `pnpm match` has no heat until the next `pnpm heat:pages`. Heat covers gravelheater's "sandnes"
  box (Egersund to Nord-Jæren and Suleskard); edges outside it have no
  heat and route as before.
- **Surface and elevation per edge.** Surface is the OSM `surface` tag
  through `SURFACE` in `pipeline/config.ts`: paved, unpaved, or absent
  (63 % of edges have no usable tag). Elevation is from the Mapzen
  Terrarium tiles on AWS Open Data (no key, global, so rides outside
  Rogaland have it too) at zoom 12, about 19 m per pixel here: coarser
  than Kartverket's own DTM, but one source for everywhere. `pnpm match`
  fetches the tiles it lacks into `cache/dem`; a tile that fails leaves
  elevation off its edges and never fails the run. One height per 50 m
  and both ends, whole metres, clamped at 0 (a shore pixel blends in the
  sea floor); a bridge or tunnel reads only its two ends, since the
  ground under or over it is not the road. Against the barometer of three
  hilly rides the tiles climb too much, which the route's ascent
  corrects with a 5 m deadband (route, below).
- **Not rideable is the owner's list, not the map's.** A road that turns
  out to be a private drive, gated or overgrown is marked in the site
  and never routed over again. Marks live in the browser's localStorage
  and take effect at once; the permanent list is
  `web/public/blocked.json`, committed and served with the site, which
  the site merges with the local marks by edge id (the panel copies the
  merged list as JSON to paste in). Entries are `{ id, name?, at }`. A
  marked road still counts in the coverage percent: the list says where
  not to route, not what exists. An edge id is `<way id>_<index>`, so an
  entry stops matching when OSM splits its way differently; the panel
  counts those.
- **Published on Cloudflare Pages**, repo stays private. GitHub Pages
  is not available on this account's plan for a private repo. `pnpm
  pages` deploys `web/dist` with wrangler, from this machine or from the
  Publish workflow (nightly, on push, on demand), which also writes the
  new km back. Heat is a separate project (above), so either deploy has
  it. Cloudflare's 25 MB limit per file is why outside edges are one file
  per ride box.

## Architecture

```
pipeline/            pnpm scripts, run locally
  rides.ts           Intervals.icu -> cache/activities/<id>.gpx (incremental by id)
  roads.ts           Overpass per kommune -> cache/roads/<kommune>.json
  match.ts           tracks x edges -> web/public/data/kommuner/<slug>.json,
                     outside/<box>.json, tracks/<id>.json, stats.json
                     (fetches cache/roads/ride-<id>.json for rides outside the region
                     and the elevation tiles it lacks, cache/dem/12/<x>/<y>.png)
  writeback.ts       stats.json -> one "nyvei:" line per activity description on Intervals.icu
  heat.ts            Strava heatmap -> cache/heat/raw/<layer>/<z>/<x>/<y>.png (resumable)
  heattiles.ts       raw layers -> cache/heat/tiles/{road,gravel,offroad}/ + meta.json
                     (match.ts reads cache/heat/raw and writes cache/heat/tiles/edges.json;
                     pnpm heat:pages deploys cache/heat/tiles as the heat branch)
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
`first_activity` is that ride). `stats.timeline` has one entry per month
from the first ride to the last, empty months included: the month's new
km (the sum of its rides' numbers, inside and outside the region) and
the cumulative countable km and percent in the kommuner under the
blanket rule, against today's total, so the last entry equals the
total. An edge is in the privacy zone when its line comes inside the
circle, not only a vertex: a long straight edge can cross it between two
vertices outside, and its elevation samples would be read in there.

**site.** Edges go out as one GeoJSON file per kommune plus one per ride
box outside the region (`outside/<box>.json`),
5-decimal coordinates, one-letter property names (the map is in the
header of `match.ts` and in `web/src/props.ts`), with surface and
elevations where there are any; about 124 MB in all. The site loads a file when its bounding box enters the viewport and MapLibre parses it in
its worker, so the main thread only reads `stats.json`. Basemap is
OpenFreeMap Positron, no key. Selecting a ride loads its thinned track
from `tracks/<id>.json` and highlights its first-ridden edges, solid
where they count as its new km. The panel also has a place and address
search (Kartverket's open stedsnavn and adresser APIs, straight from
the browser, addresses only when the query has a digit), the progress
charts from `stats.timeline`, and per kommune the km left to its next
whole percent.

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
already uses, and raspberry (road, r ≥ 0.08, the busy end of the edge
heat ramp). Road has signal in nearly every tile, so its z15 level is
dropped and z14 is stretched (`layerMaxzoom` in meta.json): with it a
deploy would near Cloudflare Pages' 20000 files, without it about 8000.
Road starts hidden. `pnpm match` gives each edge its heat: every 10 m sample
reads the brightest pixel of each layer within ±2 px, the end samples
are dropped because the junction carries the joining road's heat, and
each heat is a mean over the samples. `t` is the brightest of the three
layers, in percent: Strava normalises each layer on its own, so the max
says how much the busiest group of cyclists uses the road. `tr` is the
Ride layer, `tg` the gravel score and `to` the off-road score (counted
also where gravel fires, unlike the overlay, and capped at 1). Each of
those three is scaled so its 95th percentile over heated edges is 100,
because gravel − road is a difference and mostly small: unscaled, the
median heated edge had gravel heat 6 and a gravel preference barely
moved a loop. In dev a Vite plugin serves `cache/heat/tiles` at /heat/, so
heat works without a deploy; base maps (Positron, Kartverket topo and gråtone, OSM, OpenTopoMap)
are a raster layer under everything, chosen in the panel.

**route.** Edge cost = length × (ridden ? 4 : 1), bonus edges × 2 on top
so loops prefer roads but may use a track to reach one, × (1 − k × heat)
with heat / 100 = `tr` for the panel's road choice, max(½ `tr`, `tg`)
for gravel and max(½ `tr`, `to`) for off-road, and k the "prefer bike
heat" slider (0 to 0.9, default 0.7), so with k = 0.7 the busiest road
costs 0.3 of a dead one. Popular roads count in every mode, so the
busier ones get ticked off first; at half weight a busy gravel track
still beats a busy asphalt road. With full road heat the three modes gave
the same loops from Sandnes and Ålgård, because road heat is the larger
on nearly every road. The default stays below k = 0.75, where the
busiest ridden road (4 × (1 − k)) would cost no more than a dead
unridden one: at 0.8, 40 km loops from Ålgård were only 25 to 41 %
unridden. "Roads only"
sets bonus edges to infinite cost and snaps the start to a component of
countable edges, because many bonus ways are hard going on a bike.
"Skip where no one rides" (on by default) does the same for every edge,
roads included, with both ends in the heat bbox (`bbox` in the heat
project's meta.json) and heat 0 in the chosen mode: the owner treats the road
heatmap as the judge of what is worth riding. Residential and living
streets are exempt, because the owner means to ride every street: of
the 631 unridden countable km in the box with no road heat, the 222 km
of residential stay in reach and the other 409 km (346 km unclassified,
47 km trunk and secondary) are never ridden by a route, though they
still count in the stats.
In gravel and off-road mode a bonus edge whose own heat (`tg` or `to`)
is at least 25 counts as a road: no bonus factor, and it joins the
destination clusters, because a track good enough for that much gravel
heat is good enough to route a gravel ride over (86 unridden km in the
box at gravel ≥ 25). Gravel laps that are not in OSM at all stay out of
reach. OSM's `sac_scale`, `mtb:scale` and `smoothness` and the Strava hike
layer would sharpen the cut and are not used. The graph (nodes
are the `a`/`b` OSM node ids, edges undirected) is built in a Web Worker
that fetches the edge files itself; that is faster than handing it
MapLibre's parsed copy, because structured cloning 400k features blocks
the page for seconds. Given start and target distance D: Dijkstra from
the start, cut at D/2 of path length; clusters are connected components
of unridden destination edges (countable, plus the busy tracks above in
gravel and off-road mode) that the route may use (an edge left out by
"roads only" or "skip where no one rides" is nothing to head for),
ranked by their km inside that
reach (weighted by (1 − k + k × heat), so a busy cluster outranks a
dead one), counting only clusters that reach at least 0.35 D out (a cluster
next to the start cannot turn a loop of length D). In the chosen cluster
the turnaround is the node at outbound length r that is cheapest per
metre; Dijkstra back with the outbound edges × 4 again, then r is
rescaled until out + back is within 5 % of D (at most 8 tries). "Try
another" walks the clusters in rank order, discounting any within 45° of
an earlier one's bearing so the next loop heads somewhere else. The panel
shows the share of the loop on edges with the chosen heat ≥ 25. A loop
picks up unridden streets near home only on its way out and back, and
a dead end only as its turnaround, so "Sweep" covers those: from the
start it rides every unridden destination edge it reaches, nearest
first (the next one right at the current node if it fits, else the
cheapest path to the nearest that does, with edges it has ridden × 4),
dead ends included, as long as what is left of D still covers the
cheapest way home, then goes home. A 20 km sweep from central Sandnes
rode 253 unridden stretches, 11.3 km of new road, in under 0.1 s. Export
GPX 1.1. Own Dijkstra first; BRouter with nogo areas is the fallback if
loops come out ugly.

Four more cost rules, each a switch in the panel. *Avoid main roads* (on
by default): trunk and primary cost × 4 and are nothing to head for;
without it a gravel-mode route from home took 5.5 km of riksvei, with it
a 40 km loop + sweep from Sandnes went from 6.9 to 0.1 km on them.
*Paved only* leaves out edges tagged unpaved and bonus edges with no
surface tag (an untagged road or cycleway here is nearly always
asphalt, an untagged track is not). *Avoid steep*: an edge's steep share
is the part of its length at 6 % or more, counting an elevation
interval only when it also rises 2 m (whole metres make 1 m on a short
interval read as 6 %); cost × (1 + 3 × steep share), and clusters rank
by their km × (1 − steep share). From Sandnes a 40 km loop went from
4.7 to 1.4 km steep and 32.0 to 26.1 km unridden. Roads marked *not
rideable* are unusable in every mode and never a target.

*Loop + sweep* is a loop sized for 0.7 D with a sweep spliced in at its
turnaround: the sweep gets what is left of D, comes back to the
turnaround, and the loop's own way home follows. From Sandnes at 40 km
the legs are 14 out, 11 sweep, 15 back, with 33.7 km unridden (the loop
alone: 35.4 of 41.3). Sweeping on towards home instead drifts: nearest
first keeps finding a street closer to home and zigzags all the way
back. Its clusters always rank by km × (1 − steep share), because a
sweep climbs every side street. At 0.6 the loop is too short to reach a
far target, at 0.8 only 7 km is left to sweep.

*A to B* goes start, vias in order, end, and back to the start when
there is no end (a round trip through chosen places), each leg a
cheapest path under the same costs with the earlier legs' edges × 4, so
a round trip does not retrace: Sandnes, Ålgård and home is 28.3 km with
0.2 km ridden twice. "Try another" routes the earlier variants first
and makes their edges cost × 2: at 1.5 the third route shared up to
52 % with the first, at 3 it ran up to 43 % longer. Sandnes to Bryne
gives 17.2, 16.4 and 20.2 km with 1 to 3 % in common.

A *gap* is a cluster of unridden target edges of at most 500 m in all
that touches a ridden edge: the stubs left between roads already
ridden. There are about 1900 (313 km); the panel lists the nearest, and
"only gaps" makes a sweep ride nothing else (15 km from Sandnes: 70
edges, 6.1 km new). 137 of them are under 30 m and look like junction
stubs where the 80 % rule missed rather than streets.

A route's result carries its climb, steep km, an elevation profile and
its km by surface and on main roads. The climb uses a 5 m deadband: the
19 m pixels wobble along a road, and at 2 m the tiles read 20 to 40 %
over the barometer on three of the owner's hilly rides (73 to 133 km),
at 5 m within 3 to 14 %; flat rides read a little low. Steep km agreed
with the barometer within a few km on the same rides. The whole request
(mode, points, distance, switches, variant) lives in the address as
`?route=…&start=lat,lon&via=…&end=…&km=…&opts=…&prefer=…&try=…`, next to
`?ride=`, so a link rebuilds the same route on another device as long
as the data has not changed.

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
- **Phase 4, publish.** Privacy zone, Cloudflare Pages, nightly update.
  Done when `pnpm pages` puts the map on the pages.dev URL with
  no published edge or track point inside the zone (checked with a
  script against a test point). Live at https://nyvei.pages.dev, checked
  with a script against the real zone (0 published points inside). The
  Publish workflow runs nightly and on every push.

- **Phase 5, gravelheater merged in.** Heat overlays, base maps and bike
  heat routing in this site. Done when, from Sandnes with real tiles, a
  40 km loop with "prefer bike heat" on has most of its length on edges
  with heat ≥ 25 and still half on unridden countable roads, checked
  against the overlay on the map. Built and checked on a synthetic grid
  with fake tiles (a 20 km loop went from 19 % to 96 % on busy edges
  between k = 0 and 0.9). Met on the published site with real tiles:
  from central Sandnes at k = 0.6, a 39.7 km loop north to Stavanger
  has 92 % on heat ≥ 25 (also 92 % on road heat after the road, gravel
  and off-road split) and 85 % on unridden countable roads, and the
  edge heat colouring shows it on busy roads. Around Sandnes most roads
  carry heat anyway (k = 0 gives 78 %), so here the slider moves less
  than on the synthetic grid.

- **Phase 6, more routes and progress.** A to B with vias, loop + sweep,
  avoid main roads, paved only, avoid steep, not rideable, gaps, place
  search, my position, route in the address, progress over time, next
  percent per kommune. Done when each works on the rendered page with
  real data at desktop and phone width. Built and checked on
  `pnpm dev` at 1440 and 390 px; not yet published, and real GPS on a
  phone is untried (geolocation was emulated).

## Open questions

- Exact tier map: unknown until the data is on a map. `service` roads
  (driveways, parking aisles) are the likely argument.
- Loop shape: in a dense street grid the way back runs a block or two
  from the way out, so loops come out as narrow corridors (Sandnes to
  Stavanger and back) rather than round. A cost on edges near the
  outbound path would widen them; BRouter is the bigger step.
- Data size: the edge files are about 124 MB in all and the first full
  view takes about 8 s. Vector tiles (PMTiles) would cut that on the
  published site.
- Heat calibration: whether heat ≥ 25 is the right line for "roads
  cyclists use", whether k = 0.7 is the right default, and whether the
  95th percentile is the right scale for gravel and off-road. From
  Sandnes at k = 0.6, gravel took a 40 km loop from 8 % to 26 % on
  gravel heat ≥ 25 and off-road from 33 % to 59 %, but there is little
  gravel within reach there.
- Calibration of the new routes: the 500 m gap limit (200 m gives 1296
  gaps and 123 km, 1000 m 2265 and 576 km), whether gaps under 30 m
  should be listed at all, the 2 m rise in the steep rule, and the 5 m
  ascent deadband, which is set from three rides.
- Loops that miss their distance: "try another" on a 40 km loop from
  Sandnes gave 35.6 km for the second cluster, outside the 5 % the
  rescaling aims for. Unchanged from before phase 6; not looked into.
- Left behind in gravelheater: GPX import, saved routes (the address
  holds one route) and the second area (Stellenbosch). Port them here if
  they are missed.
