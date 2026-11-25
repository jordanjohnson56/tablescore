#!/usr/bin/env bash
# Sync the watchlist export into the private repo the monthly routine reads (ADR 0001).
#
#   scripts/sync-watchlist.sh [path/to/watchlist-repo]
#
# Pulls the private repo, exports the watchlist from the running Tablescore
# container (no Node needed on the host), and commits watchlist.json only if a
# game or setting changed since the last commit (not the file on disk, which a
# failed commit can leave behind). Then pushes whenever the branch is ahead of
# its upstream, so a commit left by a failed push goes out on the next run.
# Exits 0 only when the upstream holds a current export. One run at a time per
# clone: a second run stops at once with an error. Works from any directory,
# and through a symlink (e.g. ~/.local/bin/sync-watchlist).
#
# Settings (environment):
#   WATCHLIST_REPO  clone of the private repo (default ~/tablescore-watchlist).
#                   Also read from this checkout's .env; the environment wins
#                   over .env, and the first argument wins over both
#   DOCKER          docker command (default docker; e.g. "sudo docker")
#   REFRESH_DAYS    commit anyway once the committed exportedAt is this many
#                   days old (default 30), so the routine, which flags exports
#                   over 45 days old as stale, never sees a false stale warning
set -euo pipefail

die() { echo "sync-watchlist: $*" >&2; exit 1; }

app_dir=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
# Only this one line of .env is read; .env holds secrets and isn't shell syntax.
env_repo=$(sed -n 's/^WATCHLIST_REPO=//p' "$app_dir/.env" 2>/dev/null | tail -n1 | sed 's/^["'"'"']//; s/["'"'"']$//')
repo=${1:-${WATCHLIST_REPO:-${env_repo:-$HOME/tablescore-watchlist}}}
repo=${repo/#\~/$HOME}
docker_cmd=${DOCKER:-docker}

echo "$(date '+%F %T') sync-watchlist"
[ -d "$repo/.git" ] || die "$repo is not a git clone (set WATCHLIST_REPO or pass the path)"

# One run at a time per clone. The lock file lives in .git, so it is never
# tracked; the lock goes when this process (and anything holding fd 9) ends.
command -v flock >/dev/null || die "flock not found (it is part of util-linux)"
exec 9>"$repo/.git/sync-watchlist.lock"
flock -n 9 || die "another sync is running in $repo"

# Everything but exportedAt, which changes on every export. Comparing on this
# keeps a cron job from committing every day when nothing changed.
content() { grep -v '^  "exportedAt": ' "$1" || true; }
# Age in whole days of a file's exportedAt; a huge number if it can't be read.
age_days() {
  local ts
  ts=$(sed -n 's/^  "exportedAt": "\(.*\)",$/\1/p' "$1" | head -n1)
  # GNU date reads "" as midnight today, so a missing line needs its own check.
  [ -n "$ts" ] || { echo 99999; return; }
  ts=$(date -d "$ts" +%s 2>/dev/null) || { echo 99999; return; }
  echo $(( ($(date +%s) - ts) / 86400 ))
}
refresh_days=${REFRESH_DAYS:-30}

tmp=$(mktemp)
committed=$(mktemp)
trap 'rm -f "$tmp" "$committed"' EXIT

echo "Pulling $repo"
git -C "$repo" pull --no-rebase --no-edit --quiet || die "git pull failed in $repo; fix it there and rerun"
# Compare with the last commit, not the working tree: a failed commit leaves
# the new export on disk, and a failed push leaves it committed but unpushed.
has_committed=yes
git -C "$repo" show HEAD:watchlist.json >"$committed" 2>/dev/null || has_committed=

echo "Exporting from the Tablescore container"
# shellcheck disable=SC2086  # DOCKER may hold more than one word
(cd "$app_dir" && $docker_cmd compose exec -T tablescore node --disable-warning=ExperimentalWarning server/export-watchlist.js -) >"$tmp" \
  || die "export failed; is the container up? (cd $app_dir && docker compose ps)"

# The export is pretty-printed JSON from JSON.stringify; check it is whole.
head -c1 "$tmp" | grep -q '{' && tail -n1 "$tmp" | grep -qx '}' \
  && grep -q '^  "exportedAt": ' "$tmp" && grep -q '^  "games": ' "$tmp" \
  || die "export didn't look like a watchlist (first line: $(head -n1 "$tmp" | cut -c1-80))"

target="$repo/watchlist.json"
commit=yes
if [ -n "$has_committed" ] && [ "$(content "$committed")" = "$(content "$tmp")" ]; then
  age=$(age_days "$committed")
  if [ "$age" -lt "$refresh_days" ]; then
    commit=
  else
    echo "No changes, but the committed export is $age days old; refreshing exportedAt."
  fi
fi

if [ -n "$commit" ]; then
  cp "$tmp" "$target"
  git -C "$repo" add watchlist.json
  git -C "$repo" commit --quiet -m "Watchlist $(date +%F)" \
    || die "commit failed in $repo; fix it there and rerun"
elif [ -n "$(git -C "$repo" status --porcelain -- watchlist.json)" ]; then
  # The export matches HEAD, so a changed file on disk is a leftover (e.g. from
  # a failed commit); put it back so the clone ends clean.
  git -C "$repo" checkout --quiet HEAD -- watchlist.json
  echo "Put back a leftover watchlist.json that matched the last commit."
fi

ahead=$(git -C "$repo" rev-list --count '@{upstream}..HEAD' 2>/dev/null) \
  || die "can't compare $repo with its upstream branch"
if [ "$ahead" -eq 0 ]; then
  echo "No changes; the committed export is $age days old. Nothing to commit."
  exit 0
fi
if [ -n "$commit" ]; then
  echo "Pushing"
else
  echo "Nothing new to commit; pushing $ahead unpushed commit(s)"
fi
git -C "$repo" push --quiet || die "push failed; the commit is in $repo, and the next run pushes it"
echo "Synced $(grep -c '^      "name": ' "$target") watched games to $(git -C "$repo" remote get-url origin)"
