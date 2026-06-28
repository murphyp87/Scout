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

// Teams to scout. `id` is the short key used for the data file + landing-page link.
const SCHOOLS = [
  { id: 'south', name: 'Middletown South', slug: 'middletown-middletown-south' },
  { id: 'north', name: 'Middletown North', slug: 'middletown-middletown-north' },
];
const SEASONS = { current: '2025-2026', previous: '2024-2025' };
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

const REFRESH = process.argv.includes('--refresh');
const POLITE_DELAY_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a URL, caching the HTML locally so we don't hammer NJ.com.
 * Returns { html, status }. On a non-200 (e.g. a missing previous-year page)
 * html is null but we don't throw — the caller decides what's optional.
 */
async function getCached(cacheName, url) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, cacheName);

  if (!REFRESH && fs.existsSync(cacheFile)) {
    const html = fs.readFileSync(cacheFile, 'utf8');
    return { html: html === '' ? null : html, status: 'cache' };
  }

  await sleep(POLITE_DELAY_MS); // be polite between live requests
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
  } catch (err) {
    console.log(`  ! network error for ${url}: ${err.message}`);
    return { html: null, status: 'error' };
  }
  if (!res.ok) {
    // Cache an empty file so we remember "nothing here" and don't refetch.
    fs.writeFileSync(cacheFile, '');
    return { html: null, status: res.status };
  }
  const html = await res.text();
  fs.writeFileSync(cacheFile, html);
  return { html, status: res.status };
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

/** Build one school's profiles, write data/<id>.json, return a summary for the index. */
async function buildTeam(school) {
  console.log(`\n=== ${school.name} ===`);
  const roster = await getCached(`roster-${school.slug}-${SEASONS.current}.html`, rosterUrl(school.slug));
  if (!roster.html) throw new Error(`Could not load roster page for ${school.name}.`);
  const wrestlers = parseRoster(roster.html);
  console.log(`· ${wrestlers.length} wrestlers on roster`);

  const profiles = [];
  const skipped = [];

  for (const { slug, name } of wrestlers) {
    const cur = await getCached(`current-${slug}.html`, playerUrl(slug, SEASONS.current));
    const current = cur.html ? parseCurrent(cur.html) : null;

    if (!current) {
      skipped.push(name);
      continue;
    }

    const prevPage = await getCached(`prev-${slug}.html`, playerUrl(slug, SEASONS.previous));

    // NJSIAA lines may appear on either page; bucket by the year tagged in each line.
    const njsiaa = [...parseNjsiaa(cur.html), ...parseNjsiaa(prevPage.html)];
    const thisYearNJSIAA = furthestNjsiaa(njsiaa, YEAR.current);
    const lastYearNJSIAA = furthestNjsiaa(njsiaa, YEAR.previous);

    profiles.push({
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
    });
  }

  // Sort cards by primary weight (lightest first), then name.
  profiles.sort((a, b) => a.primaryWeight - b.primaryWeight || a.name.localeCompare(b.name));

  const generatedAt = new Date().toISOString();
  const out = {
    id: school.id,
    team: school.name,
    season: SEASONS.current,
    generatedAt,
    wrestlers: profiles,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `${school.id}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(`✓ ${school.name}: ${profiles.length} cards, ${skipped.length} skipped (no data).`);

  return { id: school.id, name: school.name, season: SEASONS.current, wrestlers: profiles.length, generatedAt };
}

(async function main() {
  const teams = [];
  for (const school of SCHOOLS) {
    teams.push(await buildTeam(school));
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, 'teams.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), teams }, null, 2) + '\n'
  );
  console.log(`\n✓ wrote data/teams.json — ${teams.length} teams.`);
})().catch((err) => {
  console.error('\n✗ build failed:', err.message);
  process.exit(1);
});
