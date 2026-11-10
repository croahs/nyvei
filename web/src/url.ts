// The query string holds the selected ride (?ride=<id>, main.ts) and the route (routeurl.ts) side
// by side; data.ts takes ?heat=<key> out of it before either reads it. Each writer changes only
// its own parameters. Written by hand rather than with URLSearchParams.toString, which escapes
// the commas, semicolons and colons that keep "start=58.85200,5.73500" readable in the address bar.

const KEEP: Record<string, string> = { "%2C": ",", "%3B": ";", "%3A": ":" };

export function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

/** Sets (string) or removes (null) these parameters, in the order given after the others, and leaves the others as they are. */
export function setParams(values: Record<string, string | null>): void {
  const params = new URLSearchParams(location.search);
  for (const k of Object.keys(values)) params.delete(k);
  for (const [k, v] of Object.entries(values)) if (v !== null) params.append(k, v);
  const q = [...params]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C|%3B|%3A/g, (s) => KEEP[s]!)}`)
    .join("&");
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
}
