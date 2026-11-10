import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";
import { setupBlocked } from "./blocked";
import {
  EDGE_HEAT_URL,
  edgeFiles,
  loadEdgeHeat,
  loadHeatMeta,
  loadStats,
  loadTrack,
  P,
  type BBox,
  type EdgeFile,
  type EdgeHeat,
  type RideStats,
  type Stats,
} from "./data";
import { setupEdgePopup } from "./edgepopup";
import { setupGaps } from "./gaps";
import { setupKommuner } from "./kommuner";
import { setupMapSection } from "./layers";
import { setupProgress } from "./progress";
import { startRouter } from "./router";
import { setupRoute, type RoutePanel } from "./routepanel";
import { setupSearch } from "./search";
import { param, setParams } from "./url";

// MapLibre looks for its worker next to its own module, which Vite's bundling moves.
maplibregl.setWorkerUrl(workerUrl);

// Layer groups, bottom to top. Every edge file gets one layer per group; an
// empty anchor layer per group keeps the groups stacked as files load in.
const ridden: ExpressionSpecification = ["has", P.firstDate];
const countable: ExpressionSpecification = ["==", ["get", P.countable], 1];
const width = (w: number): ExpressionSpecification => ["interpolate", ["linear"], ["zoom"], 8, w * 0.4, 12, w, 16, w * 2.5];

interface Group {
  id: string;
  filter: ExpressionSpecification;
  color: string;
  /** Desaturated color while a ride is selected, so its own roads stand out. */
  muted?: string;
  /** Unridden groups take the bike heat ramp when "colour by bike heat" is on. */
  heat?: boolean;
  width: number;
  dash?: number[];
}
const GROUPS: Group[] = [
  { id: "bonus", filter: ["all", ["!", ridden], ["!", countable]], color: "#9aa2ab", width: 0.8, dash: [2, 2], heat: true },
  { id: "road", filter: ["all", ["!", ridden], countable], color: "#6f7a87", width: 1.3, heat: true },
  { id: "bonus-ridden", filter: ["all", ridden, ["!", countable]], color: "#8b3fd9", muted: "#c9bdd6", width: 1.4 },
  { id: "road-ridden", filter: ["all", ridden, countable], color: "#e8590c", muted: "#dcc3b5", width: 2.4 },
];
const NEW_GROUP = "new";
/** Roads marked not rideable, drawn on top of their own colour (blocked.ts). */
const BLOCKED_GROUP = "blocked";
const NO_RIDE: ExpressionSpecification = ["==", ["get", P.firstActivity], ""];
const RIDDEN_COLOR = GROUPS.find((g) => g.id === "road-ridden")!.color;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const km = (n: number) => n.toFixed(1);

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  bounds: [5.2, 58.3, 7.2, 59.85],
  attributionControl: { compact: true },
});
const mapReady = new Promise((r) => map.once("load", r));
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), "top-left");
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

let stats: Stats;
let files: EdgeFile[] = [];
const loaded = new Set<string>();
const settled = new Set<string>();
let rideFilter: ExpressionSpecification = NO_RIDE;
let selected: string | null = null;
let route: RoutePanel | undefined;
const started = performance.now();

let edgeHeat = false;
/** Edge heat from the heat project, null when there is none; joined onto the edges as feature-state `t`. */
let heat: EdgeHeat | null = null;
const heated = new Set<string>();
/** Bike heat ramp (feature-state `t`, 0..100); mirrored by .heat-ramp in style.css. */
const HEAT_RAMP: ExpressionSpecification = [
  "interpolate", ["linear"], ["coalesce", ["feature-state", "t"], 0],
  0, "#c3c8cf", 10, "#fcc2d7", 30, "#f06595", 60, "#c2255c", 90, "#5c0f2e",
];
const groupColor = (g: Group): string | ExpressionSpecification => (edgeHeat && g.heat ? HEAT_RAMP : (selected && g.muted) || g.color);

let blockedFilter: ExpressionSpecification = ["in", ["get", P.id], ["literal", []]];
function drawBlocked(ids: string[]): void {
  blockedFilter = ["in", ["get", P.id], ["literal", ids]];
  for (const k of loaded) map.setFilter(`${BLOCKED_GROUP}-${k}`, blockedFilter);
}
const blocked = setupBlocked(map, drawBlocked);

function setEdgeHeat(on: boolean): void {
  edgeHeat = on;
  for (const k of loaded) for (const g of GROUPS) if (g.heat) map.setPaintProperty(`${g.id}-${k}`, "line-color", groupColor(g));
}
/** Puts a loaded edge file's bike heat on its features, once. */
function applyHeat(key: string): void {
  const source = `edges-${key}`;
  if (!heat || heated.has(key) || !map.getSource(source) || !map.isSourceLoaded(source)) return;
  heated.add(key);
  for (const [id, v] of Object.entries(heat[key] ?? {})) map.setFeatureState({ source, id }, { t: v[0] });
}
map.on("sourcedata", (e) => {
  if (e.isSourceLoaded && e.sourceId.startsWith("edges-")) applyHeat(e.sourceId.slice("edges-".length));
});
const interactive = () => [...loaded].flatMap((k) => [...GROUPS.map((g) => `${g.id}-${k}`), `${NEW_GROUP}-${k}`]);

function setupLayers(): void {
  map.addSource("anchors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  for (const g of [...GROUPS.map((g) => g.id), NEW_GROUP, BLOCKED_GROUP]) map.addLayer({ id: `anchor-${g}`, type: "line", source: "anchors" });
  map.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    // A selected ride's own track in ridden orange over the muted network; its new edges draw green on top.
    {
      id: "track",
      type: "line",
      source: "track",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": RIDDEN_COLOR, "line-width": width(2.4) },
    },
    `anchor-${NEW_GROUP}`,
  );
}

function addFile(f: EdgeFile): void {
  loaded.add(f.key);
  const source = `edges-${f.key}`;
  map.addSource(source, { type: "geojson", data: f.url, maxzoom: 14, tolerance: 0.5, promoteId: P.id });
  for (const g of GROUPS) {
    map.addLayer(
      {
        id: `${g.id}-${f.key}`,
        type: "line",
        source,
        filter: g.filter,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": groupColor(g),
          "line-width": width(g.width),
          ...(g.dash ? { "line-dasharray": g.dash } : {}),
        },
      },
      `anchor-${g.id}`,
    );
  }
  // A selected ride's first-ridden edges: solid where counted as its new km, faint where cleared alongside.
  map.addLayer(
    {
      id: `${NEW_GROUP}-${f.key}`,
      type: "line",
      source,
      filter: rideFilter,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#0ca678",
        // MapLibre wants the zoom interpolation outermost, so the case sits in each stop.
        "line-width": [
          "interpolate", ["linear"], ["zoom"],
          8, ["case", ["has", P.counted], 1.6, 0.8],
          12, ["case", ["has", P.counted], 4, 2],
          16, ["case", ["has", P.counted], 10, 5],
        ],
        "line-opacity": ["case", ["has", P.counted], 1, 0.45],
      },
    },
    `anchor-${NEW_GROUP}`,
  );
  // Not rideable: short black dashes, a look no other layer uses, like a barrier on a paper map.
  map.addLayer(
    {
      id: `${BLOCKED_GROUP}-${f.key}`,
      type: "line",
      source,
      filter: blockedFilter,
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": "#1f2328", "line-width": width(3), "line-dasharray": [1, 0.8] },
    },
    `anchor-${BLOCKED_GROUP}`,
  );
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Load every edge file with a box in the viewport; loaded files stay. */
function loadVisible(): void {
  const b = map.getBounds();
  const view: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  for (const f of files) if (!loaded.has(f.key) && f.boxes.some((box) => intersects(box, view))) addFile(f);
  updateStatus();
}

function updateStatus(): void {
  const s = ((performance.now() - started) / 1000).toFixed(1);
  $("#status").textContent =
    settled.size < loaded.size
      ? `Loading edge files, ${settled.size} of ${loaded.size} ready…`
      : `${loaded.size} of ${files.length} edge files, ready at ${s} s`;
}

map.on("sourcedata", (e: maplibregl.MapSourceDataEvent) => {
  if (!e.sourceId.startsWith("edges-") || !e.isSourceLoaded) return;
  const key = e.sourceId.slice("edges-".length);
  if (settled.has(key)) return;
  settled.add(key);
  updateStatus();
});

function edgeAt(point: maplibregl.Point): MapGeoJSONFeature | undefined {
  const layers = interactive().filter((id) => map.getLayer(id));
  if (!layers.length) return undefined;
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - 4, point.y - 4],
    [point.x + 4, point.y + 4],
  ];
  return map.queryRenderedFeatures(box, { layers })[0];
}
// Registered before the route panel's own click handler, so it still sees a point being picked.
setupEdgePopup(map, { edgeAt, stats: () => stats, heat: () => heat, picking: () => !!route?.picking, blocked });
// The search flies the map from the start; its points wait for the route panel.
setupSearch(map, (kind, at, label) => route?.setPoint(kind, { at, label }));

// Panel.
function renderTotals(): void {
  const t = stats.total;
  $("#total").innerHTML = `
    <div class="big">${km(t.percent)} %</div>
    <div>${km(t.countable_ridden_km)} of ${km(t.countable_km)} km countable roads in Rogaland</div>
    <div class="muted">Bonus ${km(t.bonus_ridden_km)} of ${km(t.bonus_km)} km · outside Rogaland ${km(
      t.outside_ridden_km.countable + t.outside_ridden_km.bonus,
    )} km</div>`;
}

function renderRides(): void {
  const rides = [...stats.rides].sort((a, b) => b.date.localeCompare(a.date));
  const body = $("#rides tbody");
  body.replaceChildren(
    ...rides.map((r) => {
      const tr = document.createElement("tr");
      tr.dataset.id = r.id;
      tr.innerHTML = `<td class="muted"></td><td class="name"></td><td class="num"></td><td class="num"></td><td class="num"></td>`;
      const cells = [r.date.slice(0, 10), r.name, km(r.distance_km), km(r.new_countable_km), km(r.new_bonus_km)];
      cells.forEach((c, i) => (tr.children[i]!.textContent = c));
      (tr.children[1] as HTMLElement).title = r.name;
      tr.addEventListener("click", () => void selectRide(selected === r.id ? null : r));
      return tr;
    }),
  );
}

// The selected ride lives in the URL as ?ride=<id>, so a link (for one from the
// Intervals.icu description) opens the site on that ride. The route's parameters stay beside it.
async function selectRide(r: RideStats | null): Promise<void> {
  selected = r?.id ?? null;
  setParams({ ride: r ? r.id : null });
  rideFilter = r ? ["==", ["get", P.firstActivity], r.id] : NO_RIDE;
  for (const k of loaded) {
    map.setFilter(`${NEW_GROUP}-${k}`, rideFilter);
    for (const g of GROUPS) if (g.muted) map.setPaintProperty(`${g.id}-${k}`, "line-color", groupColor(g));
  }
  for (const tr of document.querySelectorAll<HTMLElement>("#rides tr")) {
    const on = tr.dataset.id === selected;
    tr.classList.toggle("selected", on);
    if (on) tr.scrollIntoView({ block: "center" });
  }
  const info = $("#ride-info");
  const track = map.getSource<maplibregl.GeoJSONSource>("track")!;
  if (!r) {
    info.hidden = true;
    track.setData({ type: "FeatureCollection", features: [] });
    return;
  }
  info.hidden = false;
  $("#ride-name").textContent = `${r.date.slice(0, 10)} ${r.name}`;
  $("#ride-new").textContent = `${km(r.new_countable_km)} km new countable, ${km(r.new_bonus_km)} km new bonus of ${km(r.distance_km)} km`;
  const segments = await loadTrack(r.id);
  const coords = segments.flat();
  if (selected !== r.id || coords.length < 2) return;
  track.setData({ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: segments } });
  const bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) bounds.extend(c);
  map.fitBounds(bounds, { padding: 40, maxZoom: 15 });
}
$("#ride-clear").addEventListener("click", () => void selectRide(null));

/** The credit Mapzen's terrain tiles ask for, on the map's attribution once edges carry elevations. */
function creditElevation(): void {
  map.addSource("elevation-credit", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    attribution:
      // Short, since a phone shows the attribution over the map; the link lists every source.
      '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Elevation: Mapzen terrain tiles, © Kartverket and others</a>',
  });
  // MapLibre credits only sources a layer uses, so an empty layer carries it.
  map.addLayer({ id: "elevation-credit", type: "line", source: "elevation-credit" });
  // On a phone the open attribution now covers a fifth of the map until the first drag; start it
  // folded behind its (i) button, which MapLibre's compact mode is for.
  if (matchMedia("(max-width: 700px)").matches) document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
}

async function start(): Promise<void> {
  try {
    stats = await loadStats();
  } catch (err) {
    $("#status").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  files = edgeFiles(stats);
  // Heat loads alongside the roads; the map and router take it once it is here.
  const heatLoad = Promise.all([loadHeatMeta(), loadEdgeHeat()]);
  renderTotals();
  setupKommuner(map, stats);
  setupProgress(stats);
  renderRides();
  $("#generated").textContent = `Data from ${stats.generated.slice(0, 16).replace("T", " ")}`;
  await mapReady;
  setupLayers();
  loadVisible();
  map.on("moveend", loadVisible);
  const [meta, edges] = await heatLoad;
  heat = edges;
  for (const k of loaded) applyHeat(k);
  setupMapSection(map, `anchor-${GROUPS[0]!.id}`, meta, !!heat, setEdgeHeat);
  const router = startRouter(files, {
    heatUrl: heat ? EDGE_HEAT_URL : undefined,
    heatBBox: meta?.bbox,
    blocked: blocked.ids(),
    onProgress: (done, of) => ($("#route-status").textContent = `Building route graph, ${done} of ${of} files…`),
  });
  blocked.attach(router);
  const panel = setupRoute(map, router);
  route = panel;

  const gaps = setupGaps(map, router, `anchor-${GROUPS[0]!.id}`, panel.edgeOptions);
  panel.onOptionsChange(gaps.refresh);
  blocked.onChange(gaps.refresh);
  void router.ready.then((r) => {
    if (r.hasElev) creditElevation();
  }, () => undefined);
  const ride = stats.rides.find((r) => r.id === param("ride"));
  if (ride) void selectRide(ride);
}

void start();
