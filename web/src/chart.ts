// Small inline-SVG helpers shared by the elevation profile and the progress charts. Chart colours
// are the map's own (route blue, ridden orange, track purple), so a chart reads as the same thing
// it shows on the map; they pass the dataviz validator against the white panel.

const NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A round step (1, 2 or 5 × 10^n) that splits `span` into about `n` parts. */
export function niceStep(span: number, n: number): number {
  if (!(span > 0)) return 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

/** Thousands with a thin space, the Norwegian way the rest of the panel writes them. */
export const group = (n: number) => Math.round(n).toLocaleString("en").replace(/,/g, " ");

/**
 * A tooltip box inside `host` (which must be position: relative), at the top of the chart beside
 * the crosshair at x, on whichever side has room, so it never covers the point it describes and
 * never leaves the panel.
 */
export function tooltip(host: HTMLElement): { show(x: number, rows: [string, string][]): void; hide(): void } {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  host.append(tip);
  return {
    show(x, rows) {
      // Values lead, labels follow (dataviz interaction rules); text via textContent, never markup.
      tip.replaceChildren(
        ...rows.map(([value, label]) => {
          const d = document.createElement("div");
          const v = document.createElement("strong");
          v.textContent = value;
          const l = document.createElement("span");
          l.className = "muted";
          l.textContent = label ? ` ${label}` : "";
          d.append(v, l);
          return d;
        }),
      );
      tip.hidden = false;
      const w = tip.offsetWidth;
      const right = x + 10 + w <= host.clientWidth;
      tip.style.left = `${Math.max(0, right ? x + 10 : x - 10 - w)}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}
