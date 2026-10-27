# Agent guide

Read [PLAN.md](PLAN.md) before changing anything: it owns the
architecture, the phase order and the open questions. Update it in place
when a decision lands; never append a contradicting section.

## Invariants

- Static site, no backend, no accounts. The pipeline is pnpm scripts run
  locally; the site reads files from `web/public/data/`.
- pnpm, never npm (`pnpm dlx`, not `npx`).
- The Intervals.icu API key lives in `.env` (gitignored) as
  `INTERVALS_API_KEY`. Never commit it, never print it.
- `cache/` is derived and gitignored. Everything in it must be
  reproducible from `pnpm rides` and `pnpm roads`.
- Ridden-road data reveals where the owner lives. Nothing under
  `web/public/data/` is published anywhere without the privacy zone from
  PLAN.md phase 4.
- Code, comments, commit messages and docs in English.

## Verifying

"Done" for a phase means its criterion in PLAN.md is met on the surface
named there (the rendered map, the GPX on the Garmin), not that the
script exits 0.
