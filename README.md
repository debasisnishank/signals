# signals.debasisnishank.com

A daily feed of newly released open source worth a look: repositories that broke
out in the last three weeks, and tools people shipped on Show HN.

## How it works

`scripts/refresh-feeds.mjs` runs before `astro build` and writes
`src/data/feed-cache.json`. The page imports that JSON and performs no network
I/O, so a rendering build cannot fail or go blank because an API is down — a
failed fetch keeps the previous cached values and emits a warning annotation
instead.

GitHub Actions rebuilds daily at 06:00 UTC. The only credential is the workflow's
own `GITHUB_TOKEN`, used to raise the search API rate limit.

## Filtering

Star charts are dominated by reading lists, roadmaps and interview prep, which
are popular but are not discoveries, so those are dropped rather than
down-ranked. Also dropped: descriptions that are mostly non-latin, and ones
selling rather than describing (pasted landing pages, price lists). Very short
descriptions are cut unless the repo is popular enough that terseness isn't the
signal.

## Local

```sh
npm install
npm run build     # refresh feeds, then build
npm run dev
```

Styling is deliberately standalone rather than copied from the main site — same
design tokens, only the lines this page needs. See `public/assets/css/site.css`.
