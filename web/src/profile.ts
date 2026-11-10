// Elevation profile of the route under its summary: one series (height over distance), so no
// legend; the ascent and steep km rows above it are its text. Hovering or scrubbing it shows the
// distance and height there and puts a dot on that spot of the route on the map.

import * as maplibregl from "maplibre-gl";
import { niceStep, svg, tooltip } from "./chart";
import type { LonLat, Route } from "./route";

const COLOR = "#1c7ed6";
const H = 64;
const TOP = 6;
const AXIS = 16;
const LEFT = 36;
const RIGHT = 8;

/** Cumulative metres along a line, by the same flat-earth metres route.ts uses. */
function along(coords: LonLat[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const kx = Math.cos(((a[1] + b[1]) * Math.PI) / 360);
    const dx = (b[0] - a[0]) * kx;
    const dy = b[1] - a[1];
    out.push(out[i - 1]! + Math.sqrt(dx * dx + dy * dy) * 111_195);
  }
  return out;
}

/** Index of the last element of sorted `xs` at or below x. */
function below(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function setupProfile(map: maplibregl.Map, host: HTMLElement): (route: Route | null) => void {
  const dotEl = document.createElement("div");
  dotEl.className = "profile-dot";
  const dot = new maplibregl.Marker({ element: dotEl });
  let current: Route | null = null;

  const draw = () => {
    host.replaceChildren();
    dot.remove();
    const r = current;
    if (!r?.profile || r.profile.length < 2) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const prof = r.profile;
    const W = host.clientWidth || 340;
    const pw = W - LEFT - RIGHT;
    const totalKm = Math.max(r.totalKm, prof[prof.length - 1]![0]);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, z] of prof) {
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    // At least 40 m of height, so a flat ride does not draw as a mountain range.
    const pad = Math.max(0, 40 - (hi - lo)) / 2;
    const ys = niceStep(hi - lo + 2 * pad, 2);
    const y0 = Math.floor((lo - pad) / ys) * ys;
    const y1 = Math.ceil((hi + pad) / ys) * ys;
    const X = (km: number) => LEFT + (km / totalKm) * pw;
    const Y = (z: number) => TOP + H - ((z - y0) / (y1 - y0)) * H;

    const el = svg("svg", { width: W, height: TOP + H + AXIS, viewBox: `0 0 ${W} ${TOP + H + AXIS}`, class: "chart", tabindex: 0, role: "img" });
    el.setAttribute("aria-label", `Elevation profile, ${Math.round(lo)} to ${Math.round(hi)} m over ${totalKm.toFixed(1)} km`);
    for (let z = y0; z <= y1 + 1e-9; z += ys) {
      el.append(svg("line", { x1: LEFT, x2: W - RIGHT, y1: Y(z), y2: Y(z), class: z === y0 ? "axis" : "grid" }));
      el.append(svg("text", { x: LEFT - 4, y: Y(z) + 4, "text-anchor": "end", class: "tick" }, `${Math.round(z)} m`));
    }
    const xs = niceStep(totalKm, 4);
    for (let km = 0; km <= totalKm + 1e-9; km += xs) {
      const last = km + xs > totalKm + 1e-9;
      el.append(svg("text", { x: X(km), y: TOP + H + 13, "text-anchor": km === 0 ? "start" : last && X(km) > W - 30 ? "end" : "middle", class: "tick" }, last ? `${Math.round(km)} km` : String(Math.round(km))));
    }
    const line = prof.map(([km, z], i) => `${i ? "L" : "M"}${X(km).toFixed(1)},${Y(z).toFixed(1)}`).join("");
    el.append(svg("path", { d: `${line}L${X(prof[prof.length - 1]![0]).toFixed(1)},${Y(y0)}L${X(prof[0]![0]).toFixed(1)},${Y(y0)}Z`, fill: COLOR, "fill-opacity": 0.1 }));
    el.append(svg("path", { d: line, fill: "none", stroke: COLOR, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

    const cross = svg("line", { y1: TOP, y2: TOP + H, class: "crosshair", visibility: "hidden" });
    const mark = svg("circle", { r: 4, fill: COLOR, stroke: "#fff", "stroke-width": 2, visibility: "hidden" });
    const hit = svg("rect", { x: LEFT, y: 0, width: pw, height: TOP + H + AXIS, fill: "transparent" });
    el.append(cross, mark, hit);
    host.append(el);
    const tip = tooltip(host);

    const kmPts = prof.map((p) => p[0]);
    const cum = along(r.coords);
    // The profile's km run along edge lengths, the line's along its vertices; scale one onto the other.
    const scale = cum[cum.length - 1]! / 1000 / totalKm || 1;
    let at = -1;
    const show = (i: number) => {
      at = Math.max(0, Math.min(prof.length - 1, i));
      const [km, z] = prof[at]!;
      const x = X(km);
      cross.setAttribute("x1", String(x));
      cross.setAttribute("x2", String(x));
      cross.setAttribute("visibility", "visible");
      mark.setAttribute("cx", String(x));
      mark.setAttribute("cy", String(Y(z)));
      mark.setAttribute("visibility", "visible");
      tip.show(x, [[`${Math.round(z)} m`, `at ${km.toFixed(1)} km`]]);
      const m = km * scale * 1000;
      const j = below(cum, m);
      const a = r.coords[j]!;
      const b = r.coords[Math.min(j + 1, r.coords.length - 1)]!;
      const t = cum[j + 1] !== undefined && cum[j + 1]! > cum[j]! ? (m - cum[j]!) / (cum[j + 1]! - cum[j]!) : 0;
      dot.setLngLat([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]).addTo(map);
    };
    const hide = () => {
      at = -1;
      cross.setAttribute("visibility", "hidden");
      mark.setAttribute("visibility", "hidden");
      tip.hide();
      dot.remove();
    };
    hit.addEventListener("pointermove", (e) => {
      const box = el.getBoundingClientRect();
      const km = ((e.clientX - box.left - LEFT) / pw) * totalKm;
      const i = below(kmPts, km);
      // Snap to whichever neighbour is nearer.
      show(i + 1 < kmPts.length && kmPts[i + 1]! - km < km - kmPts[i]! ? i + 1 : i);
    });
    hit.addEventListener("pointerleave", hide);
    el.addEventListener("blur", hide);
    el.addEventListener("keydown", (e) => {
      const step = Math.max(1, Math.round(prof.length / 50));
      if (e.key === "ArrowRight") show(at < 0 ? 0 : at + step);
      else if (e.key === "ArrowLeft") show(at < 0 ? prof.length - 1 : at - step);
      else return;
      e.preventDefault();
    });
  };

  // Redraw at the new width when the panel changes size (phone rotation, window resize).
  let lastW = 0;
  new ResizeObserver(() => {
    if (host.clientWidth && host.clientWidth !== lastW && current) {
      lastW = host.clientWidth;
      draw();
    }
  }).observe(host);

  return (route) => {
    current = route;
    draw();
  };
}
