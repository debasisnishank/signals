// Collect the discoveries this site lists: newly created repositories that
// broke out, and things people shipped on Show HN.
//
// Runs before `astro build`, so the page itself does no I/O and cannot fail or
// render empty because an API is down. A failed fetch keeps the previous cached
// values and emits a ::warning:: annotation instead — the site stays up with
// yesterday's list rather than going blank.
//
// The cache is committed, so local and offline builds render real content.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PATH = resolve(ROOT, 'src/data/feed-cache.json');

/** Warn in a way that is visible both locally and on the Actions run summary. */
function warn(msg) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=Stale feed::${msg}`);
  console.warn(`  ! ${msg}`);
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return { tech: { fetchedAt: null, repos: [], showhn: [] } };
  }
}

/* ---------------------------------------------------------------------------
 * Tech discoveries (/signals): newly created repositories that broke out, plus
 * things people actually shipped on Show HN. Star charts are dominated by
 * reading lists and interview prep, which are not discoveries, so those are
 * filtered out rather than ranked down.
 * ------------------------------------------------------------------------- */
const DISCOVERY_WINDOW_DAYS = 21;
const DISCOVERY_LIMIT = 8;
const SHOWHN_LIMIT = 6;

// Curated lists and study material: popular, but not a new tool.
const NOT_A_DISCOVERY =
  /\b(awesome|tutorials?|courses?|roadmaps?|interview|cheat-?sheets?|study|lecture|curriculum|bootcamp|free-?programming|100-days|learn(ing)?-path|books?)\b/i;

// Descriptions that are selling something rather than describing it: pasted
// landing-page URLs, price lists, "official website".
const PROMOTIONAL = /(https?:\/\/|\bpricing\b|official website|paid (services|plan)|\bbuy now\b)/i;

function isUsefulRepo(r) {
  if (!r.description || r.archived || r.disabled) return false;
  // The feed is English; drop entries whose description is mostly non-latin.
  const latin = (r.description.match(/[\x20-\x7E]/g) ?? []).length / r.description.length;
  if (latin < 0.75) return false;
  // A description too short to tell you anything is usually noise — but a repo
  // this popular is a discovery whether or not it bothered to explain itself.
  if (r.description.trim().length < 25 && r.stargazers_count < 1500) return false;
  if (PROMOTIONAL.test(r.description)) return false;
  return !NOT_A_DISCOVERY.test(r.name) && !NOT_A_DISCOVERY.test(r.description);
}

async function fetchTech() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'astro-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const since = new Date(Date.now() - DISCOVERY_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  const q = `created:>${since} stars:>40`;
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=40`,
    { headers },
  );
  if (!res.ok) throw new Error(`repo search ${res.status} ${res.statusText}`);

  const repos = ((await res.json()).items ?? [])
    .filter(isUsefulRepo)
    .slice(0, DISCOVERY_LIMIT)
    .map((r) => ({
      name: r.full_name,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      url: r.html_url,
      created: r.created_at,
      topics: (r.topics ?? []).slice(0, 4),
    }));

  // Show HN: things people built and shipped, rather than things written about.
  const cutoff = Math.floor(Date.now() / 1000) - DISCOVERY_WINDOW_DAYS * 86400;
  const hnRes = await fetch(
    'https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=40' +
    `&numericFilters=points>30,created_at_i>${cutoff}`,
    { headers: { 'User-Agent': 'astro-build' } },
  );
  if (!hnRes.ok) throw new Error(`show hn ${hnRes.status} ${hnRes.statusText}`);

  const showhn = ((await hnRes.json()).hits ?? [])
    .filter((h) => h.title && h.url)
    .slice(0, SHOWHN_LIMIT)
    .map((h) => ({
      title: h.title.replace(/^Show HN:\s*/i, '').trim(),
      url: h.url,
      points: h.points,
      comments: h.num_comments ?? 0,
      discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
      created: new Date(h.created_at_i * 1000).toISOString(),
    }));

  if (!repos.length && !showhn.length) throw new Error('no usable discoveries');
  return { repos, showhn };
}

const cache = readCache();
const before = JSON.stringify(cache);
const now = new Date().toISOString();
let degraded = 0;

const FIELDS = ['repos', 'showhn'];
const size = (o) => FIELDS.reduce((n, f) => n + (o?.[f]?.length ?? 0), 0);

try {
  const data = await fetchTech();
  const changed = FIELDS.some((f) => JSON.stringify(cache.tech?.[f]) !== JSON.stringify(data[f]));
  if (changed) cache.tech = { fetchedAt: now, ...data };
  console.log(`  ok  discoveries: ${size(data)} item(s)${changed ? ' (updated)' : ' (unchanged)'}`);
} catch (err) {
  const kept = size(cache.tech);
  degraded++;
  warn(
    `discovery fetch failed (${err.message}). ` +
    (kept
      ? `Falling back to ${kept} cached item(s) from ${cache.tech?.fetchedAt ?? 'an earlier build'}.`
      : 'No cached data either — the page will show its empty state.'),
  );
}

if (JSON.stringify(cache) !== before) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

console.log(degraded ? '\nfeeds: degraded — serving cached data, build continues.\n'
                     : '\nfeeds: fresh.\n');
