#!/usr/bin/env bash
# Sync the watchlist export into the private repo the monthly routine reads (ADR 0001).
#
#   scripts/sync-watchlist.sh [path/to/watchlist-repo]
#
# Pulls the private repo, exports the watchlist from the running Tablescore
# container (no Node needed on the host), and commits and pushes watchlist.json
# only if a game or setting changed. Works from any directory, and through a
# symlink (e.g. ~/.local/bin/sync-watchlist).
#
# Settings (environment):
#   WATCHLIST_REPO  clone of the private repo (default ~/tablescore-watchlist);
#                   the first argument wins over it
#   DOCKER          docker command (default docker; e.g. "sudo docker")
#   REFRESH_DAYS    commit anyway once the committed exportedAt is this many
#                   days old (default 30), so the routine, which flags exports
#                   over 45 days old as stale, never sees a false stale warning
set -euo pipefail

die() { echo "sync-watchlist: $*" >&2; exit 1; }

app_dir=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
repo=${1:-${WATCHLIST_REPO:-$HOME/tablescore-watchlist}}
docker_cmd=${DOCKER:-docker}

[ -d "$repo/.git" ] || die "$repo is not a git clone (set WATCHLIST_REPO or pass the path)"

# Everything but exportedAt, which changes on every export. Comparing on this
# keeps a cron job from committing every day when nothing changed.
content() { grep -v '^  "exportedAt": ' "$1" || true; }
# Age in whole days of a file's exportedAt; a huge number if it can't be read.
age_days() {
  local ts
  ts=$(sed -n 's/^  "exportedAt": "\(.*\)",$/\1/p' "$1" | head -n1)
  ts=$(date -d "$ts" +%s 2>/dev/null) || { echo 99999; return; }
  echo $(( ($(date +%s) - ts) / 86400 ))
}
refresh_days=${REFRESH_DAYS:-30}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

echo "Pulling $repo"
git -C "$repo" pull --no-rebase --quiet || die "git pull failed in $repo; fix it there and rerun"

echo "Exporting from the Tablescore container"
# shellcheck disable=SC2086  # DOCKER may hold more than one word
(cd "$app_dir" && $docker_cmd compose exec -T tablescore node --disable-warning=ExperimentalWarning server/export-watchlist.js -) >"$tmp" \
  || die "export failed; is the container up? (cd $app_dir && docker compose ps)"

# The export is pretty-printed JSON from JSON.stringify; check it is whole.
head -c1 "$tmp" | grep -q '{' && tail -n1 "$tmp" | grep -qx '}' \
  && grep -q '^  "exportedAt": ' "$tmp" && grep -q '^  "games": ' "$tmp" \
  || die "export didn't look like a watchlist (first line: $(head -n1 "$tmp" | cut -c1-80))"

target="$repo/watchlist.json"
if [ -f "$target" ] && [ "$(content "$target")" = "$(content "$tmp")" ]; then
  age=$(age_days "$target")
  if [ "$age" -lt "$refresh_days" ]; then
    echo "No changes; the committed export is $age days old. Nothing to commit."
    exit 0
  fi
  echo "No changes, but the committed export is $age days old; refreshing exportedAt."
fi

cp "$tmp" "$target"
git -C "$repo" add watchlist.json
git -C "$repo" commit --quiet -m "Watchlist $(date +%F)"
echo "Pushing"
git -C "$repo" push --quiet || die "push failed; the commit is in $repo, push it from there"
echo "Synced $(grep -c '^      "name": ' "$target") watched games to $(git -C "$repo" remote get-url origin)"
