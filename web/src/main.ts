import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, LngLatBoundsLike, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";
import { edgeFiles, loadStats, loadTrack, P, type BBox, type EdgeFile, type RideStats, type Stats } from "./data";

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
  width: number;
  dash?: number[];
}
const GROUPS: Group[] = [
  { id: "bonus", filter: ["all", ["!", ridden], ["!", countable]], color: "#9aa2ab", width: 0.8, dash: [2, 2] },
  { id: "road", filter: ["all", ["!", ridden], countable], color: "#6f7a87", width: 1.3 },
  { id: "bonus-ridden", filter: ["all", ridden, ["!", countable]], color: "#8b3fd9", width: 1.4 },
  { id: "road-ridden", filter: ["all", ridden, countable], color: "#e8590c", width: 2.4 },
];
const NEW_GROUP = "new";
const NO_RIDE: ExpressionSpecification = ["==", ["get", P.firstActivity], ""];

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
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

let stats: Stats;
let files: EdgeFile[] = [];
const loaded = new Set<string>();
const settled = new Set<string>();
let rideFilter: ExpressionSpecification = NO_RIDE;
let selected: string | null = null;
const started = performance.now();

const interactive = () => [...loaded].flatMap((k) => [...GROUPS.map((g) => `${g.id}-${k}`), `${NEW_GROUP}-${k}`]);

function setupLayers(): void {
  map.addSource("anchors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  for (const g of [...GROUPS.map((g) => g.id), NEW_GROUP]) map.addLayer({ id: `anchor-${g}`, type: "line", source: "anchors" });
  map.addSource("track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    { id: "track", type: "line", source: "track", paint: { "line-color": "#1d3f8f", "line-width": width(1.2), "line-dasharray": [3, 2] } },
    `anchor-${NEW_GROUP}`,
  );
}

function addFile(f: EdgeFile): void {
  loaded.add(f.key);
  const source = `edges-${f.key}`;
  map.addSource(source, { type: "geojson", data: f.url, maxzoom: 14, tolerance: 0.5 });
  for (const g of GROUPS) {
    map.addLayer(
      {
        id: `${g.id}-${f.key}`,
        type: "line",
        source,
        filter: g.filter,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": g.color,
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

// Hover (and tap) shows the edge under the pointer.
const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px", offset: 8 });

function edgeAt(point: maplibregl.Point): MapGeoJSONFeature | undefined {
  const layers = interactive().filter((id) => map.getLayer(id));
  if (!layers.length) return undefined;
  const box: [maplibregl.PointLike, maplibregl.PointLike] = [
    [point.x - 4, point.y - 4],
    [point.x + 4, point.y + 4],
  ];
  return map.queryRenderedFeatures(box, { layers })[0];
}

function showEdge(e: maplibregl.MapMouseEvent): void {
  const f = edgeAt(e.point);
  map.getCanvas().style.cursor = f ? "pointer" : "";
  if (!f) {
    popup.remove();
    return;
  }
  const p = f.properties;
  const first = p[P.firstDate] as string | undefined;
  const ride = first ? stats.rides.find((r) => r.id === p[P.firstActivity]) : undefined;
  const div = document.createElement("div");
  div.className = "edge-popup";
  const rows: [string, string][] = [
    ["Highway", String(p[P.highway])],
    ["Tier", p[P.countable] === 1 ? "countable" : "bonus"],
    ["Length", `${p[P.length]} m`],
    ["First ridden", first ? `${first}${ride ? ` · ${ride.name}` : ""}` : "not yet"],
  ];
  const title = document.createElement("strong");
  title.textContent = (p[P.name] as string | undefined) ?? "Unnamed";
  div.append(title);
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.innerHTML = `<span></span> <span></span>`;
    row.children[0]!.textContent = k;
    row.children[1]!.textContent = v;
    div.append(row);
  }
  popup.setLngLat(e.lngLat).setDOMContent(div).addTo(map);
}
map.on("mousemove", showEdge);
map.on("click", showEdge);
map.getCanvas().addEventListener("mouseleave", () => popup.remove());

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

function renderKommuner(): void {
  const rows = Object.entries(stats.kommuner).sort((a, b) => b[1].percent - a[1].percent || a[1].name.localeCompare(b[1].name));
  const body = $("#kommuner tbody");
  body.replaceChildren(
    ...rows.map(([, k]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td></td><td class="num"></td><td class="num muted"></td>`;
      tr.children[0]!.textContent = k.name;
      tr.children[1]!.textContent = `${km(k.percent)} %`;
      tr.children[2]!.textContent = `${km(k.countable_ridden_km)} / ${km(k.countable_km)}`;
      tr.style.setProperty("--pct", `${k.percent}%`);
      if (k.bbox) tr.addEventListener("click", () => map.fitBounds(k.bbox as LngLatBoundsLike, { padding: 30 }));
      return tr;
    }),
  );
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

async function selectRide(r: RideStats | null): Promise<void> {
  selected = r?.id ?? null;
  rideFilter = r ? ["==", ["get", P.firstActivity], r.id] : NO_RIDE;
  for (const k of loaded) map.setFilter(`${NEW_GROUP}-${k}`, rideFilter);
  for (const tr of document.querySelectorAll<HTMLElement>("#rides tr")) tr.classList.toggle("selected", tr.dataset.id === selected);
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
  const coords = await loadTrack(r.id);
  if (selected !== r.id || coords.length < 2) return;
  track.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
  const bounds = new maplibregl.LngLatBounds(coords[0], coords[0]);
  for (const c of coords) bounds.extend(c);
  map.fitBounds(bounds, { padding: 40, maxZoom: 15 });
}
$("#ride-clear").addEventListener("click", () => void selectRide(null));

async function start(): Promise<void> {
  try {
    stats = await loadStats();
  } catch (err) {
    $("#status").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  files = edgeFiles(stats);
  renderTotals();
  renderKommuner();
  renderRides();
  $("#generated").textContent = `Data from ${stats.generated.slice(0, 16).replace("T", " ")}`;
  await mapReady;
  setupLayers();
  loadVisible();
  map.on("moveend", loadVisible);
}

void start();
