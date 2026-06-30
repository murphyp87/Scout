# Scout — NJ HS Wrestling

A small personal tool to scout NJ high school wrestling teams. A local Node build
step scrapes each wrestler's public [NJ.com](https://highschoolsports.nj.com)
profile, parses their records, and writes one JSON file per team under `data/`.
A static, iPhone-formatted page (`index.html`) renders it.

Wrestlers with no current-season match data are skipped.

## Pages

The home screen has three choices:

- **Teams** — browse every team; tap one to see a horizontal row per weight class
  (wrestlers ordered by match count). Each card opens that wrestler's NJ.com profile.
- **Team Matchup** — pick a Home and Away team; see each weight class's **main wrestler**
  (the most-active wrestler at that weight) from both teams, side by side. A
  **Matchup Prediction** strip below each pair shows the predicted winner, win
  percentage, match points, and the running score going into that match. A summary
  card at the top shows the predicted final score.
- **Individual Matchup** — pick *My Wrestler* (School → Name → Weight) and an *Opponent*
  school (name optional). With no opponent name, up to 5 likely opponents around that
  weight (±1 class) are shown, each scored — see formulas below.

A **Comment** button on every page opens a feedback form that posts to
[Web3Forms](https://web3forms.com) (client-side; the destination email is held by
the service via a public access key, never in the page). Dark/light theme toggle in
the header; the footer shows the deployed version.

## Matchup formulas

Both scores are transparent heuristics (estimates, not guarantees). Weight "class
distance" is measured on the standard NJ ladder:
`106 113 120 126 132 138 144 150 157 165 175 190 215 285`. For a wrestler,
`matches = wins + losses` (this season).

**Matchup Probability** — how likely an opponent is the one actually faced. Candidates
are opponents whose primary weight is at the selected weight or one class up/down:

```
weightFactor = 1.0 (same class) | 0.4 (one class up/down)
weight_i     = weightFactor × matches_i           # more matches ⇒ likely the starter
MatchupProbability_i = weight_i / Σ(weight over all candidates)
```

**Win Probability** — estimated chance My Wrestler wins. Each wrestler's win rate is
shrunk toward 50% (pseudo-count `s = 5`) so small samples don't dominate, then compared
with a per-class size adjustment (`β = 0.4`):

```
adjWinRate(X) = (wins + s/2) / (matches + s)
rating(X)     = ln( adjWinRate / (1 − adjWinRate) )         # log-odds
Δclass        = classIndex(opponent) − classIndex(myWeight) # + if opponent is heavier
logit         = rating(My) − rating(Opponent) − β × Δclass
WinProbability = 1 / (1 + e^(−logit))
```

Both scores are color-coded: **>50% green, 35–50% yellow, <35% red**.

**Team Matchup Points** — the predicted winner at each weight earns 3–6 team points
scaled by win probability (no ties). A forfeit (one team has no wrestler) awards 6
points to the team with a wrestler.

```
winnerProb = winner's win probability (always ≥ 0.5)
matchPts   = clamp( round( 3 + (winnerProb − 0.5) × 6 ), 3, 6 )
```

Examples: 50% → 3 pts, 67% → 4 pts, 83% → 5 pts, 100% → 6 pts.
The running score shown on each row reflects cumulative points *after* that match.

Tunable constants live at the top of the script in `index.html`
(`weightFactor`, `SHRINK = s`, `BETA = β`).

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
