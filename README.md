# Scout — NJ HS Wrestling

A small personal tool to scout NJ high school wrestling teams. A local Node build
step scrapes each wrestler's public [NJ.com](https://highschoolsports.nj.com)
profile, parses their records, and writes one JSON file per team under `data/`.
A static, iPhone-formatted page (`index.html`) lists the teams; tapping a team
shows a horizontal row per weight class (wrestlers ordered by match count), and
each card opens that wrestler's current-year NJ.com profile.

Wrestlers with no current-season match data are skipped.

## Teams

Teams are configured in the `SCHOOLS` array at the top of `build.js` (each has an
`id`, display `name`, and NJ.com `slug`). Add an entry and re-run the build to
scout another team. Currently:

- Middletown South
- Middletown North

## Use

```sh
node build.js            # build data/*.json from cached pages (fetches if missing)
node build.js --refresh  # force a fresh fetch of every page

# then serve the static site locally:
python -m http.server 8000
# open http://localhost:8000/
```

## Notes

- The NJ.com pages are public — no login or credentials are used.
- Fetched HTML is cached under `cache/` (git-ignored) to avoid hammering the site.
- The deployed site is fully static: `index.html` + `data/teams.json` + `data/<id>.json`.
- The season is set via `SEASONS` in `build.js`; rolling to a new season is a one-line change.
