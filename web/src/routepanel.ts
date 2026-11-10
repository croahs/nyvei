// Route section of the panel: the mode, Generate and "Try another", the route on the map, its
// summary and elevation profile, the GPX, and the route in the address. The points live in
// routepoints.ts, the switches in routeoptions.ts, the worker behind router.ts.

import * as maplibregl from "maplibre-gl";
import { setupProfile } from "./profile";
import type { EdgeOptions, HeatMode, Mode, Route, RouteRequest } from "./route";
import { setupOptions } from "./routeoptions";
import { setupPoints, type Point, type PointKind } from "./routepoints";
import type { Router } from "./router";
import { readRouteLink, writeRouteLink } from "./routeurl";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const km = (n: number) => n.toFixed(1);
/** Summary label for the share on edges with heat ≥ 25 of the chosen mode. */
const HEAT_LABEL: Record<HeatMode, string> = {
  road: "Road heat ≥ 25",
  gravel: "Gravel or ½ road heat ≥ 25",
  offroad: "Off-road or ½ road heat ≥ 25",
};
/** What the route is called in its summary and its GPX. */
function kindOf(r: Route): { label: string; file: string } {
  if (r.mode === "ab") return r.end ? { label: "A to B", file: "a-to-b" } : { label: "Round trip", file: "round-trip" };
  return { loop: { label: "Loop", file: "loop" }, sweep: { label: "Sweep", file: "sweep" }, loopsweep: { label: "Loop + sweep", file: "loop-sweep" } }[r.mode];
}

export interface RoutePanel {
  /** True while the next map click sets a point, so main.ts skips its edge popup. */
  readonly picking: boolean;
  /** The edge switches as the route uses them, for the gaps list. */
  edgeOptions(): EdgeOptions;
  /** Sets a point from elsewhere (the place search); a via or an end switches to A to B. */
  setPoint(kind: PointKind, p: Point): void;
  /** Called when a switch that changes which edges count changes. */
  onOptionsChange(cb: () => void): void;
}

export function setupRoute(map: maplibregl.Map, router: Router): RoutePanel {
  map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "route",
    type: "line",
    source: "route",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#1c7ed6",
      "line-opacity": 0.7,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.5, 12, 5, 16, 10],
    },
  });

  const status = $("#route-status");
  const setStatus = (s: string) => (status.textContent = s);
  const options = setupOptions();
  const points = setupPoints(map, setStatus);
  const showProfile = setupProfile(map, $("#route-profile"));
  const go = $<HTMLButtonElement>("#route-go");
  const next = $<HTMLButtonElement>("#route-next");
  const gpx = $<HTMLButtonElement>("#route-gpx");
  const kmInput = $<HTMLInputElement>("#route-km");
  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("#route-mode button")];
  const result = $("#route-result");

  let ready = false;
  let mode: Mode = options.prefs.mode;
  let variant = 0;
  let requestId = 0;
  let shown: Route | null = null;
  kmInput.value = String(options.prefs.km);

  const sync = () => {
    const ab = mode === "ab";
    go.disabled = !ready || !points.start || (ab && !points.end && !points.via.length);
    // A sweep is the same every time from the same start, so it has no other to try.
    next.disabled = !ready || !shown || shown.mode !== mode || mode === "sweep";
    next.title =
      mode === "sweep"
        ? "A sweep from the same start is always the same, so there is no other to try"
        : "The same request again with a different result: a loop heads for the next patch of unridden roads, preferring another direction; A to B takes other roads than the routes before it";
    gpx.disabled = !shown;
    $("#route-km-row").hidden = ab;
    for (const b of modeButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  };

  const setMode = (m: Mode) => {
    mode = m;
    variant = 0;
    options.setMode(m);
    points.setMode(m);
    options.remember(mode, Number(kmInput.value) || options.prefs.km);
    sync();
  };
  for (const b of modeButtons) b.addEventListener("click", () => setMode(b.dataset.mode as Mode));

  const generate = async () => {
    const start = points.start;
    if (!start || !ready) return;
    const target = Number(kmInput.value);
    if (mode !== "ab" && !(target > 0)) return;
    const sw = options.values(mode);
    const req: RouteRequest = {
      mode,
      start: start.at,
      km: target,
      variant,
      ...sw,
      ...(mode === "ab" ? { end: points.end?.at, via: points.via.map((p) => p.at) } : {}),
    };
    const id = ++requestId;
    const sentAt = performance.now();
    setStatus("Generating…");
    try {
      const { route, ms } = await router.route(req);
      if (id !== requestId) return;
      shown = route;
      show(route, performance.now() - sentAt, ms);
      writeRouteLink({ mode, start: start.at, end: points.end?.at ?? null, via: points.via.map((p) => p.at), km: target, variant }, sw);
    } catch (err) {
      if (id === requestId) setStatus(err instanceof Error ? err.message : String(err));
    }
    sync();
  };

  kmInput.addEventListener("change", () => {
    variant = 0;
    options.remember(mode, Number(kmInput.value) || options.prefs.km);
  });
  options.onChange(() => (variant = 0));
  // Once a route is on the map, moving or removing one of its points routes again.
  points.onChange(() => {
    variant = 0;
    sync();
    if (shown && shown.mode === mode) void generate();
  });
  go.addEventListener("click", () => {
    variant = 0;
    void generate();
  });
  next.addEventListener("click", () => {
    variant++;
    void generate();
  });
  gpx.addEventListener("click", () => {
    if (shown) download(shown);
  });

  // A route in the address: set everything up now and route once the graph is there.
  const link = readRouteLink();
  if (link) {
    if (link.km) kmInput.value = String(link.km);
    options.apply(link.switches);
    points.setAll({ at: link.start }, link.via.map((at) => ({ at })), link.end ? { at: link.end } : null);
  }
  setMode(link?.mode ?? mode);
  if (link) variant = link.variant;

  router.ready.then(
    (m) => {
      ready = true;
      options.setCaps(m);
      setStatus(`Route graph ready: ${m.edges.toLocaleString("en")} edges in ${(m.ms / 1000).toFixed(1)} s`);
      sync();
      if (link) void generate();
    },
    (err: unknown) => setStatus(err instanceof Error ? err.message : String(err)),
  );

  function show(r: Route, roundTrip: number, compute: number): void {
    map.getSource<maplibregl.GeoJSONSource>("route")!.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: r.coords },
    });
    const bounds = new maplibregl.LngLatBounds(r.coords[0], r.coords[0]);
    for (const c of r.coords) bounds.extend(c);
    map.fitBounds(bounds, { padding: 40, maxZoom: 15 });
    const kind = kindOf(r);
    const of = r.mode === "ab" ? "route" : kind.label.toLowerCase();
    const rows: [string, string][] = [
      [kind.label, `${km(r.totalKm)} km`],
      ["Unridden roads", `${km(r.unriddenCountableKm)} km, ${Math.round(r.share * 100)} % of the ${of}`],
      ["Unridden tracks and paths", `${km(r.unriddenBonusKm)} km`],
    ];
    if (r.deadKm !== null) rows.push(["Where no cyclist rides", `${km(r.deadKm)} km`]);
    if (r.popularShare !== null && r.meanHeat !== null) {
      rows.push([HEAT_LABEL[r.heatMode], `${Math.round(r.popularShare * 100)} % of the ${of}, mean heat ${Math.round(r.meanHeat * 100)}`]);
    }
    if (r.ascentM !== null && r.steepKm !== null) rows.push(["Climbing", `${Math.round(r.ascentM)} m up, ${km(r.steepKm)} km at 6 % or steeper`]);
    // Surface only when some of the route is tagged; all untagged says nothing.
    if (r.pavedKm + r.unpavedKm >= 0.05) {
      const parts = [
        r.pavedKm >= 0.05 && `${km(r.pavedKm)} paved`,
        r.unpavedKm >= 0.05 && `${km(r.unpavedKm)} unpaved`,
        r.untaggedKm >= 0.05 && `${km(r.untaggedKm)} untagged`,
      ].filter(Boolean);
      rows.push(["Surface", `${parts.join(" · ")} km`]);
    }
    if (r.mainKm >= 0.05) rows.push(["Main roads", `${km(r.mainKm)} km on trunk and primary roads`]);
    result.replaceChildren(
      ...rows.map(([k, v]) => {
        const div = document.createElement("div");
        div.innerHTML = `<span class="muted"></span> <span></span>`;
        div.children[0]!.textContent = k;
        div.children[1]!.textContent = v;
        return div;
      }),
    );
    showProfile(r);
    const what = r.cluster
      ? `Cluster ${r.cluster.rank + 1} of ${r.cluster.inReach} in reach (${km(r.cluster.km)} km unridden)${r.swept ? `, ${r.swept} stretches swept there` : ""}`
      : r.swept !== null
        ? `${r.swept} unridden stretches swept`
        : `${r.via?.length ? `Through ${r.via.length} via point${r.via.length > 1 ? "s" : ""}` : "Direct"}${variant ? `, alternative ${variant + 1}` : ""}`;
    setStatus(`${what} · ${Math.round(roundTrip)} ms (${Math.round(compute)} ms routing)`);
  }

  sync();
  return {
    get picking() {
      return points.picking !== null;
    },
    edgeOptions: () => options.edgeOptions(),
    setPoint(kind, p) {
      if (kind !== "start" && mode !== "ab") setMode("ab");
      points.set(kind, p);
    },
    onOptionsChange: (cb) => options.onChange(cb),
  };
}

/** GPX 1.1 track of the route, saved through a temporary link, named for what it is. */
function download(r: Route): void {
  const kind = kindOf(r);
  const name = `nyvei ${Math.round(r.totalKm)} km ${kind.label.toLowerCase()}`;
  const pts = r.coords.map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"/>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="nyvei" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name><time>${new Date().toISOString()}</time></metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  const url = URL.createObjectURL(new Blob([xml], { type: "application/gpx+xml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `nyvei-${kind.file}-${Math.round(r.totalKm)}km-${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
