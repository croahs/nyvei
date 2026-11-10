// The route in the address, so a link reopens it on another device once the graph is built:
//   ?route=ab&start=58.85200,5.73500&via=58.80000,5.70000&end=58.73500,5.64800&opts=main,dead&prefer=road:70&try=1
// route is the mode; points are lat,lon (the order map apps paste), vias separated by ";"; km is
// left out for A to B, which ignores it; opts lists the switches that are on ("none" for none);
// prefer is the bike heat mode and pull in percent; try is "Try another"'s variant, left out at 0.
// The same graph and data give the same route; after a new `pnpm match` it may differ.

import type { HeatMode, LonLat, Mode } from "./route";
import type { Switches } from "./routeoptions";
import { param, setParams } from "./url";

export interface RouteLink {
  mode: Mode;
  start: LonLat;
  end: LonLat | null;
  via: LonLat[];
  km: number | null;
  variant: number;
  switches: Partial<Switches>;
}

const MODES: Mode[] = ["loop", "sweep", "loopsweep", "ab"];
const HEAT_MODES: HeatMode[] = ["road", "gravel", "offroad"];
/** URL names of the boolean switches. */
const OPTS: [string, keyof Switches][] = [
  ["main", "avoidMain"],
  ["roads", "roadsOnly"],
  ["paved", "pavedOnly"],
  ["steep", "avoidSteep"],
  ["dead", "skipDead"],
  ["gaps", "gapsOnly"],
];
const PARAMS = ["route", "start", "via", "end", "km", "opts", "prefer", "try"];

const fmt = (p: LonLat) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;
function parsePoint(s: string): LonLat | null {
  const [lat, lon] = s.split(",").map(Number);
  return lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    ? [lon, lat]
    : null;
}

export function writeRouteLink(l: Omit<RouteLink, "switches">, s: Switches): void {
  setParams({
    route: l.mode,
    start: fmt(l.start),
    via: l.mode === "ab" && l.via.length ? l.via.map(fmt).join(";") : null,
    end: l.mode === "ab" && l.end ? fmt(l.end) : null,
    km: l.mode === "ab" || l.km === null ? null : String(l.km),
    opts: OPTS.filter(([, k]) => s[k]).map(([n]) => n).join(",") || "none",
    prefer: `${s.heatMode}:${Math.round(s.heatK * 100)}`,
    try: l.variant ? String(l.variant) : null,
  });
}

export function clearRouteLink(): void {
  setParams(Object.fromEntries(PARAMS.map((p) => [p, null])));
}

/** The route in the address, or null when there is none or it does not parse. */
export function readRouteLink(): RouteLink | null {
  const mode = param("route") as Mode | null;
  const start = parsePoint(param("start") ?? "");
  if (!mode || !MODES.includes(mode) || !start) return null;
  const via = (param("via") ?? "")
    .split(";")
    .filter(Boolean)
    .map(parsePoint)
    .filter((p): p is LonLat => p !== null);
  const end = parsePoint(param("end") ?? "");
  const km = Number(param("km"));
  const switches: Partial<Switches> = {};
  const opts = param("opts");
  if (opts !== null) {
    const on = new Set(opts.split(","));
    for (const [n, k] of OPTS) (switches as Record<string, boolean>)[k] = on.has(n);
  }
  const [hm, pull] = (param("prefer") ?? "").split(":");
  if (hm && HEAT_MODES.includes(hm as HeatMode)) switches.heatMode = hm as HeatMode;
  const k = Number(pull);
  if (pull !== undefined && Number.isFinite(k)) switches.heatK = Math.min(0.9, Math.max(0, k / 100));
  const variant = Math.max(0, Math.floor(Number(param("try")) || 0));
  return { mode, start, end, via, km: km > 0 ? km : null, variant, switches };
}
