// The route's points: a start for every mode, and for A to B an end and any number of vias. Each
// is a draggable marker on the map and a row in the Route section; vias can be moved up a place
// and removed. Picking on the map is one click for the start and the end, and stays on for vias
// until the button is pressed again or Esc, so several can be dropped in a row.

import * as maplibregl from "maplibre-gl";
import type { LonLat, Mode } from "./route";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export type PointKind = "start" | "via" | "end";
export interface Point {
  at: LonLat;
  /** A place name when the point came from the search; coordinates are shown otherwise. */
  label?: string;
}
export type PointChange = "set" | "move" | "remove";

export interface PointsPanel {
  /** The kind the next map click sets, null when a click is a click; main.ts skips its popup while set. */
  readonly picking: PointKind | null;
  readonly start: Point | null;
  readonly end: Point | null;
  readonly via: readonly Point[];
  /** Sets the start or the end, or adds a via at the end of the list. */
  set(kind: PointKind, p: Point): void;
  /** All points at once, from a route link; fires no change. */
  setAll(start: Point, via: Point[], end: Point | null): void;
  setMode(mode: Mode): void;
  onChange(cb: (how: PointChange) => void): void;
}

const coordLabel = (p: LonLat) => `${p[1].toFixed(5)}, ${p[0].toFixed(5)}`;

function markerEl(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `pt ${cls}`;
  el.textContent = text;
  return el;
}

export function setupPoints(map: maplibregl.Map, setStatus: (s: string) => void): PointsPanel {
  let picking: PointKind | null = null;
  let mode: Mode = "loop";
  let start: Point | null = null;
  let end: Point | null = null;
  let via: Point[] = [];
  const listeners: ((how: PointChange) => void)[] = [];
  const fire = (how: PointChange) => {
    render();
    for (const cb of listeners) cb(how);
  };

  const startMarker = new maplibregl.Marker({ element: markerEl("pt-start", ""), draggable: true });
  const endMarker = new maplibregl.Marker({ element: markerEl("pt-end", "B"), draggable: true });
  let viaMarkers: maplibregl.Marker[] = [];
  startMarker.getElement().title = "Start. Drag to move it.";
  endMarker.getElement().title = "End. Drag to move it.";
  const dragged = (m: maplibregl.Marker): LonLat => [m.getLngLat().lng, m.getLngLat().lat];
  startMarker.on("dragend", () => {
    start = { at: dragged(startMarker) };
    fire("move");
  });
  endMarker.on("dragend", () => {
    end = { at: dragged(endMarker) };
    fire("move");
  });

  const pickBtn = $<HTMLButtonElement>("#route-pick");
  const viaBtn = $<HTMLButtonElement>("#route-add-via");
  const endBtn = $<HTMLButtonElement>("#route-pick-end");
  const list = $("#route-points");

  const syncPicking = () => {
    pickBtn.classList.toggle("active", picking === "start");
    viaBtn.classList.toggle("active", picking === "via");
    endBtn.classList.toggle("active", picking === "end");
    map.getCanvas().style.cursor = picking ? "crosshair" : "";
  };
  const togglePick = (k: PointKind) => {
    picking = picking === k ? null : k;
    syncPicking();
  };
  pickBtn.addEventListener("click", () => togglePick("start"));
  viaBtn.addEventListener("click", () => togglePick("via"));
  endBtn.addEventListener("click", () => togglePick("end"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) {
      picking = null;
      syncPicking();
    }
  });
  $("#route-centre").addEventListener("click", () => {
    const c = map.getCenter();
    set("start", { at: [c.lng, c.lat] });
  });
  $("#route-here").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("This browser cannot tell where you are.");
      return;
    }
    setStatus("Finding your position…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at: LonLat = [pos.coords.longitude, pos.coords.latitude];
        set("start", { at, label: "My position" });
        map.flyTo({ center: at, zoom: Math.max(map.getZoom(), 13) });
        setStatus("Start set to your position.");
      },
      (err) => setStatus(`No position: ${err.message || "permission denied"}.`),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
  // main.ts registers its edge click first, so it still sees `picking` set on the click that ends it.
  map.on("click", (e) => {
    if (!picking) return;
    const kind = picking;
    if (kind !== "via") picking = null;
    syncPicking();
    set(kind, { at: [e.lngLat.lng, e.lngLat.lat] });
  });

  function set(kind: PointKind, p: Point): void {
    if (kind === "start") start = p;
    else if (kind === "end") end = p;
    else via = [...via, p];
    fire("set");
  }

  function render(): void {
    const ab = mode === "ab";
    if (start) startMarker.setLngLat(start.at).addTo(map);
    else startMarker.remove();
    startMarker.getElement().textContent = ab ? "A" : "";
    if (ab && end) endMarker.setLngLat(end.at).addTo(map);
    else endMarker.remove();
    for (const m of viaMarkers) m.remove();
    viaMarkers = ab
      ? via.map((p, i) => {
          const m = new maplibregl.Marker({ element: markerEl("pt-via", String(i + 1)), draggable: true }).setLngLat(p.at).addTo(map);
          m.getElement().title = `Via ${i + 1}. Drag to move it.`;
          m.on("dragend", () => {
            via = via.map((v, j) => (j === i ? { at: dragged(m) } : v));
            fire("move");
          });
          return m;
        })
      : [];

    const rows: HTMLElement[] = [];
    const row = (cls: string, badge: string, text: string, buttons: HTMLButtonElement[] = []) => {
      const li = document.createElement("li");
      const b = document.createElement("span");
      b.className = `pt ${cls}`;
      b.textContent = badge;
      const t = document.createElement("span");
      t.className = "pt-label";
      t.textContent = text;
      li.append(b, t, ...buttons);
      rows.push(li);
    };
    const button = (text: string, title: string, onClick: () => void, disabled = false) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.title = title;
      btn.disabled = disabled;
      btn.addEventListener("click", onClick);
      return btn;
    };
    row("pt-start", ab ? "A" : "", start ? (start.label ?? coordLabel(start.at)) : "No start yet: pick one on the map, or use the map centre or your position");
    if (ab) {
      via.forEach((p, i) =>
        row("pt-via", String(i + 1), p.label ?? coordLabel(p.at), [
          button("↑", "Pass this point one place earlier", () => {
            via = via.map((v, j) => (j === i - 1 ? via[i]! : j === i ? via[i - 1]! : v));
            fire("move");
          }, i === 0),
          button("×", "Remove this via point", () => {
            via = via.filter((_, j) => j !== i);
            fire("remove");
          }),
        ]),
      );
      if (end) {
        row("pt-end", "B", end.label ?? coordLabel(end.at), [
          button("×", "Remove the end: the route then comes back to the start", () => {
            end = null;
            fire("remove");
          }),
        ]);
      }
    }
    list.replaceChildren(...rows);
    $("#route-ab").hidden = !ab;
    $("#route-ab-note").hidden = !ab || !!end;
  }

  render();
  return {
    get picking() {
      return picking;
    },
    get start() {
      return start;
    },
    get end() {
      return end;
    },
    get via() {
      return via;
    },
    set,
    setAll(s, v, e) {
      start = s;
      via = v;
      end = e;
      render();
    },
    setMode(m) {
      mode = m;
      if (m !== "ab" && picking !== "start") picking = null;
      syncPicking();
      render();
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
}
