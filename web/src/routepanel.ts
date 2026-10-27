// Route section of the panel: start point, target distance, loop on the map, GPX.

import * as maplibregl from "maplibre-gl";
import type { EdgeFile } from "./data";
import type { Loop, LonLat } from "./route";
import type { Request, Response } from "./route.worker";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const km = (n: number) => n.toFixed(1);

export interface RoutePanel {
  /** True while the next map click sets the start, so main.ts skips its edge popup. */
  readonly picking: boolean;
}

export function setupRoute(map: maplibregl.Map, files: EdgeFile[]): RoutePanel {
  const worker = new Worker(new URL("./route.worker.ts", import.meta.url), { type: "module" });
  const send = (r: Request) => worker.postMessage(r);
  send({ type: "load", urls: files.map((f) => new URL(f.url, location.href).href) });

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
  const marker = new maplibregl.Marker({ color: "#1c7ed6" });

  let ready = false;
  let picking = false;
  let start: LonLat | null = null;
  let variant = 0;
  let requestId = 0;
  let sentAt = 0;
  let loop: Loop | null = null;

  const pick = $<HTMLButtonElement>("#route-pick");
  const go = $<HTMLButtonElement>("#route-go");
  const next = $<HTMLButtonElement>("#route-next");
  const gpx = $<HTMLButtonElement>("#route-gpx");
  const kmInput = $<HTMLInputElement>("#route-km");
  const status = $("#route-status");
  const result = $("#route-result");

  const sync = () => {
    go.disabled = !ready || !start;
    next.disabled = !ready || !loop;
    gpx.disabled = !loop;
    pick.classList.toggle("active", picking);
    map.getCanvas().style.cursor = picking ? "crosshair" : "";
  };

  const setStart = (p: LonLat) => {
    start = p;
    picking = false;
    variant = 0;
    marker.setLngLat(p).addTo(map);
    $("#route-start").textContent = `Start ${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;
    sync();
  };

  const generate = () => {
    if (!start || !ready) return;
    const target = Number(kmInput.value);
    if (!(target > 0)) return;
    sentAt = performance.now();
    status.textContent = "Generating…";
    send({ type: "loop", id: ++requestId, start, km: target, variant });
  };

  pick.addEventListener("click", () => {
    picking = !picking;
    sync();
  });
  $("#route-centre").addEventListener("click", () => {
    const c = map.getCenter();
    setStart([c.lng, c.lat]);
  });
  map.on("click", (e) => {
    if (!picking) return;
    setStart([e.lngLat.lng, e.lngLat.lat]);
  });
  kmInput.addEventListener("change", () => (variant = 0));
  go.addEventListener("click", () => {
    variant = 0;
    generate();
  });
  next.addEventListener("click", () => {
    variant++;
    generate();
  });
  gpx.addEventListener("click", () => {
    if (loop) download(loop);
  });

  worker.onmessage = (e: MessageEvent<Response>) => {
    const m = e.data;
    if (m.type === "progress") status.textContent = `Building route graph, ${m.done} of ${m.of} files…`;
    else if (m.type === "ready") {
      ready = true;
      status.textContent = `Route graph ready: ${m.edges.toLocaleString("en")} edges in ${(m.ms / 1000).toFixed(1)} s`;
    } else if (m.type === "error") {
      if (m.id === undefined || m.id === requestId) status.textContent = m.message;
    } else if (m.id === requestId) {
      loop = m.loop;
      showLoop(m.loop, performance.now() - sentAt, m.ms);
    }
    sync();
  };

  function showLoop(l: Loop, roundTrip: number, compute: number): void {
    map.getSource<maplibregl.GeoJSONSource>("route")!.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: l.coords },
    });
    const bounds = new maplibregl.LngLatBounds(l.coords[0], l.coords[0]);
    for (const c of l.coords) bounds.extend(c);
    map.fitBounds(bounds, { padding: 40, maxZoom: 15 });
    const rows: [string, string][] = [
      ["Loop", `${km(l.totalKm)} km`],
      ["Unridden roads", `${km(l.unriddenCountableKm)} km, ${Math.round(l.share * 100)} % of the loop`],
      ["Unridden tracks and paths", `${km(l.unriddenBonusKm)} km`],
    ];
    result.replaceChildren(
      ...rows.map(([k, v]) => {
        const div = document.createElement("div");
        div.innerHTML = `<span class="muted"></span> <span></span>`;
        div.children[0]!.textContent = k;
        div.children[1]!.textContent = v;
        return div;
      }),
    );
    status.textContent = `Cluster ${l.clusterRank + 1} of ${l.clustersInReach} in reach (${km(l.clusterKm)} km unridden) · ${Math.round(
      roundTrip,
    )} ms (${Math.round(compute)} ms routing)`;
  }

  sync();
  return {
    get picking() {
      return picking;
    },
  };
}

/** GPX 1.1 track of the loop, saved through a temporary link. */
function download(l: Loop): void {
  const name = `nyvei ${Math.round(l.totalKm)} km loop`;
  const pts = l.coords.map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(5)}" lon="${lon.toFixed(5)}"/>`).join("\n");
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
  a.download = `nyvei-loop-${Math.round(l.totalKm)}km-${new Date().toISOString().slice(0, 10)}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
