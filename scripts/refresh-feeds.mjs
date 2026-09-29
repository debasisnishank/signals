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
  let cache;
  try {
    cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    cache = { tech: { fetchedAt: null, repos: [], posts: [] } };
  }
  // Before Launch HN and front-page releases joined, Show HN was the only kind
  // of post and lived under `showhn`. Carry those entries over, keeping their
  // discovery dates.
  if (cache.archive?.showhn) {
    cache.archive.posts ??= {};
    for (const [k, v] of Object.entries(cache.archive.showhn)) {
      cache.archive.posts[k] ??= { source: 'showhn', ...v };
    }
    delete cache.archive.showhn;
  }
  if (cache.tech && 'showhn' in cache.tech) {
    cache.tech.posts ??= cache.tech.showhn.map((h) => ({ source: 'showhn', ...h }));
    delete cache.tech.showhn;
  }
  return cache;
}

/* ---------------------------------------------------------------------------
 * Tech discoveries (/signals): newly created repositories that broke out, plus
 * things people actually shipped on Show HN. Star charts are dominated by
 * reading lists and interview prep, which are not discoveries, so those are
 * filtered out rather than ranked down.
 * ------------------------------------------------------------------------- */
const DISCOVERY_WINDOW_DAYS = 21;
const DISCOVERY_LIMIT = 8;
// The 21-day chart is held by a few big breakouts for weeks, so on its own it
// admits about one new repo a day. A second, narrow window catches repos in
// their first days, before they could ever outrank those.
const FRESH_WINDOW_DAYS = 3;
const FRESH_LIMIT = 10;
const SHOWHN_LIMIT = 6;
const LAUNCHHN_LIMIT = 4;
// Front-page stories only count when they announce something that shipped:
// a repository link, or a title that says it was released.
const FRONTPAGE_WINDOW_DAYS = 2;
const FRONTPAGE_LIMIT = 4;
const RELEASE =
  /\b(released?|v\d+(\.\d+)+|open[- ]sourc(e|ed|ing)|introducing|announcing|now available)\b/i;

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

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

async function searchRepos(q, limit, headers) {
  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=40`,
    { headers },
  );
  if (!res.ok) throw new Error(`repo search ${res.status} ${res.statusText}`);
  return ((await res.json()).items ?? [])
    .filter(isUsefulRepo)
    .slice(0, limit)
    .map((r) => ({
      name: r.full_name,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      url: r.html_url,
      created: r.created_at,
      topics: (r.topics ?? []).slice(0, 4),
    }));
}

async function fetchRepos() {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'astro-build' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const breakouts = await searchRepos(`created:>${daysAgo(DISCOVERY_WINDOW_DAYS)} stars:>40`, DISCOVERY_LIMIT, headers);
  const fresh = await searchRepos(`created:>${daysAgo(FRESH_WINDOW_DAYS)} stars:>40`, FRESH_LIMIT, headers);
  return [...new Map([...breakouts, ...fresh].map((r) => [r.name, r])).values()];
}

/* ---------------------------------------------------------------------------
 * Hacker News, via the Algolia API. Show HN and Launch HN are things people
 * shipped by definition; the front page is kept only where a story announces a
 * release. All three become `posts`, told apart by `source`.
 * ------------------------------------------------------------------------- */
const HN_API = 'https://hn.algolia.com/api/v1';
const HN_HEADERS = { headers: { 'User-Agent': 'astro-build' } };
const secondsAgo = (days) => Math.floor(Date.now() / 1000) - days * 86400;

async function hnSearch(endpoint, params) {
  const url = `${HN_API}/${endpoint}?${new URLSearchParams(params)}`;
  const res = await fetch(url, HN_HEADERS);
  if (!res.ok) throw new Error(`hn ${endpoint} ${res.status} ${res.statusText}`);
  return (await res.json()).hits ?? [];
}

const normUrl = (u) => u.toLowerCase().replace(/\/+$/, '');
const discussionUrl = (h) => `https://news.ycombinator.com/item?id=${h.objectID}`;

function toPost(h, source) {
  return {
    source,
    title: h.title.replace(/^(Show|Launch) HN:\s*/i, '').trim(),
    // Launch HN posts are often text-only; the thread is then the link.
    url: h.url || discussionUrl(h),
    points: h.points,
    comments: h.num_comments ?? 0,
    discussion: discussionUrl(h),
    created: new Date(h.created_at_i * 1000).toISOString(),
  };
}

async function fetchShowHN() {
  const hits = await hnSearch('search_by_date', {
    tags: 'show_hn', hitsPerPage: 40,
    numericFilters: `points>30,created_at_i>${secondsAgo(DISCOVERY_WINDOW_DAYS)}`,
  });
  return hits.filter((h) => h.title && h.url).slice(0, SHOWHN_LIMIT).map((h) => toPost(h, 'showhn'));
}

async function fetchLaunchHN() {
  const hits = await hnSearch('search_by_date', {
    tags: 'launch_hn', hitsPerPage: 20,
    numericFilters: `points>20,created_at_i>${secondsAgo(DISCOVERY_WINDOW_DAYS)}`,
  });
  return hits.filter((h) => h.title).slice(0, LAUNCHHN_LIMIT).map((h) => toPost(h, 'launchhn'));
}

async function fetchFrontPageReleases() {
  const hits = await hnSearch('search_by_date', {
    tags: 'front_page', hitsPerPage: 100,
    numericFilters: `points>50,created_at_i>${secondsAgo(FRONTPAGE_WINDOW_DAYS)}`,
  });
  return hits
    .filter((h) => h.title && h.url && !/^(Show|Launch|Ask) HN/i.test(h.title))
    .filter((h) => /^https:\/\/github\.com\//.test(h.url) || RELEASE.test(h.title))
    .sort((a, b) => b.points - a.points)
    .slice(0, FRONTPAGE_LIMIT)
    .map((h) => toPost(h, 'hn'));
}

/* ---------------------------------------------------------------------------
 * Lobsters: its `show` tag is the same kind of item as Show HN, from a smaller,
 * more technical crowd, so it joins the log.
 * ------------------------------------------------------------------------- */
const LOBSTERS_LIMIT = 4;
const LOBSTERS_MIN_SCORE = 8;

async function lobsters(path) {
  const res = await fetch(`https://lobste.rs/${path}`, HN_HEADERS);
  if (!res.ok) throw new Error(`lobsters ${path} ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchLobstersShow() {
  const cutoff = Date.now() - DISCOVERY_WINDOW_DAYS * 86400_000;
  return (await lobsters('t/show.json'))
    .filter((s) => s.title && s.url && s.score >= LOBSTERS_MIN_SCORE && Date.parse(s.created_at) > cutoff)
    .sort((a, b) => b.score - a.score)
    .slice(0, LOBSTERS_LIMIT)
    .map((s) => ({
      source: 'lobsters',
      title: s.title,
      url: s.url,
      points: s.score,
      comments: s.comment_count ?? 0,
      discussion: s.comments_url,
      created: new Date(s.created_at).toISOString(),
    }));
}

/* ---------------------------------------------------------------------------
 * Reading (/reading): what developers are reading today — articles and news,
 * which the log deliberately leaves out. Replaced whole on every run and never
 * archived; yesterday's headlines are not worth keeping.
 * ------------------------------------------------------------------------- */
const READING_LIMIT = 10;
// Listicles and roundups: "7 Best AI Tools for …", "Top 10 …".
const LISTICLE = /^\s*(the\s+)?(\d+|top \d+)\s+(best|top|must|essential|ways|tips|tools|free)\b|\btop \d+\b/i;

async function fetchReadingHN() {
  const hits = await hnSearch('search', { tags: 'front_page', hitsPerPage: 30 });
  return hits
    .filter((h) => h.title)
    .sort((a, b) => b.points - a.points)
    .slice(0, READING_LIMIT)
    .map((h) => ({
      title: h.title,
      url: h.url || discussionUrl(h),
      points: h.points,
      comments: h.num_comments ?? 0,
      discussion: discussionUrl(h),
    }));
}

async function fetchReadingLobsters() {
  return (await lobsters('hottest.json')).slice(0, READING_LIMIT).map((s) => ({
    title: s.title,
    url: s.url || s.comments_url,
    points: s.score,
    comments: s.comment_count ?? 0,
    discussion: s.comments_url,
    tags: s.tags ?? [],
  }));
}

async function fetchReadingDevTo() {
  const res = await fetch('https://dev.to/api/articles?top=1&per_page=30', HN_HEADERS);
  if (!res.ok) throw new Error(`dev.to ${res.status} ${res.statusText}`);
  return (await res.json())
    .filter((a) => a.title && !LISTICLE.test(a.title))
    .sort((a, b) => b.positive_reactions_count - a.positive_reactions_count)
    .slice(0, READING_LIMIT)
    .map((a) => ({
      title: a.title,
      url: a.url,
      points: a.positive_reactions_count,
      comments: a.comments_count ?? 0,
      discussion: a.url,
      tags: (a.tag_list ?? []).slice(0, 3),
    }));
}

/* ---------------------------------------------------------------------------
 * Deep dives (/deep-dives): engineering writing on architecture, reliability,
 * databases and distributed systems. Company blogs mix these with launches and
 * hiring posts, and only reading the article tells them apart, so this step
 * only gathers candidates. The curation run on the VPS reads each one and
 * decides what the page shows.
 * ------------------------------------------------------------------------- */
const DEEP_DIVE_FEEDS = [
  ['Cloudflare', 'https://blog.cloudflare.com/rss/'],
  ['Netflix', 'https://netflixtechblog.com/feed'],
  ['Discord', 'https://discord.com/blog/rss.xml'],
  ['Stripe', 'https://stripe.com/blog/feed.rss'],
  ['Slack', 'https://slack.engineering/feed/'],
  ['Dropbox', 'https://dropbox.tech/feed'],
  ['GitHub', 'https://github.blog/engineering/feed/'],
  ['Figma', 'https://www.figma.com/blog/feed/atom.xml'],
  ['Shopify', 'https://shopify.engineering/blog.atom'],
  ['Meta', 'https://engineering.fb.com/feed/'],
  ['Pinterest', 'https://medium.com/feed/pinterest-engineering'],
  ['Airbnb', 'https://medium.com/feed/airbnb-engineering'],
  ['AWS Architecture', 'https://aws.amazon.com/blogs/architecture/feed/'],
  ['Marc Brooker', 'https://brooker.co.za/blog/rss.xml'],
  ['Martin Kleppmann', 'https://martin.kleppmann.com/feed.rss'],
  ['Kyle Kingsbury', 'https://aphyr.com/posts.atom'],
  ['Murat Demirbas', 'https://muratbuffalo.blogspot.com/feeds/posts/default'],
  ['Dan Luu', 'https://danluu.com/atom.xml'],
];
// Candidates wait this long for a verdict before they are dropped unjudged.
const DEEP_DIVE_WINDOW_DAYS = 14;
const LOBSTERS_DEEP_TAGS = 'distributed,databases,performance,scaling,networking';
const LOBSTERS_DEEP_MIN_SCORE = 10;
const FEED_HEADERS = {
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; signals-feed/1.0; +https://signals.debasisnishank.com)' },
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeXml = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m);
const plain = (html) => decodeXml(decodeXml(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** RSS items and Atom entries, reduced to what the curation run needs. */
function parseFeed(xml) {
  return (xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? []).map((block) => {
    const tag = (name) => block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1];
    // Atom has several <link>s (Blogger adds replies/edit/self); want the page.
    const links = [...block.matchAll(/<link\b([^>]*?)\/?>/g)].map((m) => ({
      rel: m[1].match(/rel=["']([^"']+)/)?.[1] ?? 'alternate',
      href: m[1].match(/href=["']([^"']+)/)?.[1],
    }));
    const url = links.find((l) => l.href && l.rel === 'alternate')?.href ?? tag('link')?.trim();
    const date = tag('pubDate') ?? tag('published') ?? tag('dc:date') ?? tag('updated');
    return {
      title: plain(tag('title') ?? ''),
      url: url && decodeXml(url).trim(),
      published: date && !isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
      summary: plain(tag('description') ?? tag('summary') ?? tag('content') ?? '').slice(0, 400),
    };
  });
}

async function fetchDeepDives() {
  const cutoff = Date.now() - DEEP_DIVE_WINDOW_DAYS * 86400_000;
  const found = [];
  const failed = [];
  await Promise.all(DEEP_DIVE_FEEDS.map(async ([source, url]) => {
    try {
      const res = await fetch(url, { ...FEED_HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      for (const item of parseFeed(await res.text())) {
        if (item.title && item.url && item.published && Date.parse(item.published) > cutoff) {
          found.push({ source, ...item });
        }
      }
    } catch {
      failed.push(source);
    }
  }));
  if (failed.length) warn(`deep-dive feeds failed: ${failed.join(', ')}; the rest still count.`);

  // Lobsters' systems tags surface good writing from blogs not listed above.
  const stories = await lobsters(`t/${LOBSTERS_DEEP_TAGS}.json`);
  for (const s of stories) {
    if (s.url && s.score >= LOBSTERS_DEEP_MIN_SCORE && Date.parse(s.created_at) > cutoff) {
      found.push({
        source: 'Lobsters', title: s.title, url: s.url, discussion: s.comments_url,
        published: new Date(s.created_at).toISOString(), summary: '',
      });
    }
  }
  return found;
}

/** The best-received HN thread linking to a repository, if one did well. */
async function findDiscussion(repoUrl) {
  const hits = await hnSearch('search', {
    query: repoUrl, restrictSearchableAttributes: 'url', tags: 'story', hitsPerPage: 10,
  });
  const base = normUrl(repoUrl);
  const best = hits
    .filter((h) => h.url && (normUrl(h.url) === base || normUrl(h.url).startsWith(base + '/')))
    .sort((a, b) => b.points - a.points)[0];
  if (!best || best.points < 20) return null;
  return { points: best.points, comments: best.num_comments ?? 0, url: discussionUrl(best) };
}

/* ---------------------------------------------------------------------------
 * Dated archive.
 *
 * The search window is rolling, so a repo drops out after three weeks even
 * though it was a real find. The archive records each item under the date it
 * FIRST appeared and keeps it there permanently, which is what makes this a log
 * rather than a leaderboard — and it gives "new today" and star deltas for free.
 *
 * This only accumulates because CI commits the data back; a fresh checkout each
 * build would otherwise start from whatever is in the repo.
 * ------------------------------------------------------------------------- */
const ARCHIVE_DAYS = 120;

function mergeArchive(archive, today, repos, posts) {
  const seen = archive.repos ?? {};
  const seenPosts = archive.posts ?? {};

  for (const r of repos) {
    const prev = seen[r.name];
    if (prev) {
      // Already known: refresh the mutable fields, keep the discovery date.
      prev.stars = r.stars;
      prev.description = r.description ?? prev.description;
      prev.language = r.language ?? prev.language;
      if (r.hn) prev.hn = r.hn;
      prev.lastSeen = today;
    } else {
      const { hn, ...rest } = r;
      seen[r.name] = { ...rest, ...(hn && { hn }), firstSeen: today, lastSeen: today, starsAtFirstSeen: r.stars };
    }
  }

  for (const h of posts) {
    const key = h.discussion || h.url;
    const prev = seenPosts[key];
    if (prev) {
      prev.points = h.points;
      prev.comments = h.comments;
      prev.lastSeen = today;
    } else {
      seenPosts[key] = { ...h, firstSeen: today, lastSeen: today };
    }
  }

  // Keep the file from growing without bound.
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400_000).toISOString().slice(0, 10);
  const prune = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.firstSeen >= cutoff));

  return { repos: prune(seen), posts: prune(seenPosts) };
}

let raw = '';
try { raw = readFileSync(CACHE_PATH, 'utf8'); } catch {}
const cache = readCache();
const now = new Date().toISOString();
let degraded = 0;

// Each source stands alone: one failing API costs only its own items for the
// day, and the archive keeps everything it already had.
async function collect(label, fn) {
  try {
    const items = await fn();
    console.log(`  ok  ${label}: ${items.length} item(s)`);
    return items;
  } catch (err) {
    degraded++;
    warn(`${label} fetch failed (${err.message}); nothing new from it today.`);
    return [];
  }
}

const repos = await collect('github repos', fetchRepos);
const posts = [
  ...(await collect('show hn', fetchShowHN)),
  ...(await collect('launch hn', fetchLaunchHN)),
  ...(await collect('hn front-page releases', fetchFrontPageReleases)),
  ...(await collect('lobsters show', fetchLobstersShow)),
];

// A repo that made HN gets a link to the thread rather than a second entry.
let lookupFailed = false;
for (const r of repos) {
  try {
    const hn = await findDiscussion(r.url);
    if (hn) r.hn = hn;
  } catch (err) {
    lookupFailed = true;
  }
}
if (lookupFailed) warn('some HN discussion lookups failed; those repos keep their earlier links.');

const repoUrls = new Set(
  [...Object.values(cache.archive?.repos ?? {}), ...repos].map((r) => normUrl(r.url)),
);
const isLoggedRepo = (u) => [...repoUrls].some((base) => normUrl(u) === base || normUrl(u).startsWith(base + '/'));
const newPosts = posts.filter((p) => p.source !== 'hn' || !isLoggedRepo(p.url));

if (repos.length || newPosts.length) {
  const data = { repos, posts: newPosts };
  const changed = ['repos', 'posts'].some((f) => JSON.stringify(cache.tech?.[f]) !== JSON.stringify(data[f]));
  if (changed) cache.tech = { fetchedAt: now, ...data };

  const count = (a) => Object.keys(a?.repos ?? {}).length + Object.keys(a?.posts ?? {}).length;
  const had = count(cache.archive);
  cache.archive = mergeArchive(cache.archive ?? {}, now.slice(0, 10), repos, newPosts);
  console.log(
    `  ok  archive: ${Object.keys(cache.archive.repos).length} repo(s), ` +
    `${Object.keys(cache.archive.posts).length} post(s) — ${count(cache.archive) - had} new today`,
  );
} else {
  warn(`every source failed; serving the archive as of ${cache.tech?.fetchedAt ?? 'an earlier build'}.`);
}

// Reading is all-or-nothing per source: a failed source keeps yesterday's list
// rather than leaving its column empty.
const reading = {
  hn: await collect('reading: hn front page', fetchReadingHN),
  lobsters: await collect('reading: lobsters', fetchReadingLobsters),
  devto: await collect('reading: dev.to', fetchReadingDevTo),
};
const prevReading = cache.reading ?? {};
cache.reading = { fetchedAt: prevReading.fetchedAt ?? null };
for (const [k, items] of Object.entries(reading)) {
  cache.reading[k] = items.length ? items : prevReading[k] ?? [];
}
if (Object.values(reading).some((items) => items.length)) cache.reading.fetchedAt = now;

// Deep-dive candidates accumulate until they age out of the window; the
// curation run on the VPS judges each once and keeps its own record.
const deepDives = await collect('deep dives', fetchDeepDives);
const prevDeep = cache.deepdives?.candidates ?? {};
const deepCutoff = new Date(Date.now() - DEEP_DIVE_WINDOW_DAYS * 86400_000).toISOString();
const candidates = Object.fromEntries(Object.entries(prevDeep).filter(([, c]) => c.published >= deepCutoff));
for (const d of deepDives) candidates[normUrl(d.url)] ??= d;
cache.deepdives = { fetchedAt: deepDives.length ? now : cache.deepdives?.fetchedAt ?? null, candidates };
console.log(`  ok  deep dives: ${Object.keys(candidates).length} candidate(s) in the window`);

// CI owns this file: it commits the refreshed cache back after every run, so a
// local build that also wrote it would conflict on the next pull for no gain —
// the page renders from the in-memory data either way. Set PERSIST_FEEDS=1 to
// override (e.g. to seed or repair the archive by hand).
const persist = process.env.GITHUB_ACTIONS === 'true' || process.env.PERSIST_FEEDS === '1';
if (!persist) {
  console.log('  --  local run: rendering with fresh data, leaving the cache file alone');
} else if (JSON.stringify(cache, null, 2) + '\n' !== raw) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

console.log(degraded ? '\nfeeds: degraded — some sources failed, build continues.\n'
                     : '\nfeeds: fresh.\n');
