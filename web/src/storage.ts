// Per-viewer choices in localStorage, as layers.ts keeps its own: storage can be missing or throw
// (private window, blocked site data), and then the defaults apply and choices last for the page.

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not stored; the choice lasts for this page only.
  }
}
