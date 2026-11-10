// The road under the pointer: hovering shows its details, a click (or a tap, on a phone the only
// way) pins them with a close button and the "Not rideable" switch for that road.

import * as maplibregl from "maplibre-gl";
import type { MapGeoJSONFeature } from "maplibre-gl";
import type { BlockedList } from "./blocked";
import { P, type EdgeHeat, type Stats } from "./data";

interface Deps {
  edgeAt(point: maplibregl.Point): MapGeoJSONFeature | undefined;
  stats(): Stats;
  heat(): EdgeHeat | null;
  /** True while a map click sets a route point. */
  picking(): boolean;
  blocked: BlockedList;
}

export function setupEdgePopup(map: maplibregl.Map, d: Deps): void {
  const hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, maxWidth: "260px", offset: 8 });
  const pinned = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "260px", offset: 8, className: "pinned" });

  const content = (f: MapGeoJSONFeature, at: maplibregl.LngLat, withButton: boolean): HTMLElement => {
    const p = f.properties;
    const id = String(p[P.id]);
    const name = p[P.name] as string | undefined;
    const first = p[P.firstDate] as string | undefined;
    const stats = d.stats();
    const ride = first ? stats.rides.find((r) => r.id === p[P.firstActivity]) : undefined;
    const div = document.createElement("div");
    div.className = "edge-popup";
    const rows: [string, string][] = [
      ["Highway", String(p[P.highway])],
      ["Tier", p[P.countable] === 1 ? "countable" : "bonus"],
      ["Length", `${p[P.length]} m`],
      ["First ridden", first ? `${first}${ride ? ` · ${ride.name}` : ""}` : "not yet"],
    ];
    const surface = p[P.surface];
    if (surface) rows.push(["Surface", surface === "p" ? "paved" : "unpaved"]);
    const heat = d.heat();
    if (heat) {
      const [t, tr, tg, to] = heat[f.source.slice("edges-".length)]?.[id] ?? [0, 0, 0, 0];
      rows.push(["Bike heat", `${t} / 100, busiest of Strava's road, gravel and MTB layers`]);
      rows.push(["Road · gravel · off-road", `${tr} · ${tg} · ${to}`]);
    }
    const src = d.blocked.has(id);
    if (src) rows.push(["Not rideable", src === "file" ? "in blocked.json" : "marked in this browser"]);
    const title = document.createElement("strong");
    title.textContent = name ?? "Unnamed";
    div.append(title);
    for (const [k, v] of rows) {
      const row = document.createElement("div");
      row.innerHTML = `<span></span> <span></span>`;
      row.children[0]!.textContent = k;
      row.children[1]!.textContent = v;
      div.append(row);
    }
    if (withButton) {
      const b = document.createElement("button");
      b.type = "button";
      if (src === "file") {
        b.textContent = "In blocked.json";
        b.disabled = true;
        b.title = "This road is in blocked.json on the site, the list every browser gets. Take it out of that file to make it rideable again.";
      } else if (src === "local") {
        b.textContent = "Rideable again";
        b.title = "Let routes use this road again";
      } else {
        b.textContent = "Not rideable";
        b.title =
          "Keep every route off this road: a gate, steps, a building site. Kept in this browser; Copy as JSON under Not rideable takes the list to blocked.json for every browser. Coverage counts it as before.";
      }
      b.addEventListener("click", () => {
        if (src === "local") d.blocked.remove(id);
        else d.blocked.add({ id, ...(name ? { name } : {}), at: [Number(at.lng.toFixed(5)), Number(at.lat.toFixed(5))] });
        pinned.setDOMContent(content(f, at, true));
      });
      div.append(b);
    }
    return div;
  };

  map.on("mousemove", (e) => {
    if (d.picking() || pinned.isOpen()) {
      hover.remove();
      return;
    }
    const f = d.edgeAt(e.point);
    map.getCanvas().style.cursor = f ? "pointer" : "";
    if (!f) hover.remove();
    else hover.setLngLat(e.lngLat).setDOMContent(content(f, e.lngLat, false)).addTo(map);
  });
  map.on("click", (e) => {
    if (d.picking()) return;
    hover.remove();
    const f = d.edgeAt(e.point);
    if (!f) pinned.remove();
    else pinned.setLngLat(e.lngLat).setDOMContent(content(f, e.lngLat, true)).addTo(map);
  });
  map.getCanvas().addEventListener("mouseleave", () => hover.remove());
}
