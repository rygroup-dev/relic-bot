#!/usr/bin/env bash
# Samples fleet health at a fixed interval and writes one row per sample.
# Everything here is read-only: it never touches the game or the wallets.
set -uo pipefail

DATA=/root/relic-bot/data
OUT="${1:-/tmp/relic-monitor.log}"
SAMPLES="${2:-12}"
INTERVAL="${3:-300}"
SINCE="$(date -u +%H:%M:%S)"

battles() {
  python3 - "$DATA/combat_memory.json" <<'PY' 2>/dev/null || echo 0
import json,sys
try:
    d=json.load(open(sys.argv[1]))
    print(sum(sum(m['battles'] for m in v.values()) for v in d.values()))
except Exception: print(0)
PY
}

ledger_rows() { wc -l < "$DATA/ledger.jsonl" 2>/dev/null || echo 0; }

{
  echo "monitor started $(date -u +%FT%TZ)  samples=$SAMPLES interval=${INTERVAL}s"
  echo "ts_utc            battles ledger dungeons deaths ratelimit parks producing silence recovered notifs"
} > "$OUT"

for i in $(seq 1 "$SAMPLES"); do
  TS="$(date -u +%H:%M:%S)"
  B="$(battles)"
  L="$(ledger_rows)"
  D="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'joined dungeon')"
  X="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'hero died')"
  R="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'rate_limited')"
  P="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'parked')"
  W="$(python3 - "$DATA/ledger.jsonl" <<'PY' 2>/dev/null || echo 0
import json,sys,time
now=time.time()*1000; s=set()
try:
    for l in open(sys.argv[1]):
        l=l.strip()
        if not l: continue
        e=json.loads(l)
        if now-e['ts'] < 600000: s.add(e['accountId'])
except Exception: pass
print(len(s))
PY
)"
  # Notification-side counters: an operator needs to know the alarms fired,
  # not just that the fleet was quiet.
  S="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'produced NOTHING')"
  V="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'notify: .*producing again')"
  N="$(journalctl -u relic-bot --since "$SINCE" --no-pager 2>/dev/null | grep -c 'notify:')"
  printf '%s  %7s %6s %8s %6s %9s %5s %9s %7s %9s %6s\n' \
    "$TS" "$B" "$L" "$D" "$X" "$R" "$P" "$W" "$S" "$V" "$N" >> "$OUT"
  [ "$i" -lt "$SAMPLES" ] && sleep "$INTERVAL"
done
echo "monitor finished $(date -u +%FT%TZ)" >> "$OUT"
