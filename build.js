#!/usr/bin/env node
/**
 * Wrestling Scout — local build step.
 *
 * Reads the Middletown South roster, then for every wrestler fetches (politely,
 * with local caching) their current- and previous-year NJ.com wrestling pages,
 * parses them, and writes profiles.json for the static site.
 *
 * Wrestlers with no current-season match data are skipped (no card).
 * The NJ.com pages are fully public — no login / credentials required.
 *
 * Usage:
 *   node build.js              # use cached HTML if present, else fetch
 *   node build.js --refresh    # force a fresh fetch of every page
 */

const fs = require('fs');
const path = require('path');

// Teams to scout (id/name/slug). Generated from the NJ.com school index; edit
// schools.json to add/remove teams. `id` is also the data-file name + landing link.
const SCHOOLS = require('./schools.json');
// Current/previous NJ season strings, derived from today's date so they roll over
// automatically every year. NJ HS wrestling starts in ~November, so from November
// onward the season is (thisYear)-(thisYear+1); the rest of the year (the just-finished
// or in-progress season) it's (lastYear)-(thisYear).
//   e.g. Jun 2026 -> current 2025-2026, previous 2024-2025
//        Nov 2026 -> current 2026-2027, previous 2025-2026  (auto-rolls here)
function seasonsFor(now = new Date()) {
  const y = now.getFullYear();
  const startYear = now.getMonth() + 1 >= 11 ? y : y - 1;
  const s = (a) => `${a}-${a + 1}`;
  return { current: s(startYear), previous: s(startYear - 1) };
}
const SEASONS = seasonsFor();
// NJSIAA tournaments happen in the calendar year the season ends (e.g. 2025-2026 -> 2026).
const YEAR = {
  current: parseInt(SEASONS.current.split('-')[1], 10),
  previous: parseInt(SEASONS.previous.split('-')[1], 10),
};

const rosterUrl = (slug) =>
  `https://highschoolsports.nj.com/school/${slug}/wrestling/season/${SEASONS.current}/roster`;
const playerUrl = (slug, season) =>
  `https://highschoolsports.nj.com/player/${slug}/wrestling/season/${season}`;

const CACHE_DIR = path.join(__dirname, 'cache');
const DATA_DIR = path.join(__dirname, 'data');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Build modes:
//   (default)          use cache where present; fetch only what's missing.
//   --refresh          refetch everything (full rebuild, current + previous year).
//   --refresh-current  delta refresh: refetch rosters + current-year pages, but
//                      reuse cached previous-year pages (last season never changes).
//   --force            ignore the in-season gate for --refresh-current.
const REFRESH = process.argv.includes('--refresh');
const REFRESH_CURRENT = process.argv.includes('--refresh-current');
const FORCE = process.argv.includes('--force');

// NJ wrestling runs ~December–March; treat Nov–Mar as in-season (with a little margin).
const inSeason = (d = new Date()) => {
  const m = d.getMonth() + 1;
  return m >= 11 || m <= 3;
};
// Whether to re-download current-year pages this run.
const REVALIDATE_CURRENT = REFRESH || (REFRESH_CURRENT && (FORCE || inSeason()));

const POLITE_DELAY_MS = 250;
const CONCURRENCY = 4; // wrestlers fetched in parallel per team (balance speed vs. load)
const NET_RETRIES = 3; // transient network errors are retried (matters over long runs)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with a fixed-size worker pool; preserves input order in results. */
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Fetch a URL, caching the HTML locally so we don't hammer NJ.com.
 * Returns { html, status }. A missing page (HTTP error) caches an empty file and
 * returns html=null. A persistent network error returns html=null WITHOUT caching,
 * so a later re-run retries it.
 */
async function getCached(cacheName, url, revalidate = REFRESH) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, cacheName);

  if (!revalidate && fs.existsSync(cacheFile)) {
    const html = fs.readFileSync(cacheFile, 'utf8');
    return { html: html === '' ? null : html, status: 'cache' };
  }

  for (let attempt = 1; attempt <= NET_RETRIES; attempt++) {
    await sleep(POLITE_DELAY_MS); // be polite between live requests
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      if (attempt === NET_RETRIES) {
        console.log(`  ! network error for ${url}: ${err.message}`);
        return { html: null, status: 'error' };
      }
      await sleep(POLITE_DELAY_MS * attempt * 4); // back off, then retry
      continue;
    }
    // Rate-limit / server hiccup: back off and retry; never cache it as "empty".
    if (res.status === 429 || res.status >= 500) {
      if (attempt === NET_RETRIES) {
        console.log(`  ! HTTP ${res.status} (gave up) for ${url}`);
        return { html: null, status: res.status };
      }
      await sleep(POLITE_DELAY_MS * attempt * 8); // longer back off for rate limits
      continue;
    }
    if (!res.ok) {
      fs.writeFileSync(cacheFile, ''); // genuine "nothing here" (e.g. 404)
      return { html: null, status: res.status };
    }
    const html = await res.text();
    fs.writeFileSync(cacheFile, html);
    return { html, status: res.status };
  }
}

const count = (html, re) => (html.match(re) || []).length;

/** Tally wins (Win over / Win by) and losses (Loss to) in a chunk of HTML. */
function tally(html) {
  const wins = count(html, /Win over/gi) + count(html, /Win by/gi);
  const losses = count(html, /Loss to/gi);
  return { wins, losses };
}

const recordStr = ({ wins, losses }) => `${wins}-${losses}`;

/** Decode the handful of HTML entities that show up in NJ.com names. */
function decodeEntities(s) {
  return s
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
}

/** Parse the roster page into a deduped list of { slug, name }. */
function parseRoster(html) {
  const re = /<a[^>]+href="\/player\/([a-z0-9-]+)\/wrestling[^"]*"[^>]*>([^<]+)<\/a>/gi;
  const bySlug = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    const name = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (!bySlug.has(slug) && name) bySlug.set(slug, { slug, name });
  }
  return [...bySlug.values()];
}

/** Parse a current-year page: class, per-weight records, overall, primary weight. */
function parseCurrent(html) {
  const classMatch = html.match(
    /Class:\s*<\/span>\s*<span[^>]*class="prop-val"[^>]*>\s*([^<]+?)\s*</i
  );
  const wrestlerClass = classMatch ? classMatch[1].trim() : null;

  // Matches are grouped under per-weight headers like ">2025-2026 138 pound<".
  const headerRe = new RegExp(`>${SEASONS.current}\\s+(\\d{2,3})\\s+pound<`, 'gi');
  const heads = [];
  let m;
  while ((m = headerRe.exec(html)) !== null) {
    heads.push({ weight: parseInt(m[1], 10), pos: m.index });
  }

  const byWeight = heads
    .map((h, i) => {
      const end = i + 1 < heads.length ? heads[i + 1].pos : html.length;
      const t = tally(html.slice(h.pos, end));
      return { weight: h.weight, wins: t.wins, losses: t.losses, record: recordStr(t) };
    })
    .filter((w) => w.wins + w.losses > 0); // only weights the wrestler actually competed at

  const totalMatches = byWeight.reduce((n, w) => n + w.wins + w.losses, 0);
  if (totalMatches === 0) return null; // no data → caller skips this wrestler

  const primary = byWeight.reduce((best, w) =>
    w.wins + w.losses > best.wins + best.losses ? w : best
  );
  const overall = tally(html);

  return {
    wrestlerClass,
    primaryWeight: primary.weight,
    overall: recordStr(overall),
    matchesThisYear: overall.wins + overall.losses,
    byWeight: byWeight.map(({ weight, record }) => ({ weight, record })),
  };
}

/**
 * Extract individual NJSIAA tournament results from a page.
 *
 * Each result line looks like "2/24/2025, 2025 NJSIAA Region 5 - 126, First Round".
 * We deliberately skip "NJSIAA Team Tournament" lines (those are team dual meets,
 * not an individual's postseason placement), and we read the YEAR from the line
 * itself rather than trusting which season's page it came from — NJ.com sometimes
 * serves the current season on a previous-year URL.
 *
 * Returns [{ year, sortKey, text }], where text drops the leading date.
 */
function parseNjsiaa(html) {
  if (!html) return [];
  const text = html.replace(/<[^>]+>/g, ' ');
  const results = [];
  text.split(/[\n\r]|\s{2,}/).forEach((raw, idx) => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!/NJSIAA/.test(line) || /Team Tournament/i.test(line)) return;
    const m = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{4})\s+NJSIAA\b/);
    if (!m) return; // not an individual-tournament result line
    const [, mo, da, dateYear, tagYear] = m.map(Number);
    results.push({
      year: tagYear,
      // Latest date wins (deepest stage reached); document order breaks ties (deepest round).
      sortKey: dateYear * 10000 + mo * 100 + da + idx / 1e6,
      text: line.replace(/^\d{1,2}\/\d{1,2}\/\d{4},\s*/, ''),
    });
  });
  return results;
}

/** Furthest NJSIAA result (by latest date / deepest round) for a given year, or null. */
function furthestNjsiaa(results, year) {
  const forYear = results.filter((r) => r.year === year);
  if (!forYear.length) return null;
  return forYear.reduce((best, r) => (r.sortKey > best.sortKey ? r : best)).text;
}

/**
 * Last-year overall W-L from the previous-year page — but only if the page truly
 * contains previous-season match data. NJ.com sometimes serves the current season
 * on the previous-year URL, which would otherwise produce a bogus "last year" record.
 */
function parseLastYearRecord(prevHtml) {
  if (!prevHtml) return null;
  const headerRe = new RegExp(`>${SEASONS.previous}\\s+\\d{2,3}\\s+pound<`, 'i');
  if (!headerRe.test(prevHtml)) return null;
  const overall = tally(prevHtml);
  return overall.wins + overall.losses > 0 ? recordStr(overall) : null;
}

/**
 * Build one school's profiles, write data/<id>.json, return a summary for the index.
 * Returns null if the school has no roster (so it's dropped from the team list).
 */
async function buildTeam(school) {
  const roster = await getCached(
    `roster-${school.slug}-${SEASONS.current}.html`, rosterUrl(school.slug), REVALIDATE_CURRENT
  );
  const wrestlers = roster.html ? parseRoster(roster.html) : [];
  if (!wrestlers.length) {
    console.log(`– ${school.name}: no roster, skipped`);
    return null;
  }

  const skipped = [];

  const built = await mapPool(wrestlers, CONCURRENCY, async ({ slug, name }) => {
    // Cache is keyed by season so that when the season rolls over, last year's page
    // (now the "previous" season) is reused from when it was "current" — no stale data,
    // no needless refetch. Current-year page carries new results → revalidate in delta mode.
    const cur = await getCached(`player-${slug}-${SEASONS.current}.html`, playerUrl(slug, SEASONS.current), REVALIDATE_CURRENT);
    const current = cur.html ? parseCurrent(cur.html) : null;
    if (!current) {
      skipped.push(name);
      return null;
    }

    // Previous-year page is immutable (last season is over) → only refetched on a full --refresh.
    const prevPage = await getCached(`player-${slug}-${SEASONS.previous}.html`, playerUrl(slug, SEASONS.previous), REFRESH);

    // NJSIAA lines may appear on either page; bucket by the year tagged in each line.
    const njsiaa = [...parseNjsiaa(cur.html), ...parseNjsiaa(prevPage.html)];
    const thisYearNJSIAA = furthestNjsiaa(njsiaa, YEAR.current);
    const lastYearNJSIAA = furthestNjsiaa(njsiaa, YEAR.previous);

    return {
      name,
      class: current.wrestlerClass,
      primaryWeight: current.primaryWeight,
      overall: current.overall,
      matchesThisYear: current.matchesThisYear,
      byWeight: current.byWeight,
      lastYearOverall: parseLastYearRecord(prevPage.html),
      thisYearNJSIAA,
      lastYearNJSIAA,
      profileUrl: playerUrl(slug, SEASONS.current),
    };
  });

  // Sort cards by primary weight (lightest first), then name.
  const profiles = built
    .filter(Boolean)
    .sort((a, b) => a.primaryWeight - b.primaryWeight || a.name.localeCompare(b.name));

  // A school with a roster but no wrestlers with match data is a dead-end card — drop it
  // (and remove any stale data file) so it doesn't appear in the team list.
  const file = path.join(DATA_DIR, `${school.id}.json`);
  if (profiles.length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file);
    console.log(`– ${school.name}: no wrestlers with match data, skipped`);
    return null;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const changed = writeJsonStable(file, {
    id: school.id,
    team: school.name,
    season: SEASONS.current,
    wrestlers: profiles,
  });
  console.log(
    `✓ ${school.name}: ${profiles.length} cards, ${skipped.length} skipped${changed ? ' (updated)' : ''}.`
  );

  return { id: school.id, name: school.name, season: SEASONS.current, wrestlers: profiles.length };
}

/**
 * Write `payload` as JSON only if its content differs from what's on disk (ignoring the
 * volatile `generatedAt` stamp). Keeps nightly runs from churning files — and therefore
 * git/Pages — when no results actually changed. Returns true if the file was (re)written.
 */
function writeJsonStable(file, payload) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete prev.generatedAt;
  } catch {
    prev = null;
  }
  if (prev && JSON.stringify(prev) === JSON.stringify(payload)) return false;
  fs.writeFileSync(
    file,
    JSON.stringify({ ...payload, generatedAt: new Date().toISOString() }, null, 2) + '\n'
  );
  return true;
}

function writeTeamsIndex(teams) {
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return writeJsonStable(path.join(DATA_DIR, 'teams.json'), { teams: sorted });
}

(async function main() {
  const mode = REFRESH
    ? 'full refresh (current + previous year)'
    : REFRESH_CURRENT
    ? REVALIDATE_CURRENT
      ? 'delta refresh (current-year pages; previous year from cache)'
      : 'delta refresh requested, but OFF-SEASON — using cache only (no fetching). Use --force to override.'
    : 'cache fill (fetch only what is missing)';
  console.log(`Scout build — ${SCHOOLS.length} teams — mode: ${mode}\n`);

  const teams = [];
  let i = 0;
  for (const school of SCHOOLS) {
    i++;
    process.stdout.write(`[${i}/${SCHOOLS.length}] `);
    const summary = await buildTeam(school);
    if (summary) teams.push(summary);
  }

  // Safety: never overwrite the index with nothing (e.g. a total fetch outage would
  // otherwise wipe the live site). Leave existing data in place and fail loudly.
  if (teams.length === 0) {
    console.error('\n✗ built 0 teams — refusing to overwrite data/teams.json. Leaving existing data untouched.');
    process.exit(1);
  }

  const changed = writeTeamsIndex(teams);
  console.log(`\n✓ ${teams.length} teams — data/teams.json ${changed ? 'updated' : 'unchanged'}.`);
})().catch((err) => {
  console.error('\n✗ build failed:', err.message);
  process.exit(1);
});
