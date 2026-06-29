# Scout — NJ HS Wrestling

A small personal tool to scout NJ high school wrestling teams. A local Node build
step scrapes each wrestler's public [NJ.com](https://highschoolsports.nj.com)
profile, parses their records, and writes one JSON file per team under `data/`.
A static, iPhone-formatted page (`index.html`) lists the teams; tapping a team
shows a horizontal row per weight class (wrestlers ordered by match count), and
each card opens that wrestler's current-year NJ.com profile.

Wrestlers with no current-season match data are skipped.

## Teams

Teams are listed in `schools.json` (each has an `id`, display `name`, and NJ.com
`slug`); `build.js` reads that file. The current set covers every NJ.com school
that fields a wrestling team this season (318 teams). Schools with a roster but no
wrestlers with match data are dropped from the team list automatically. Add or
remove entries in `schools.json` and re-run the build to change coverage.

## Use

```sh
node build.js                  # cache fill: fetch only what's missing
node build.js --refresh        # full rebuild: refetch every page (current + previous year)
node build.js --refresh-current# delta: refetch current-year pages only (previous year is
                               #        immutable and served from cache). No-ops out of season.
node build.js --refresh-current --force   # delta refresh even out of season (for testing)

# then serve the static site locally:
python -m http.server 8000
# open http://localhost:8000/
```

## Automatic nightly refresh

`.github/workflows/refresh.yml` runs `--refresh-current` nightly via GitHub Actions:

- **Delta only** — re-fetches just current-year pages (previous-year pages never change),
  and writes a data file only when a wrestler's results actually changed.
- **Pushes only deltas** — commits/pushes (and triggers a Pages redeploy) solely when
  `data/` changed, so the site stays quiet on no-result nights.
- **Season-gated** — does nothing outside ~Nov–Mar (NJ wrestling season).
- **Safe** — refuses to overwrite the team index if a fetch outage produced no teams.
- Runs on GitHub's servers (no PC needed) using the built-in token (no stored passwords).
  Trigger manually anytime from the repo's **Actions → Nightly data refresh → Run workflow**.

The current/previous season strings are derived from the date and **roll over automatically**
each November (e.g. Nov 2026 → current `2026-2027`, previous `2025-2026`).

## Notes

- The NJ.com pages are public — no login or credentials are used.
- Fetched HTML is cached under `cache/` (git-ignored) to avoid hammering the site.
- The deployed site is fully static: `index.html` + `data/teams.json` + `data/<id>.json`.
- The season is set via `SEASONS` in `build.js`; rolling to a new season is a one-line change.
