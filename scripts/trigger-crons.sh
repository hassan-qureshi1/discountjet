#!/usr/bin/env bash
#
# Fire the Worker's cron triggers against the LOCAL dev server.
#
# Cloudflare only runs cron triggers on a deployed Worker — `wrangler dev` and
# the Vite plugin never fire `scheduled()` on a timer, so locally nothing
# happens no matter how long you wait. This script pokes the handler by hand.
#
#   ./scripts/trigger-crons.sh                 # every cron below, in order
#   ./scripts/trigger-crons.sh bundle-schedule # just one, by name
#   ./scripts/trigger-crons.sh --list          # show what's registered here
#   ./scripts/trigger-crons.sh --watch         # every 5 min, like production
#
# A pass always runs against the REAL clock. The handler's `scheduledTime`
# cannot be overridden locally — passing one is accepted and then ignored, so
# this script deliberately offers no "pretend it is later" flag. To exercise a
# boundary, set the bundle's window a minute or two out and trigger again.
#
# Env:
#   BASE_URL   dev server origin (default http://localhost:5173)
#
set -euo pipefail

# ─── The crons ──────────────────────────────────────────────────────────────
#
# One entry per cron expression in `wrangler.jsonc`. A Worker has a SINGLE
# `scheduled()` handler; multiple triggers are told apart by `controller.cron`,
# which is why the expression is what gets passed through rather than a path.
#
# Adding a cron: add its expression to `triggers.crons` in wrangler.jsonc,
# branch on `controller.cron` in src/index.ts, then add a line here.
#
#   name|cron expression|what it does
#
CRONS=(
  "bundle-schedule|*/5 * * * *|Bring due bundles live, take expired ones down"
)

# ─── Args ───────────────────────────────────────────────────────────────────
BASE_URL="${BASE_URL:-http://localhost:5173}"
ENDPOINT="/cdn-cgi/handler/scheduled"
WANTED=""
WATCH=0
WATCH_INTERVAL="${WATCH_INTERVAL:-300}"

while [ $# -gt 0 ]; do
  case "$1" in
    --list)
      printf '%-20s %-16s %s\n' "NAME" "SCHEDULE" "DESCRIPTION"
      for entry in "${CRONS[@]}"; do
        IFS='|' read -r name expr desc <<< "$entry"
        printf '%-20s %-16s %s\n' "$name" "$expr" "$desc"
      done
      exit 0
      ;;
    --watch)
      WATCH=1
      shift
      ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "unknown option: $1 (try --help)" >&2
      exit 2
      ;;
    *)
      WANTED="$1"
      shift
      ;;
  esac
done

# ─── Preflight ──────────────────────────────────────────────────────────────
if ! curl -sf -o /dev/null --max-time 5 "${BASE_URL}/health"; then
  echo "✗ No dev server at ${BASE_URL} — start it with 'npm run dev' (or set BASE_URL)." >&2
  exit 1
fi

if [ -n "$WANTED" ]; then
  found=0
  for entry in "${CRONS[@]}"; do
    IFS='|' read -r name _ _ <<< "$entry"
    [ "$WANTED" = "$name" ] && found=1
  done
  if [ "$found" -eq 0 ]; then
    echo "✗ No cron named '${WANTED}'. Try --list." >&2
    exit 2
  fi
fi

# ─── Fire ───────────────────────────────────────────────────────────────────
run_once() {
  local ran=0 failed=0

  for entry in "${CRONS[@]}"; do
    IFS='|' read -r name expr desc <<< "$entry"
    [ -n "$WANTED" ] && [ "$WANTED" != "$name" ] && continue

    printf '→ %-20s %s\n' "$name" "$desc"

    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 -G \
      "${BASE_URL}${ENDPOINT}" --data-urlencode "cron=${expr}" || echo "000")
    ran=$((ran + 1))

    if [ "$code" = "200" ]; then
      echo "  ✓ handler ran (HTTP ${code})"
    else
      echo "  ✗ HTTP ${code}" >&2
      failed=$((failed + 1))
    fi
  done

  # `scheduled()` wraps its work in ctx.waitUntil, so a 200 means the handler
  # was ENTERED, not that the pass finished. Give the async work a moment to
  # land before anyone reads the database on their next line.
  sleep 2

  echo "  fired ${ran}, ${failed} failed  ($(date -u +%H:%M:%SZ))"
  return "$failed"
}

if [ "$WATCH" -eq 1 ]; then
  echo "Watching: firing every ${WATCH_INTERVAL}s — Ctrl-C to stop."
  while true; do
    run_once || true
    sleep "$WATCH_INTERVAL"
  done
fi

run_once || exit 1

echo
echo "A 200 only means the handler was entered — check the dev-server console"
echo "for what the pass did, and the database for the rows it touched."
