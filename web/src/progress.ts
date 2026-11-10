// Progress section: stats.timeline as two charts on one month axis, never one chart with two
// scales: coverage percent over time (a line), and the new km each month (columns, road km and
// track km stacked in the map's ridden colours). One crosshair runs through both and its tooltip
// lists every value of that month; a table under them holds the same numbers.

import type { MonthStats, Stats } from "./data";
import { niceStep, svg, tooltip } from "./chart";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const ROAD = "#e8590c";
const TRACK = "#8b3fd9";
const LEFT = 34;
const RIGHT = 46;
const A_TOP = 8;
const A_H = 90;
const B_TOP = A_TOP + A_H + 30;
const B_H = 56;
const HEIGHT = B_TOP + B_H + 18;

const monthLabel = (m: string, style: "short" | "long" = "short") =>
  new Date(`${m}-01T12:00:00`).toLocaleString("en", { month: style, year: "numeric" });

/** A column from the baseline up, its top corners rounded unless something sits on it. */
function column(x: number, w: number, y: number, h: number, round: boolean): string {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}${r ? `Q${x},${y} ${x + r},${y}` : ""}H${x + w - r}${r ? `Q${x + w},${y} ${x + w},${y + r}` : ""}V${y + h}Z`;
}

export function setupProgress(stats: Stats): void {
  const section = $<HTMLDetailsElement>("#progress-section");
  const host = $("#progress");
  const tl: MonthStats[] = stats.timeline ?? [];
  if (!tl.length) {
    host.textContent = "No timeline in stats.json yet; the next pnpm match writes it.";
    return;
  }
  let lastW = 0;
  const draw = () => {
    const W = host.clientWidth;
    if (!W || W === lastW) return;
    lastW = W;
    host.replaceChildren();
    const n = tl.length;
    const pw = W - LEFT - RIGHT;
    const band = pw / n;
    const cx = (i: number) => LEFT + band * (i + 0.5);

    const el = svg("svg", { width: W, height: HEIGHT, viewBox: `0 0 ${W} ${HEIGHT}`, class: "chart", tabindex: 0, role: "img" });
    const last = tl[n - 1]!;
    el.setAttribute("aria-label", `Coverage from ${tl[0]!.percent.toFixed(1)} % in ${monthLabel(tl[0]!.month)} to ${last.percent.toFixed(1)} % in ${monthLabel(last.month)}; the table below has every month`);

    // Coverage: percent, from 0 so the slope reads as the share it is.
    const maxP = Math.max(1, ...tl.map((m) => m.percent));
    const ps = niceStep(maxP, 3);
    const pTop = Math.ceil(maxP / ps) * ps;
    const YA = (p: number) => A_TOP + A_H - (p / pTop) * A_H;
    for (let p = 0; p <= pTop + 1e-9; p += ps) {
      el.append(svg("line", { x1: LEFT, x2: W - RIGHT, y1: YA(p), y2: YA(p), class: p === 0 ? "axis" : "grid" }));
      el.append(svg("text", { x: LEFT - 4, y: YA(p) + 4, "text-anchor": "end", class: "tick" }, `${Math.round(p)} %`));
    }
    const line = tl.map((m, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${YA(m.percent).toFixed(1)}`).join("");
    el.append(svg("path", { d: `${line}L${cx(n - 1).toFixed(1)},${YA(0)}L${cx(0).toFixed(1)},${YA(0)}Z`, fill: ROAD, "fill-opacity": 0.1 }));
    el.append(svg("path", { d: line, fill: "none", stroke: ROAD, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    el.append(svg("circle", { cx: cx(n - 1), cy: YA(last.percent), r: 4, fill: ROAD, stroke: "#fff", "stroke-width": 2 }));
    // The one direct label: where it stands now.
    el.append(svg("text", { x: cx(n - 1) + 8, y: YA(last.percent) + 4, class: "label" }, `${last.percent.toFixed(1)} %`));

    // New km per month: roads below, tracks on top, a 2 px surface gap between them.
    const newKm = (m: MonthStats) => m.new_countable_km + m.new_bonus_km;
    const maxK = Math.max(1, ...tl.map(newKm));
    const ks = niceStep(maxK, 2);
    const kTop = Math.ceil(maxK / ks) * ks;
    const YB = (k: number) => B_TOP + B_H - (k / kTop) * B_H;
    el.append(svg("text", { x: 0, y: B_TOP - 14, class: "title" }, "New km per month"));
    const legend = [
      ["roads", ROAD],
      ["tracks and paths", TRACK],
    ] as const;
    let lx = 112;
    for (const [label, color] of legend) {
      el.append(svg("rect", { x: lx, y: B_TOP - 22, width: 10, height: 10, rx: 2, fill: color }));
      el.append(svg("text", { x: lx + 14, y: B_TOP - 13, class: "tick" }, label));
      lx += 14 + label.length * 6 + 12;
    }
    for (let k = 0; k <= kTop + 1e-9; k += ks) {
      el.append(svg("line", { x1: LEFT, x2: W - RIGHT, y1: YB(k), y2: YB(k), class: k === 0 ? "axis" : "grid" }));
      el.append(svg("text", { x: LEFT - 4, y: YB(k) + 4, "text-anchor": "end", class: "tick" }, String(Math.round(k))));
    }
    const bw = Math.max(1, Math.min(24, band - 2));
    tl.forEach((m, i) => {
      const x = cx(i) - bw / 2;
      const hRoad = (m.new_countable_km / kTop) * B_H;
      const hTrack = (m.new_bonus_km / kTop) * B_H;
      if (hRoad > 0) el.append(svg("path", { d: column(x, bw, YB(0) - hRoad, hRoad, hTrack < 2.5), fill: ROAD }));
      // The gap comes off the track segment, so the road column keeps its true height.
      if (hTrack >= 2.5 || (hRoad === 0 && hTrack > 0)) {
        const top = YB(0) - hRoad - hTrack;
        const h = hRoad > 0 ? hTrack - 2 : hTrack;
        if (h > 0) el.append(svg("path", { d: column(x, bw, top, h, true), fill: TRACK }));
      }
    });

    // Month axis: each January gets its year, and the first month its name when it is not one.
    const axisY = B_TOP + B_H + 13;
    let lastX = -Infinity;
    tl.forEach((m, i) => {
      const jan = m.month.endsWith("-01");
      if (i === 0 && !jan) {
        el.append(svg("text", { x: cx(0) - band / 2, y: axisY, class: "tick" }, monthLabel(m.month)));
        lastX = cx(0) + 60;
      } else if (jan && cx(i) - 14 > lastX) {
        el.append(svg("text", { x: cx(i), y: axisY, "text-anchor": "middle", class: "tick" }, m.month.slice(0, 4)));
        lastX = cx(i) + 14;
      }
    });

    const cross = svg("line", { y1: A_TOP, y2: B_TOP + B_H, class: "crosshair", visibility: "hidden" });
    const mark = svg("circle", { r: 4, fill: ROAD, stroke: "#fff", "stroke-width": 2, visibility: "hidden" });
    const hit = svg("rect", { x: LEFT, y: 0, width: pw, height: HEIGHT, fill: "transparent" });
    el.append(cross, mark, hit);
    host.append(el);
    const tip = tooltip(host);
    let at = -1;
    const show = (i: number) => {
      at = Math.max(0, Math.min(n - 1, i));
      const m = tl[at]!;
      const x = cx(at);
      cross.setAttribute("x1", String(x));
      cross.setAttribute("x2", String(x));
      cross.setAttribute("visibility", "visible");
      mark.setAttribute("cx", String(x));
      mark.setAttribute("cy", String(YA(m.percent)));
      mark.setAttribute("visibility", "visible");
      tip.show(x, [
        [monthLabel(m.month, "long"), ""],
        [`${m.percent.toFixed(1)} %`, `covered, ${m.countable_ridden_km.toFixed(1)} km`],
        [`${m.new_countable_km.toFixed(1)} km`, "new roads"],
        [`${m.new_bonus_km.toFixed(1)} km`, "new tracks and paths"],
      ]);
    };
    const hide = () => {
      at = -1;
      cross.setAttribute("visibility", "hidden");
      mark.setAttribute("visibility", "hidden");
      tip.hide();
    };
    hit.addEventListener("pointermove", (e) => show(Math.floor((e.clientX - el.getBoundingClientRect().left - LEFT) / band)));
    hit.addEventListener("pointerleave", hide);
    el.addEventListener("blur", hide);
    el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(at < 0 ? 0 : at + 1);
      else if (e.key === "ArrowLeft") show(at < 0 ? n - 1 : at - 1);
      else return;
      e.preventDefault();
    });
  };

  // The table twin of the charts, newest month first.
  const table = $("#progress-table tbody");
  table.replaceChildren(
    ...[...tl].reverse().map((m) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td></td><td class="num"></td><td class="num"></td><td class="num"></td>`;
      [monthLabel(m.month), `${m.percent.toFixed(1)} %`, m.new_countable_km.toFixed(1), m.new_bonus_km.toFixed(1)].forEach((c, i) => (tr.children[i]!.textContent = c));
      return tr;
    }),
  );

  // Drawn when first opened (a closed section has no width) and again when the panel resizes.
  section.addEventListener("toggle", draw);
  new ResizeObserver(draw).observe(host);
}
