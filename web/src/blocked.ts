// Roads the owner marked not rideable (a gate, a stair the map missed, a building site). Two
// lists merged by edge id: the ones marked in this browser (localStorage), and blocked.json at
// the site root, committed and published, the permanent list every browser gets. A road marked
// here goes to that file by hand: "Copy as JSON" puts the merged list on the clipboard to paste
// over it. Every route avoids them (setBlocked in route.ts); coverage counts them as before.

import type * as maplibregl from "maplibre-gl";
import type { LonLat } from "./route";
import type { Router } from "./router";
import { loadJson, saveJson } from "./storage";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** One entry, the shape of blocked.json and of the local list. `at` is where it was marked. */
export interface BlockedEntry {
  id: string;
  name?: string;
  at: LonLat;
}
type Source = "local" | "file";

const KEY = "nyvei.blocked";

const valid = (e: unknown): e is BlockedEntry => {
  const x = e as BlockedEntry;
  return !!x && typeof x.id === "string" && Array.isArray(x.at) && x.at.length === 2 && x.at.every((n) => typeof n === "number");
};

export interface BlockedList {
  /** Where the edge is marked, null when it is not. */
  has(id: string): Source | null;
  add(e: BlockedEntry): void;
  remove(id: string): void;
  /** Every marked id, for the router's first load. */
  ids(): string[];
  onChange(cb: () => void): void;
}

/**
 * `drawIds` puts the merged ids on the map; the router is attached once it exists, and
 * gets the merged set at once on every change.
 */
export function setupBlocked(map: maplibregl.Map, drawIds: (ids: string[]) => void): BlockedList & { attach(router: Router): void } {
  let local: BlockedEntry[] = loadJson<unknown[]>(KEY, []).filter(valid);
  let file: BlockedEntry[] = [];
  let router: Router | null = null;
  const listeners: (() => void)[] = [];
  const list = $("#blocked-list");
  const count = $("#blocked-count");
  const statusEl = $("#blocked-status");
  let unknownNote = "";

  /** File entries win: the file is the permanent list, a local copy of one adds nothing. */
  const merged = (): (BlockedEntry & { src: Source })[] => {
    const out = new Map<string, BlockedEntry & { src: Source }>();
    for (const e of local) out.set(e.id, { ...e, src: "local" });
    for (const e of file) out.set(e.id, { ...e, src: "file" });
    return [...out.values()];
  };
  const ids = () => merged().map((e) => e.id);

  const render = () => {
    const all = merged();
    count.textContent = all.length ? `· ${all.length}` : "";
    list.replaceChildren(
      ...all.map((e) => {
        const li = document.createElement("li");
        const name = document.createElement("button");
        name.type = "button";
        name.className = "link";
        name.textContent = e.name ?? `Unnamed road ${e.id}`;
        name.title = "Show it on the map";
        name.addEventListener("click", () => map.flyTo({ center: e.at, zoom: Math.max(map.getZoom(), 16) }));
        li.append(name);
        if (e.src === "file") {
          const tag = document.createElement("span");
          tag.className = "muted";
          tag.textContent = "blocked.json";
          tag.title = "From blocked.json on the site, the list every browser gets. Remove it from that file to make it rideable again.";
          li.append(tag);
        } else {
          const rm = document.createElement("button");
          rm.type = "button";
          rm.textContent = "×";
          rm.title = "Rideable again: remove it from this browser's list";
          rm.addEventListener("click", () => api.remove(e.id));
          li.append(rm);
        }
        return li;
      }),
    );
    statusEl.textContent = all.length ? unknownNote : "None yet. Click a road on the map and press Not rideable.";
  };

  const send = () => {
    if (!router) return;
    void router.setBlocked(ids()).then(
      (r) => {
        unknownNote = r.unknown ? `${r.unknown} no longer match a road` : "";
        render();
      },
      () => undefined,
    );
  };

  const changed = () => {
    drawIds(ids());
    send();
    render();
    for (const cb of listeners) cb();
  };

  $("#blocked-copy").addEventListener("click", () => {
    // One entry per line, so the file diffs line by line.
    const text = `[\n${merged().map(({ src: _src, ...e }) => `  ${JSON.stringify(e)}`).join(",\n")}\n]\n`;
    navigator.clipboard.writeText(text).then(
      () => (statusEl.textContent = `Copied ${merged().length} as JSON, for blocked.json at the site root.`),
      () => (statusEl.textContent = "The browser would not copy to the clipboard."),
    );
  });

  // The published list; a missing or broken file is an empty one.
  void fetch(`${import.meta.env.BASE_URL}blocked.json`, { cache: "no-cache" })
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<unknown>) : []))
    .then((j) => {
      file = Array.isArray(j) ? j.filter(valid) : [];
      if (file.length) changed();
    })
    .catch(() => undefined);

  const api = {
    has(id: string): Source | null {
      if (file.some((e) => e.id === id)) return "file";
      return local.some((e) => e.id === id) ? "local" : null;
    },
    add(e: BlockedEntry) {
      if (api.has(e.id)) return;
      local = [...local, e];
      saveJson(KEY, local);
      changed();
    },
    remove(id: string) {
      local = local.filter((e) => e.id !== id);
      saveJson(KEY, local);
      changed();
    },
    ids,
    onChange(cb: () => void) {
      listeners.push(cb);
    },
    attach(r: Router) {
      router = r;
      // The merged set once more: blocked.json may arrive after the router's load took the ids;
      // the answer also brings how many no longer match a road.
      send();
    },
  };
  drawIds(ids());
  render();
  return api;
}
