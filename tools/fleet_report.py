#!/usr/bin/env python3
"""Fleet health snapshot for a given window, straight from journald + the ledger.

Reports only what it can actually count. A metric it cannot read is reported as
unavailable rather than zero, because "0 attacks" and "could not read attacks"
mean opposite things when deciding whether the fleet is healthy.

Usage: fleet_report.py [minutes]
"""
import collections
import json
import subprocess
import sys
import time

WINDOW_MIN = int(sys.argv[1]) if len(sys.argv) > 1 else 120
LEDGER = "/root/relic-bot/data/ledger.jsonl"
COMBAT = "/root/relic-bot/data/combat_memory.json"


def journal(window_min):
    try:
        out = subprocess.run(
            ["journalctl", "-u", "relic-bot.service", "--since",
             f"{window_min} min ago", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=120,
        )
        return out.stdout
    except Exception as exc:  # noqa: BLE001 - a broken read must not fake a result
        print(f"journal unavailable: {exc}", file=sys.stderr)
        return None


def main():
    log = journal(WINDOW_MIN)
    lines = [] if log is None else log.splitlines()

    counts = {
        "attacks": sum("tick: attacking" in l for l in lines),
        "joins": sum(("in dungeon" in l or "run ended" in l) for l in lines),
        "denials": sum("high_demand" in l for l in lines),
        "deaths": sum("hero died" in l for l in lines),
        "descends": sum("descended to the next floor" in l for l in lines),
        "potions": sum("drink" in l for l in lines),
        "equips": sum("upkeep: equip" in l for l in lines),
        "listings": sum("listed" in l.lower() for l in lines),
    }
    wallets_alive = len({l.split("acct:wallet-")[1][:2]
                         for l in lines if "acct:wallet-" in l})

    ledger_events, ledger_wallets = None, {}
    try:
        cutoff = time.time() * 1000 - WINDOW_MIN * 60_000
        w = collections.Counter()
        with open(LEDGER) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("ts", 0) >= cutoff:
                    w[e.get("accountId", "?")] += 1
        ledger_events, ledger_wallets = sum(w.values()), dict(sorted(w.items()))
    except OSError as exc:
        print(f"ledger unavailable: {exc}", file=sys.stderr)

    wins = losses = None
    try:
        with open(COMBAT) as fh:
            data = json.load(fh)
        wins = sum(s["wins"] for m in data.values() for s in m.values())
        losses = sum(s["losses"] for m in data.values() for s in m.values())
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"combat memory unavailable: {exc}", file=sys.stderr)

    print(f"FLEET REPORT — last {WINDOW_MIN} min")
    print(f"journal: {'ok' if log is not None else 'UNAVAILABLE'}")
    print(f"wallets seen alive: {wallets_alive}")
    for k, v in counts.items():
        print(f"{k}: {v}")
    print(f"ledger events: {ledger_events if ledger_events is not None else 'UNAVAILABLE'}")
    print(f"ledger wallets: {ledger_wallets}")
    if wins is not None and losses is not None:
        total = wins + losses
        rate = f"{wins / total * 100:.1f}%" if total else "n/a"
        print(f"combat lifetime: wins={wins} losses={losses} winrate={rate}")


if __name__ == "__main__":
    main()
