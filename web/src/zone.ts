// Dev-only page (http://localhost:5173/zone.html, not part of the build) for
// picking PRIVACY_ZONE: click home, choose a radius, copy the .env line. Ride
// start and end points are drawn so the circle can be sized to cover them.
// Nothing leaves the browser.

import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { loadStats, loadTrack } from "./data";

maplibregl.setWorkerUrl(workerUrl);

type LonLat = [number, number];
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const radiusInput = $<HTMLInputElement>("#radius");
let centre: LonLat | null = null;
let ends: LonLat[] = [];

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  center: [5.735, 58.852],
  zoom: 12,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.ScaleControl(), "bottom-left");

function metres(a: LonLat, b: LonLat): number {
  const kx = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 111320);
}

function circle(c: LonLat, r: number): LonLat[] {
  const kx = 111320 * Math.cos((c[1] * Math.PI) / 180);
  return Array.from({ length: 65 }, (_, i) => {
    const t = (i / 64) * 2 * Math.PI;
    return [c[0] + (r * Math.sin(t)) / kx, c[1] + (r * Math.cos(t)) / 111320] as LonLat;
  });
}

function render(): void {
  if (!centre) return;
  const r = Math.max(1, Number(radiusInput.value) || 100);
  map.getSource<maplibregl.GeoJSONSource>("zone")!.setData({
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [circle(centre, r)] },
  });
  const text = `PRIVACY_ZONE=${centre[1].toFixed(5)},${centre[0].toFixed(5)},${r}`;
  $("#line").textContent = text;
  $("#line").hidden = false;
  $("#copy").hidden = false;
  $("#hint").textContent = "Click again to move it.";
  const inside = ends.filter((p) => metres(p, centre!) <= r).length;
  $("#inside").textContent = ends.length ? `${inside} of ${ends.length} ride starts and ends are inside the circle` : "";
}

map.on("load", async () => {
  map.addSource("zone", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "zone-fill", type: "fill", source: "zone", paint: { "fill-color": "#e8590c", "fill-opacity": 0.2 } });
  map.addLayer({ id: "zone-line", type: "line", source: "zone", paint: { "line-color": "#e8590c", "line-width": 2 } });
  map.addSource("ends", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "ends",
    type: "circle",
    source: "ends",
    paint: { "circle-radius": 3, "circle-color": "#1c7ed6", "circle-opacity": 0.6 },
  });

  // Ride start and end points, from the tracks the site already has.
  try {
    const stats = await loadStats();
    const tracks = await Promise.all(stats.rides.map((r) => loadTrack(r.id).catch(() => [])));
    ends = tracks.flatMap((segments) => {
      const pts = segments.flat();
      return pts.length ? [pts[0]!, pts[pts.length - 1]!] : [];
    });
    map.getSource<maplibregl.GeoJSONSource>("ends")!.setData({
      type: "FeatureCollection",
      features: ends.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } })),
    });
    render();
  } catch {
    $("#inside").textContent = "No ride data found; run pnpm match first to see ride starts and ends.";
  }
});

map.on("click", (e) => {
  centre = [e.lngLat.lng, e.lngLat.lat];
  render();
});
radiusInput.addEventListener("input", render);
$("#copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#line").textContent ?? "");
  $("#copy").textContent = "Copied";
  setTimeout(() => ($("#copy").textContent = "Copy"), 1500);
});
