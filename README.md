# Scout — Middletown South Wrestling

A small personal tool to scout the Middletown South (NJ) high school wrestling
team. A local Node build step scrapes each wrestler's public [NJ.com](https://highschoolsports.nj.com)
profile, parses their records, and writes `profiles.json`. A static,
iPhone-formatted page (`index.html`) renders the results as a grid of tappable
cards — each card opens that wrestler's current-year NJ.com profile.

Wrestlers with no current-season match data are skipped.

## Use

```sh
node build.js            # build profiles.json from cached pages (fetches if missing)
node build.js --refresh  # force a fresh fetch of every page

# then serve the static site locally:
python -m http.server 8000
# open http://localhost:8000/
```

## Notes

- The NJ.com pages are public — no login or credentials are used.
- Fetched HTML is cached under `cache/` (git-ignored) to avoid hammering the site.
- The deployed site is fully static: just `index.html` + `profiles.json`.
