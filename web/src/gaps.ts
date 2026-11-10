// Gaps section: the short unridden stretches (route.ts, findGaps) that sit next to roads already
// ridden, the cheapest coverage there is. The total under the route's switches, and the ones
// nearest the map centre, refreshed while the section is open and the map comes to rest. While it
// is open the listed gaps glow magenta on the map, under the roads: gaps touch ridden roads, and a warm glow would
// vanish into their orange.

import type * as maplibregl from "maplibre-gl";
import { group } from "./chart";
import type { EdgeOptions } from "./route";
import type { Router } from "./router";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const LIMIT = 20;

function distance(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m away` : `${(m / 1000).toFixed(1)} km away`;
}

/** `below` is the layer the highlight goes under, so the road itself stays visible on top of it. */
export function setupGaps(map: maplibregl.Map, router: Router, below: string, edgeOptions: () => EdgeOptions): { refresh(): void } {
  const section = $<HTMLDetailsElement>("#gaps-section");
  const list = $("#gaps-list");
  const total = $("#gaps-total");
  const statusEl = $("#gaps-status");
  map.addSource("gaps", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer(
    {
      id: "gaps",
      type: "line",
      source: "gaps",
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: {
        "line-color": "#e64980",
        "line-opacity": 0.55,
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 12, 9, 16, 18],
      },
    },
    below,
  );

  let asked = 0;
  const refresh = async () => {
    if (!section.open) return;
    const id = ++asked;
    const c = map.getCenter();
    statusEl.textContent = "Finding gaps…";
    try {
      const { gaps } = await router.gaps([c.lng, c.lat], LIMIT, edgeOptions());
      if (id !== asked) return;
      total.textContent = `· ${group(gaps.count)} gaps, ${group(gaps.totalKm)} km`;
      statusEl.textContent = gaps.gaps.length ? `The ${gaps.gaps.length} nearest the map centre:` : "No gaps under these route options.";
      map.getSource<maplibregl.GeoJSONSource>("gaps")!.setData({
        type: "FeatureCollection",
        features: gaps.gaps.map((g) => ({ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: g.coords } })),
      });
      list.replaceChildren(
        ...gaps.gaps.map((g) => {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          b.className = "link";
          b.textContent = `${Math.round(g.m)} m${g.edges > 1 ? ` in ${g.edges} stretches` : ""}`;
          b.title = "Show this gap on the map";
          b.addEventListener("click", () => map.flyTo({ center: g.at, zoom: Math.max(map.getZoom(), 16) }));
          const d = document.createElement("span");
          d.className = "muted";
          d.textContent = distance(g.distM);
          li.append(b, d);
          return li;
        }),
      );
    } catch (err) {
      if (id === asked) statusEl.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  section.addEventListener("toggle", () => {
    map.setLayoutProperty("gaps", "visibility", section.open ? "visible" : "none");
    void refresh();
  });
  map.on("moveend", () => void refresh());
  return { refresh: () => void refresh() };
}
