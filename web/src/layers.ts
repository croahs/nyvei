// Map section of the panel, merged in from gravelheater: raster base maps over
// the Positron style, the road, gravel and offroad heat overlays from pnpm heat:tiles,
// and the switch that colours unridden edges by their bike heat. Every layer
// here sits below the edge groups, so `below` is the lowest edge anchor.

import type * as maplibregl from "maplibre-gl";
import { heatUrl, type HeatMeta } from "./data";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const KV = (layer: string) => `https://cache.kartverket.no/v1/wmts/1.0.0/${layer}/default/webmercator/{z}/{y}/{x}.png`; // note z/y/x
interface Basemap {
  label: string;
  url?: string;
  attribution?: string;
}
const BASEMAPS: Record<string, Basemap> = {
  positron: { label: "Positron (OpenFreeMap)" },
  topograatone: { label: "Kartverket topo (gråtone)", url: KV("topograatone"), attribution: "© Kartverket" },
  topo: { label: "Kartverket topo", url: KV("topo"), attribution: "© Kartverket" },
  osm: { label: "OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap" },
  opentopo: {
    label: "OpenTopoMap",
    url: "https://tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap, SRTM | © OpenTopoMap (CC-BY-SA)",
  },
};
const LABELS: Record<string, string> = { road: "Road (Ride)", gravel: "Gravel (gravel − road)", offroad: "Off-road (mtb + gravel − road)" };
const TITLES: Record<string, string> = {
  road: "Strava's road ride heatmap as it is: where road cyclists ride, brighter where more do.",
  gravel: "Where gravel riders ride more than road riders: Strava's gravel heat minus its road heat, pixel by pixel. A road everyone rides cancels out.",
  offroad: "Where gravel and MTB riders together ride more than road riders, where gravel alone is too weak to show. Mostly trails and forest tracks.",
};

/** Per-viewer choices; storage can be missing or throw, and then defaults apply. */
interface Saved {
  basemap: string;
  heatOpacity: number;
  off: string[];
  edgeHeat: boolean;
}
const KEY = "nyvei.layers";
function load(): Saved {
  // Road heat covers nearly every road, so it starts hidden.
  const d: Saved = { basemap: "positron", heatOpacity: 0.8, off: ["road"], edgeHeat: false };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>) };
  } catch {
    return d;
  }
}
function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private window or blocked storage: the choice lasts for this page only.
  }
}

/** `meta` is the heat overlay's, null without overlays; `hasEdgeHeat` whether edge heat loaded. */
export function setupMapSection(
  map: maplibregl.Map,
  below: string,
  meta: HeatMeta | null,
  hasEdgeHeat: boolean,
  setEdgeHeat: (on: boolean) => void,
): void {
  const saved = load();
  if (!BASEMAPS[saved.basemap]) saved.basemap = "positron";

  // Base map: Positron is the style itself; a raster choice covers it, under everything nyvei draws.
  const select = $<HTMLSelectElement>("#basemap");
  select.replaceChildren(
    ...Object.entries(BASEMAPS).map(([id, b]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = b.label;
      return o;
    }),
  );
  const applyBasemap = (id: string) => {
    if (map.getLayer("basemap")) map.removeLayer("basemap");
    if (map.getSource("basemap")) map.removeSource("basemap");
    const b = BASEMAPS[id]!;
    if (!b.url) return;
    map.addSource("basemap", { type: "raster", tileSize: 256, maxzoom: 19, tiles: [b.url], attribution: b.attribution });
    // Above the heat overlays would hide them, so insert below the first of those when present.
    const heatBelow = map.getStyle().layers.find((l) => l.id.startsWith("heat-"))?.id ?? below;
    map.addLayer({ id: "basemap", type: "raster", source: "basemap" }, heatBelow);
  };
  select.value = saved.basemap;
  applyBasemap(saved.basemap);
  select.addEventListener("change", () => {
    saved.basemap = select.value;
    applyBasemap(select.value);
    save(saved);
  });

  // Bike heat on the edges: only when the heat project has edges.json.
  const edgeHeat = $<HTMLInputElement>("#edge-heat");
  $("#edge-heat-row").hidden = !hasEdgeHeat;
  edgeHeat.checked = hasEdgeHeat && saved.edgeHeat;
  const applyEdgeHeat = () => {
    $("#edge-heat-legend").hidden = !edgeHeat.checked;
    setEdgeHeat(edgeHeat.checked);
  };
  applyEdgeHeat();
  edgeHeat.addEventListener("change", () => {
    saved.edgeHeat = edgeHeat.checked;
    applyEdgeHeat();
    save(saved);
  });

  // Heat overlays: only when the heat project has tiles (pnpm heat:tiles, pnpm heat:pages).
  const box = $("#heat-overlays");
  if (!meta || !meta.layers.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const layer of meta.layers) {
    const id = `heat-${layer}`;
    map.addSource(id, {
      type: "raster",
      tileSize: 512,
      minzoom: meta.minzoom,
      maxzoom: meta.layerMaxzoom?.[layer] ?? meta.maxzoom,
      bounds: meta.bbox,
      tiles: [heatUrl(`${layer}/{z}/{x}/{y}.png`)],
      attribution: "Heat © Strava",
    });
    map.addLayer(
      {
        id,
        type: "raster",
        source: id,
        layout: { visibility: saved.off.includes(layer) ? "none" : "visible" },
        paint: { "raster-opacity": saved.heatOpacity, "raster-resampling": "nearest" },
      },
      below,
    );
  }
  // Tiles are sparse, so missing ones are expected; keep them out of the console noise.
  map.on("error", (e) => {
    const src = (e as unknown as { sourceId?: string }).sourceId;
    if (src?.startsWith("heat-")) return;
    console.error(e.error);
  });

  const opacity = $<HTMLInputElement>("#heat-opacity");
  opacity.value = String(saved.heatOpacity);
  opacity.addEventListener("input", () => {
    saved.heatOpacity = Number(opacity.value);
    for (const layer of meta.layers) map.setPaintProperty(`heat-${layer}`, "raster-opacity", saved.heatOpacity);
    save(saved);
  });
  $("#heat-toggles").replaceChildren(
    ...meta.layers.map((layer) => {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" /> <i></i><span></span>`;
      const input = label.querySelector("input")!;
      input.checked = !saved.off.includes(layer);
      label.querySelector("i")!.style.setProperty("--c", meta.colors[layer] ?? "#888");
      label.querySelector("span")!.textContent = LABELS[layer] ?? layer;
      if (TITLES[layer]) label.title = TITLES[layer];
      input.addEventListener("change", () => {
        map.setLayoutProperty(`heat-${layer}`, "visibility", input.checked ? "visible" : "none");
        saved.off = input.checked ? saved.off.filter((l) => l !== layer) : [...saved.off, layer];
        save(saved);
      });
      return label;
    }),
  );
}
