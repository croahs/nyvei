// Place search over Kartverket's open APIs, straight from the browser (both answer with
// Access-Control-Allow-Origin: *, no key): Stedsnavn for place names, and the address register
// once the query has a number in it, since without one it lists every house on a street that
// matches. Results nearest the map centre come first after exact name matches, so "Ålgård"
// finds the one in Gjesdal before the one in Sokndal when the map is on Jæren. Picking a result
// flies there and offers it as the route's start, a via or the end.

import * as maplibregl from "maplibre-gl";
import type { LonLat } from "./route";
import type { PointKind } from "./routepoints";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const PLACES = "https://ws.geonorge.no/stedsnavn/v1/sted";
const ADDRESSES = "https://ws.geonorge.no/adresser/v1/sok";

interface Hit {
  name: string;
  type: string;
  kommune: string;
  at: LonLat;
}

interface PlaceResponse {
  navn?: {
    stedsnavn?: { skrivemåte?: string }[];
    navneobjekttype?: string;
    kommuner?: { kommunenavn?: string }[];
    representasjonspunkt?: { nord?: number; øst?: number };
  }[];
}
interface AddressResponse {
  adresser?: { adressetekst?: string; poststed?: string; kommunenavn?: string; representasjonspunkt?: { lat?: number; lon?: number } }[];
}

/** "SANDNES" → "Sandnes", "NORD-ODAL" → "Nord-Odal": the address register writes kommuner in capitals. */
const title = (s: string) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());

async function places(q: string, signal: AbortSignal): Promise<Hit[]> {
  const url = `${PLACES}?sok=${encodeURIComponent(q)}*&fuzzy=true&treffPerSide=8&utkoordsys=4258`;
  const j = (await (await fetch(url, { signal })).json()) as PlaceResponse;
  return (j.navn ?? []).flatMap((n) => {
    const p = n.representasjonspunkt;
    const name = n.stedsnavn?.[0]?.skrivemåte;
    if (!name || p?.nord === undefined || p.øst === undefined) return [];
    return [{ name, type: n.navneobjekttype ?? "Place", kommune: n.kommuner?.[0]?.kommunenavn ?? "", at: [p.øst, p.nord] as LonLat }];
  });
}

async function addresses(q: string, signal: AbortSignal): Promise<Hit[]> {
  const url = `${ADDRESSES}?sok=${encodeURIComponent(q)}&treffPerSide=5`;
  const j = (await (await fetch(url, { signal })).json()) as AddressResponse;
  return (j.adresser ?? []).flatMap((a) => {
    const p = a.representasjonspunkt;
    if (!a.adressetekst || p?.lat === undefined || p.lon === undefined) return [];
    const town = a.poststed ? title(a.poststed) : "";
    return [{ name: town ? `${a.adressetekst}, ${town}` : a.adressetekst, type: "Address", kommune: title(a.kommunenavn ?? ""), at: [p.lon, p.lat] as LonLat }];
  });
}

export function setupSearch(map: maplibregl.Map, setPoint: (kind: PointKind, at: LonLat, label: string) => void): void {
  const input = $<HTMLInputElement>("#search");
  const list = $("#search-results");
  const marker = new maplibregl.Marker({ color: "#495057", scale: 0.8 });
  let timer = 0;
  let ctrl: AbortController | null = null;

  const clear = () => {
    list.replaceChildren();
    list.hidden = true;
  };

  const choose = (h: Hit) => {
    map.flyTo({ center: h.at, zoom: Math.max(map.getZoom(), 14) });
    marker.setLngLat(h.at).addTo(map);
    const li = row(h, false);
    const actions = document.createElement("div");
    actions.className = "route-row";
    const use = (kind: PointKind, text: string, tip: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = tip;
      b.addEventListener("click", () => {
        setPoint(kind, h.at, h.name);
        marker.remove();
        clear();
        input.value = "";
      });
      actions.append(b);
    };
    use("start", "As start", "Start the route here");
    use("via", "As via", "Pass through here: switches the route to A to B");
    use("end", "As end", "End the route here: switches the route to A to B");
    li.append(actions);
    list.replaceChildren(li);
  };

  function row(h: Hit, clickable: boolean): HTMLLIElement {
    const li = document.createElement("li");
    const name = document.createElement(clickable ? "button" : "strong");
    if (name instanceof HTMLButtonElement) {
      name.type = "button";
      name.className = "link";
      name.title = "Fly there";
      name.addEventListener("click", () => choose(h));
    }
    name.textContent = h.name;
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = [h.type, h.kommune].filter(Boolean).join(" · ");
    li.append(name, " ", meta);
    return li;
  }

  const run = async (q: string) => {
    ctrl?.abort();
    ctrl = new AbortController();
    const signal = ctrl.signal;
    try {
      const [p, a] = await Promise.all([
        places(q, signal).catch((e: unknown) => (signal.aborted ? Promise.reject(e) : [])),
        /\d/.test(q) ? addresses(q, signal).catch((e: unknown) => (signal.aborted ? Promise.reject(e) : [])) : [],
      ]);
      const c = map.getCenter();
      const kx = Math.cos((c.lat * Math.PI) / 180);
      const d = (h: Hit) => ((h.at[0] - c.lng) * kx) ** 2 + (h.at[1] - c.lat) ** 2;
      const exact = (h: Hit) => (h.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1);
      const hits = [...a, ...p].sort((x, y) => exact(x) - exact(y) || d(x) - d(y));
      list.hidden = false;
      if (!hits.length) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "Nothing found.";
        list.replaceChildren(li);
      } else list.replaceChildren(...hits.map((h) => row(h, true)));
    } catch {
      // Aborted by a newer query, or the network: the next keystroke tries again.
    }
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      ctrl?.abort();
      clear();
      return;
    }
    timer = window.setTimeout(() => void run(q), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      clear();
      marker.remove();
    } else if (e.key === "Enter") {
      list.querySelector<HTMLButtonElement>("button.link")?.click();
    }
  });
  clear();
}
