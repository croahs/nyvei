// Property names in the edge files, mirrored from the comment at the top of
// pipeline/match.ts. On its own so the router (route.ts) can import it without
// the browser-only loaders in data.ts.

export const P = {
  id: "i",
  from: "a",
  to: "b",
  countable: "c",
  highway: "h",
  name: "n",
  length: "l",
  firstDate: "d",
  firstActivity: "r",
  counted: "p",
  /** "p" paved, "u" unpaved, absent when OSM has no usable surface tag. */
  surface: "s",
  /** Elevations in whole metres at evenly spaced points from a to b (at least 2), absent without elevation data. */
  elev: "z",
} as const;
