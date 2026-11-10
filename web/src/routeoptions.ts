// The route's switches, folded under "Options" in the Route section so the common path (start,
// mode, Generate) stays short. Remembered per browser; a switch the graph cannot honour (no
// surface tags, no elevations, no heat) is hidden and sent as off, whatever was remembered.

import type { HeatMode, Mode, EdgeOptions } from "./route";
import type { Ready } from "./router";
import { loadJson, saveJson } from "./storage";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export interface Switches {
  roadsOnly: boolean;
  skipDead: boolean;
  heatK: number;
  heatMode: HeatMode;
  pavedOnly: boolean;
  avoidMain: boolean;
  avoidSteep: boolean;
  gapsOnly: boolean;
}

/** Everything the Route section remembers: the switches, and the last mode and distance. */
export interface Prefs extends Switches {
  mode: Mode;
  km: number;
}
const DEFAULTS: Prefs = {
  mode: "loop",
  km: 40,
  roadsOnly: false,
  skipDead: true,
  heatK: 0.7,
  heatMode: "road",
  pavedOnly: false,
  avoidMain: true,
  avoidSteep: false,
  gapsOnly: false,
};
const KEY = "nyvei.route";

const MODES: Mode[] = ["loop", "sweep", "loopsweep", "ab"];
const HEAT_MODES: HeatMode[] = ["road", "gravel", "offroad"];

/** Remembered prefs, each field checked, so a stale or hand-edited entry falls back field by field. */
function load(): Prefs {
  const s = loadJson<Partial<Prefs>>(KEY, {});
  const p = { ...DEFAULTS };
  for (const k of ["roadsOnly", "skipDead", "pavedOnly", "avoidMain", "avoidSteep", "gapsOnly"] as const) {
    if (typeof s[k] === "boolean") p[k] = s[k];
  }
  if (typeof s.heatK === "number" && s.heatK >= 0 && s.heatK <= 0.9) p.heatK = s.heatK;
  if (s.heatMode && HEAT_MODES.includes(s.heatMode)) p.heatMode = s.heatMode;
  if (s.mode && MODES.includes(s.mode)) p.mode = s.mode;
  if (typeof s.km === "number" && s.km > 0) p.km = s.km;
  return p;
}

export interface OptionsPanel {
  readonly prefs: Prefs;
  /** Remembers the mode and distance next to the switches. */
  remember(mode: Mode, km: number): void;
  /** The switches as the route should get them: hidden ones off, "only gaps" only in a sweep. */
  values(mode: Mode): Switches;
  edgeOptions(): EdgeOptions;
  /** Shows the switches the graph can honour, once it is built. */
  setCaps(r: Ready): void;
  setMode(mode: Mode): void;
  /** Sets switches from a route link without remembering them. */
  apply(s: Partial<Switches>): void;
  onChange(cb: () => void): void;
}

export function setupOptions(): OptionsPanel {
  const prefs = load();
  let caps = { hasHeat: false, hasDead: false, hasSurface: false, hasElev: false };
  let mode = prefs.mode;
  const listeners: (() => void)[] = [];

  const boxes = {
    avoidMain: $<HTMLInputElement>("#route-main"),
    roadsOnly: $<HTMLInputElement>("#route-roads"),
    pavedOnly: $<HTMLInputElement>("#route-paved"),
    avoidSteep: $<HTMLInputElement>("#route-steep"),
    skipDead: $<HTMLInputElement>("#route-dead"),
    gapsOnly: $<HTMLInputElement>("#route-gaps"),
  };
  const heatK = $<HTMLInputElement>("#route-heat");
  const heatMode = $<HTMLSelectElement>("#route-heat-mode");
  const heatVal = $("#route-heat-val");
  const summary = $("#route-opts-sum");

  const showHeatK = () => (heatVal.textContent = Number(heatK.value) ? `${Math.round(Number(heatK.value) * 100)} %` : "off");
  const fill = (s: Switches) => {
    for (const [k, box] of Object.entries(boxes)) box.checked = s[k as keyof typeof boxes];
    heatK.value = String(s.heatK);
    heatMode.value = s.heatMode;
    showHeatK();
  };
  const read = (): Switches => ({
    avoidMain: boxes.avoidMain.checked,
    roadsOnly: boxes.roadsOnly.checked,
    pavedOnly: boxes.pavedOnly.checked,
    avoidSteep: boxes.avoidSteep.checked,
    skipDead: boxes.skipDead.checked,
    gapsOnly: boxes.gapsOnly.checked,
    heatK: Number(heatK.value),
    heatMode: heatMode.value as HeatMode,
  });
  const values = (m: Mode): Switches => {
    const s = read();
    return {
      ...s,
      pavedOnly: caps.hasSurface && s.pavedOnly,
      avoidSteep: caps.hasElev && s.avoidSteep,
      skipDead: caps.hasDead && s.skipDead,
      heatK: caps.hasHeat ? s.heatK : 0,
      gapsOnly: m === "sweep" && s.gapsOnly,
    };
  };

  // The folded summary says what is on, so nothing hidden under "Options" surprises.
  const sync = () => {
    $("#route-paved-row").hidden = !caps.hasSurface;
    $("#route-steep-row").hidden = !caps.hasElev;
    $("#route-dead-row").hidden = !caps.hasDead;
    $("#route-heat-row").hidden = !caps.hasHeat;
    $("#route-gaps-row").hidden = mode !== "sweep";
    const v = values(mode);
    const on = [
      v.avoidMain && "no main roads",
      v.roadsOnly && "roads only",
      v.pavedOnly && "paved",
      v.avoidSteep && "not steep",
      v.skipDead && "skip dead",
      v.gapsOnly && "gaps only",
      v.heatK > 0 && `${Math.round(v.heatK * 100)} % ${v.heatMode === "offroad" ? "off-road" : v.heatMode} heat`,
    ].filter(Boolean);
    summary.textContent = on.length ? `· ${on.join(", ")}` : "· none";
  };

  const changed = () => {
    Object.assign(prefs, read());
    saveJson(KEY, prefs);
    sync();
    for (const cb of listeners) cb();
  };
  for (const box of Object.values(boxes)) box.addEventListener("change", changed);
  heatK.addEventListener("input", showHeatK);
  heatK.addEventListener("change", changed);
  heatMode.addEventListener("change", changed);

  fill(prefs);
  sync();

  return {
    prefs,
    remember(m, km) {
      prefs.mode = m;
      prefs.km = km;
      saveJson(KEY, prefs);
    },
    values,
    edgeOptions() {
      const v = values(mode);
      return { roadsOnly: v.roadsOnly, skipDead: v.skipDead, heatMode: v.heatMode, pavedOnly: v.pavedOnly, avoidMain: v.avoidMain };
    },
    setCaps(r) {
      caps = { hasHeat: r.hasHeat, hasDead: r.hasDead, hasSurface: r.hasSurface, hasElev: r.hasElev };
      sync();
    },
    setMode(m) {
      mode = m;
      sync();
    },
    apply(s) {
      fill({ ...read(), ...s });
      sync();
    },
    onChange(cb) {
      listeners.push(cb);
    },
  };
}
