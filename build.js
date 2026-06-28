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

const SCHOOL = 'middletown-middletown-south';
const SEASONS = { current: '2025-2026', previous: '2024-2025' };

const rosterUrl = () =>
  `https://highschoolsports.nj.com/school/${SCHOOL}/wrestling/season/${SEASONS.current}/roster`;
const playerUrl = (slug, season) =>
  `https://highschoolsports.nj.com/player/${slug}/wrestling/season/${season}`;

const CACHE_DIR = path.join(__dirname, 'cache');
const OUT_FILE = path.join(__dirname, 'profiles.json');
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
    byWeight: byWeight.map(({ weight, record }) => ({ weight, record })),
  };
}

/** Parse a previous-year page: overall record + furthest NJSIAA line (both optional). */
function parsePrevious(html) {
  if (!html) return { lastYearOverall: null, furthestNJSIAA: null };
  const overall = tally(html);

  const text = html.replace(/<[^>]+>/g, ' ');
  const njsiaa = text
    .split(/[\n\r]|\s{2,}/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => /NJSIAA/.test(l));
  const last = njsiaa.length ? njsiaa[njsiaa.length - 1] : null;
  const furthestNJSIAA = last ? last.replace(/^\d{1,2}\/\d{1,2}\/\d{4},\s*/, '') : null;

  const lastYearOverall =
    overall.wins + overall.losses > 0 ? recordStr(overall) : null;
  return { lastYearOverall, furthestNJSIAA };
}

(async function main() {
  console.log('· roster:', rosterUrl());
  const roster = await getCached(`roster-${SEASONS.current}.html`, rosterUrl());
  if (!roster.html) throw new Error('Could not load roster page.');
  const wrestlers = parseRoster(roster.html);
  console.log(`· ${wrestlers.length} wrestlers on roster\n`);

  const profiles = [];
  const skipped = [];

  for (const { slug, name } of wrestlers) {
    const cur = await getCached(`current-${slug}.html`, playerUrl(slug, SEASONS.current));
    const current = cur.html ? parseCurrent(cur.html) : null;

    if (!current) {
      skipped.push(name);
      console.log(`  – skip ${name} (no current-season data)`);
      continue;
    }

    const prevPage = await getCached(`prev-${slug}.html`, playerUrl(slug, SEASONS.previous));
    const prev = parsePrevious(prevPage.html);

    profiles.push({
      name,
      class: current.wrestlerClass,
      primaryWeight: current.primaryWeight,
      overall: current.overall,
      byWeight: current.byWeight,
      lastYearOverall: prev.lastYearOverall,
      furthestNJSIAA: prev.furthestNJSIAA,
      profileUrl: playerUrl(slug, SEASONS.current),
    });
    console.log(`  ✓ ${name} — ${current.primaryWeight} lb, ${current.overall}`);
  }

  // Sort cards by primary weight (lightest first), then name.
  profiles.sort((a, b) => a.primaryWeight - b.primaryWeight || a.name.localeCompare(b.name));

  const out = {
    team: 'Middletown South',
    season: SEASONS.current,
    generatedAt: new Date().toISOString(),
    wrestlers: profiles,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');

  console.log(
    `\n✓ wrote profiles.json — ${profiles.length} cards, ${skipped.length} skipped (no data).`
  );
})().catch((err) => {
  console.error('\n✗ build failed:', err.message);
  process.exit(1);
});
