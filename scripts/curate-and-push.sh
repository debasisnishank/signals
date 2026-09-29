#!/usr/bin/env bash
# Daily curation run on the VPS: bring the clone up to date with the morning's
# CI collection, pick the day's highlights, and push only curated.json.
#
# Scheduled by a systemd timer (signals-curate.timer) at 06:30 UTC, after the
# 06:00 CI run. The push goes through a write-enabled deploy key for this repo
# alone, and triggers a normal site deploy.
#
# The model reads untrusted READMEs and comments, so it runs as the `curator`
# user, which cannot read /root and with it the deploy key. Git stays with root.
set -euo pipefail

cd "$(dirname "$0")/.."

git fetch -q origin main
git reset -q --hard origin/main

out=$(mktemp)
chown curator "$out"
trap 'rm -f "$out"' EXIT
runuser -u curator -- env HOME=/home/curator CURATED_OUT="$out" node scripts/curate.mjs

if [ ! -s "$out" ]; then
  echo "No new picks."
  exit 0
fi
cp "$out" src/data/curated.json

if [ -z "$(git status --porcelain src/data/curated.json)" ]; then
  echo "No new picks."
  exit 0
fi

git add src/data/curated.json
git commit -q -m "Curate picks for $(date -u +%Y-%m-%d)"
# CI may have logged discoveries meanwhile; it never touches curated.json.
git pull -q --rebase origin main
git push -q origin HEAD:main
echo "Pushed picks."
