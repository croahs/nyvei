// Kommuner table: percent ridden per kommune, and how many km of countable road are left to its
// next whole percent, from the same stats.json numbers. Sorting by that puts the kommune nearest
// its next percent on top, one click.

import type { LngLatBoundsLike, Map } from "maplibre-gl";
import type { KommuneStats, Stats } from "./data";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const km = (n: number) => n.toFixed(1);

/** Km of countable road still to ride to reach the next whole percent. */
export function toNextPercent(k: KommuneStats): number {
  if (!(k.countable_km > 0)) return Infinity;
  // From the km rather than the rounded percent, so 46.98 % reads as 0.2 km to go, not 0.
  const p = (k.countable_ridden_km / k.countable_km) * 100;
  const next = Math.floor(p + 1e-9) + 1;
  return Math.max(0, (next / 100) * k.countable_km - k.countable_ridden_km);
}

type Key = "name" | "percent" | "km" | "next";
const SORTS: Record<Key, (a: KommuneStats, b: KommuneStats) => number> = {
  name: (a, b) => a.name.localeCompare(b.name, "nb"),
  percent: (a, b) => b.percent - a.percent || a.name.localeCompare(b.name, "nb"),
  km: (a, b) => b.countable_ridden_km - a.countable_ridden_km,
  next: (a, b) => toNextPercent(a) - toNextPercent(b),
};

export function setupKommuner(map: Map, stats: Stats): void {
  let sort: Key = "percent";
  const heads = [...document.querySelectorAll<HTMLElement>("#kommuner th[data-sort]")];
  const render = () => {
    const rows = Object.values(stats.kommuner).sort(SORTS[sort]);
    for (const th of heads) th.setAttribute("aria-sort", th.dataset.sort === sort ? (sort === "name" || sort === "next" ? "ascending" : "descending") : "none");
    $("#kommuner tbody").replaceChildren(
      ...rows.map((k) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td></td><td class="num"></td><td class="num muted"></td><td class="num"></td>`;
        const next = toNextPercent(k);
        tr.children[0]!.textContent = k.name;
        tr.children[1]!.textContent = `${km(k.percent)} %`;
        tr.children[2]!.textContent = `${km(k.countable_ridden_km)} / ${km(k.countable_km)}`;
        tr.children[3]!.textContent = Number.isFinite(next) ? km(next) : "–";
        (tr.children[3] as HTMLElement).title = Number.isFinite(next)
          ? `${km(next)} km of unridden countable road takes ${k.name} to ${Math.floor((k.countable_ridden_km / k.countable_km) * 100 + 1e-9) + 1} %`
          : "";
        tr.style.setProperty("--pct", `${k.percent}%`);
        if (k.bbox) tr.addEventListener("click", () => map.fitBounds(k.bbox as LngLatBoundsLike, { padding: 30 }));
        return tr;
      }),
    );
  };
  for (const th of heads) {
    th.addEventListener("click", () => {
      sort = th.dataset.sort as Key;
      render();
    });
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        sort = th.dataset.sort as Key;
        render();
      }
    });
  }
  render();
}
