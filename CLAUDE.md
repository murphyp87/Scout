# Wrestling Scout — Project Context

## What this is
A personal tool for a NJ high school wrestling parent to scout a son's
upcoming opponents. End goal: an iPhone-formatted web page of selectable
athlete "cards"; tapping a card opens that wrestler's current-year NJ.com
profile. Build incrementally and keep it simple.

## Current milestone
ONE athlete only — Ryan Romano — until the single-profile logic is correct.
Do NOT generalize to multiple athletes or build the card grid until I say so.

## Architecture (important — read before coding)
- Data is fetched and parsed by a local Node.js build script, which writes a
  `profile.json` file.
- A separate, static, iPhone-width HTML page renders `profile.json`.
- Do NOT fetch NJ.com from browser-side JavaScript — cross-origin (CORS) rules
  and a possible login will block it. ALL network fetching and parsing happens
  in the Node build step only.
- The deployed site is purely static: no server and no secrets shipped. The
  scraping/build step runs locally on my machine.

## Data sources (first milestone)
- Ryan Romano, current year:
  https://highschoolsports.nj.com/player/ryan-romano-1/wrestling/season/2025-2026
- Ryan Romano, last year:
  https://highschoolsports.nj.com/player/ryan-romano-1/wrestling/season/2024-2025

## Parsing rules
- Wins: count occurrences of "Win over" and "Win by"; break out by weight class.
- Losses: count occurrences of "Loss to".
- Class: the text following "CLASS:" on the current-year page.
- Furthest NJSIAA (previous year): the last line containing "NJSIAA" on the
  previous-year page.

## Validation values (use ONLY to confirm parsing is correct — never hardcode)
- Class: Junior
- Primary weight: 138
- Current overall: 32-8  (138: 32-7, 144: 0-1)
- Last year overall: 26-8
- Furthest NJSIAA (prev year): 2025 NJSIAA Region 5 - 126, First Round

## Credentials & secrets — strict
- FIRST check whether the NJ.com pages load WITHOUT logging in. If they do, use
  no credentials at all (simplest and safest).
- If a login is genuinely required, read credentials from a local `.env` file
  via variables such as NJ_USER / NJ_PASS / FLO_USER / FLO_PASS.
- NEVER hardcode credentials in any source file.
- `.env` stays listed in `.gitignore`; it must never be committed or deployed.

## How to work in this project
- Explore the page structure and propose a plan BEFORE writing code; wait for
  my approval.
- Ask before running commands or installing packages.
- Keep it simple — low-volume personal project, free to host.
- Fetch NJ.com politely: low frequency, and cache pages locally while iterating
  so we don't hammer the site on every run.
