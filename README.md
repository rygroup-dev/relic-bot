# relic-bot

Multi-account automation fleet for **[playrelic.gg](https://playrelic.gg)** — an
isometric dungeon-crawler MMO on Solana — with an optional LLM decision layer
("Otak") and a structural payment lock.

TypeScript · Node ≥ 22 · Colyseus `0.16.22` (pinned to the live client) · SPL Token-2022

---

## The one thing to understand first

There are two separate signing surfaces, and the split is the whole design.

**The game path cannot sign a transaction at all.** Gameplay travels over a
WebSocket and needs no signature; selling on the marketplace is REST + Bearer
and needs no signature. `src/wallet/signer.ts` exports exactly one capability —
signing the game's four-line UTF-8 login message. It cannot buy anything, and
buying is not implemented anywhere.

**The treasury can sign, but only within your own fleet.** Consolidating
proceeds needs real transfers, so `src/wallet/treasury.ts` can build and sign
them — fenced by one invariant checked on every single transfer:

> **Funds may only move between wallets you control.**
>
> - sweep: any fleet wallet → the main account (any asset)
> - fund: the main account → any fleet wallet (SOL only, amount-capped)
>
> Any destination outside the loaded fleet is refused before a transaction is
> even built.

So a compromised process cannot send your money to an attacker. The worst it
can do is shuffle funds between your own wallets. That is weaker than "cannot
sign at all" — the trade was made deliberately to get sweeps — but it is not
weaker than any ordinary hot wallet.

Both properties are enforced by tests, not comments: one test asserts that
`treasury.ts` is the *only* module in `src/` capable of signing, another that
the gameplay loop never imports it, and sixteen more cover the transfer guard
itself.

---

## Before you install: three things that are true

**1. The Terms of Service prohibit this.** `/docs` §4, verbatim:

> "you agree not to exploit bugs or errors; use cheats, bots, automation, or
> unauthorized third-party software"

Enforcement is real and visible in the client: bans carry `reason`, `expiresAt`
and `permanent` flags; there is `deviceId` fingerprinting, server-side
`rate_limited`, and a `client_outdated` version check. The ban dialog reads
*"Repeating the offense from new accounts will result in a permanent ban."*
Multi-account risk is therefore **correlated** across a fleet on one host.

**2. There is no cashout.** All 37 REST endpoints were enumerated. Money flows
in via purchases; the only outbound path is another player buying your listing.
Profit means farming loot and selling it, minus the marketplace fee — not a
measurable gold/hour faucet.

**3. Items are not property.** ToS §6: in-game content carries *"no guarantee of
continued existence, availability, or value"*; all acquisitions are final with
no refunds. ToS §7 makes no commitment that any token will be supported.

None of this is a reason you cannot run it. It is the information you need to
decide whether you want to.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rygroup-dev/relic-bot/main/scripts/install.sh | bash
```

Then:

```bash
# one secret key file per account, chmod 600
echo '<base58-secret-key>' > /root/.relic-bot/keys/wallet-01.key
chmod 600 /root/.relic-bot/keys/wallet-01.key

cd /root/relic-bot
npm run ctl -- doctor      # config, key permissions, connectivity
npm run ctl -- wallets     # addresses + device ids
npm run ctl -- gate        # server token gate + on-chain RELIC balance

systemctl enable --now relic-bot
journalctl -u relic-bot -f
```

Key files accept a base58 secret key (what Phantom's "export private key"
gives) or a `solana-keygen` JSON array of 64 integers. The filename becomes the
account id. Permissions are **enforced**, not suggested: a world-readable key
file or key directory is a hard error.

---

## The Otak

Two layers, LLM on top of deterministic heuristics — never instead of them.

```
heuristics  ->  candidates (scored, validated)   always runs; no key needed
     v
Otak LLM    ->  re-ranks / vetoes                optional
     v
guardrail   ->  rejects anything not offered     final veto
```

The model may only return an `id` from the candidate list the heuristics
produced, or `null` to decline. Anything else is discarded and the heuristic
pick is used. **The LLM cannot invent an action, and cannot unlock a payment.**

With `OTAK_ENABLED=false`, or with no API key, or with every provider down, the
bot plays fully on heuristics.

### Judging whether the brain earns its cost

`/decisions` shows what Otak actually did, against what the heuristics would
have chosen on their own:

```
🔀 the model changed the outcome
✅ it agreed with the heuristics
⚙️ decided without the model at all
```

The **override rate** is the honest measure. A model that almost never moves
off the heuristic pick is spending tokens without changing behaviour, and that
is shown rather than hidden behind a green light. Guardrail rejections — the
model naming an option that was never offered — are counted separately; that
number staying at zero is the evidence the guardrail works.

Otak is only consulted when a wallet is actually playing and there are at least
two candidates to rank. A parked fleet shows no model decisions however the
switch is set.

**Providers:** OpenAI · Anthropic · Sakana Fugu — with health checks and
automatic fallback down the chain, then to pure heuristics. Configure at
runtime from Telegram:

```
/otak                     status + keys set
/otak key anthropic       then send the key; the bot deletes your message
/otak on | off
/health                   probe every configured provider
```

Keys are sealed with AES-256-GCM under a machine-local secret at 0600. An env
var always takes precedence over a stored key.

**Four domains:** economy & pricing · combat & build · progression · a safety
governor that watches the fleet's own behaviour.

---

## How it actually plays

Town is a social hub — its `mobs` collection is always empty. Everything worth
having is in dungeon rooms, reached through the lobby:

```
join town  →  walk to the trapdoor at (7,4)  →  lobby
           →  l.solo.enter  →  l.reservation  →  dungeon room
```

Entry is refused with `too_far` unless the hero is standing on the trapdoor, so
the bot BFS-paths there across the published town collision map first. Inside a
dungeon there is no collision map, so it steps toward the nearest living mob in
a straight line and lets the server correct it via `s.move.denied` rather than
inventing walls it cannot see.

### Signals

Most of what matters arrives on the `s.*` namespace, not in room state:

| Signal | Used for |
| --- | --- |
| `s.inv.sync` | the inventory — it is **not** in room state, and is sent once per run |
| `s.loot.gold`, `s.combat.xp`, `s.loot.pxp` | ledger entries from real gains |
| `s.combat.cdset` / `cdreduce` | actual ability cooldowns |
| `s.combat.telegraph` | incoming attack — roll out of it |
| `s.combat.death` | ours ends the run; anything else is a kill |
| `s.move.denied` | the server's own position correction |

Handlers attach *inside* the join, before it returns: the server pushes its
opening state burst the instant the seat reservation is consumed, and a
listener added afterwards misses all of it.

### Survival

A wipe forfeits the whole run's loot, so one more kill attempt costs far more
than it looks:

- below **45%** HP the bot stops picking fights
- below **35%** it drinks, or retreats from the nearest threat if it cannot
- a death exits the run rather than idling out the 20-minute budget
- a run producing nothing for five minutes is abandoned

## Economy model

Marketplace fee, from `/docs`: **10% for USDC listings, 5% for RELIC listings**,
seller-paid.

RELIC's lower fee is not free money — it is a volatile pump.fun asset against a
stablecoin. So the pricing engine compares *risk-adjusted* net:

```
net_usdc  = price × 0.90
net_relic = price × 0.95 × (1 − RELIC_VOLATILITY_DISCOUNT_PCT)
```

At the conservative 8% default, USDC wins (0.900 vs 0.874). Below roughly 5.26%
RELIC wins. That knob is yours: it encodes a judgement about risk appetite, so
it is configuration, not a hidden constant.

All money is handled as `bigint` micro-units. No monetary amount ever touches a
float.

### Token gate

`GET /api/token-gate/status` returns only `{ allowed: boolean }`. The threshold
is server-side and appears in **neither** the client bundle nor the docs — the
often-quoted "hold 10,000 RELIC" figure is unverified. This repo therefore
hardcodes no threshold: it reads the gate per wallet at runtime and reports what
the server actually answered. A gated wallet keeps farming; only market features
are skipped.

---

## Liveness: why "no errors" is not health

From a previous fleet: *signature failures produced "healthy but produces
nothing" ten times* — wallets sitting silent for thirteen hours at zero errors,
because a refused action looped forever without ever throwing.

So liveness here is measured by **output**, never by the absence of errors:

- last value timestamp per wallet in `data/ledger.jsonl`
- per-monster battle counters in `data/combat_memory.json`
- a watchdog that alerts when either stops advancing — *even at zero errors*

And every value-producing branch runs through one `free()` helper that checks
park state before invoking the body. There is no other path to doing work, so a
new branch **cannot** forget the check. Both properties are covered by
regression tests.

---

## Commands

```
# game
npm run ctl -- doctor                 full preflight
npm run ctl -- wallets                accounts and addresses
npm run ctl -- login                  authenticate every wallet
npm run ctl -- gate                   token gate per wallet
npm run ctl -- listings               current marketplace listings
npm run ctl -- ledger                 produced value per wallet

# wallet management
npm run ctl -- new [id]               generate a wallet + hero
npm run ctl -- new --count N          up to 10 wallets, each with a hero
npm run ctl -- onboard                hero for every character-less wallet
npm run ctl -- import <key> [id]      import a base58 or JSON key
npm run ctl -- export <id>            print as solana-keygen JSON (SECRET)
npm run ctl -- main [id]              show or set the main account

# treasury — dry run by default
npm run ctl -- balance                on-chain RELIC per wallet
npm run ctl -- holdings               every token balance per wallet
npm run ctl -- sweep [--execute]      collect tokens into main
npm run ctl -- fund  [--execute]      top up wallets low on gas
```

There is deliberately no `buy` command, and no command that can send to an
address outside your fleet.

### Characters

A wallet with no character cannot enter the world at all — the server refuses
the join with `no_character` — so minting a wallet is only half the job.
`relicctl new` and the Telegram mint buttons therefore create a hero
automatically, paced because `/api/auth/verify` rate-limits aggressively.

Six classes exist: 🏹 hunter · 🔮 mage · 💀 necromancer · 🛡️ knight ·
🗡️ assassin · 🎭 rogue.

**Which ones a wallet may use is decided by the server**, via the `unlocks`
array on `/api/characters`; a gated class rejects with `token_required`, which
is the RELIC-holding requirement surfacing. Nothing about that split is
hardcoded here — the roster view shows 🆓 or 🔒 based on what the server
actually answered for that wallet.

Names are generated per class from separate vocabularies, so a necromancer
never ends up called "Sunwarden". Every candidate is validated against the
client's own rules — the `/^[A-Za-z0-9][A-Za-z0-9 _'-]{0,18}[A-Za-z0-9]$/`
regex, the 2–20 length bound, and its profanity screen — before it is used,
because **the game states hero names are permanent**.

```
npm run ctl -- new --count 5     # 5 wallets, each with a hero
npm run ctl -- new --no-hero     # wallet only
npm run ctl -- onboard           # give every character-less wallet a hero
```

From Telegram, **👛 Wallets → ✨ Mint + job**: pick the class, pick how many,
and each wallet is created, given a hero, and left ready to play in one action.
The plain `➕` mint buttons still work and lead into the same job picker.

Bulk assignment is scoped to the wallets from the most recent mint rather than
the whole fleet — logging into wallets that already have a character only to
discover that burns the auth quota, which is the scarcest resource here.

New wallets are picked up automatically: the fleet rescans the key directory
every minute and starts anything new, so a wallet minted from Telegram does not
need a restart.

### Rate limiting

`/api/auth/verify` limits across the whole account set, not per wallet, and
reconnects and restarts produce bursts no start schedule accounts for. Every
login in the process funnels through one gate that serialises calls, spaces
them 8s apart, widens when the server pushes back and eases off after success.
Measured at 17 wallets: zero refusals, and the gate never had to widen.

Only *login* is serialised. Once a wallet holds its token it plays fully in
parallel — wallets do not take turns.

**The gate is per-process**, so the CLI and the running service do not share
it. Stop the service before a large CLI operation, or the server sees roughly
double the rate.

### Telegram

Send `/menu` for a button interface: fleet status, holdings, wallets, token
gate, Otak, parks, sweep and gas funding. Anything that moves funds runs as a
dry run first and needs a second confirmation tap before it broadcasts.

Wallets can be minted in batches (+1 / +5 / +10, capped so a mis-tap cannot
produce hundreds of keys), imported, and exported (as `solana-keygen` JSON) from
chat. Every freshly minted wallet gets a hero automatically. An exported key self-deletes after 90 seconds, and every inbound secret —
an imported key, an API key — is deleted the moment it arrives.

The bot ignores every chat not in `TELEGRAM_OWNER_IDS`; an empty allowlist
means nobody, not everybody.

---

## Development

```bash
npm install
npm test          # 229 tests
npm run typecheck
npm run build
```

Test suites worth reading first: `tests/signer.test.ts` (the game-path signing
lock, including source-level scans of `src/`), `tests/treasury.test.ts` (the
fleet-only transfer guard), `tests/safety.test.ts` (the park and liveness
regressions), `tests/pricing.test.ts` (the fee model).

Protocol reference: [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — 68 client messages,
37 REST endpoints, the auth handshake, and the on-chain token facts.

Design rationale and the full audit: [`docs/superpowers/specs/`](docs/superpowers/specs/).

### A known gap, stated honestly

The client→server message vocabulary was fully recovered. The **server→client
state shape was not**: Colyseus 0.16 sends schema definitions by reflection at
handshake, so field names exist only at runtime, not as literals in the bundle.

`src/game/state.ts` therefore reads defensively — it probes plausible field
names and returns nothing rather than guessing — and ships
`describeUnknownState()`, which dumps the real shape on first connect. Run once
with `LOG_LEVEL=debug` and tighten the accessors against what you actually see
before trusting `SELL_ENABLED` in production.

---

## Security

- Key files 0600, key directory 0700, both enforced at load
- Secrets held in closures, never as object properties — they cannot be read
  off an object, logged, or serialised into a prompt
- Every log line passes through a redactor (JWTs, `sk-` keys, Telegram tokens,
  base58 secrets, 64-int arrays)
- Otak prompts carry sanitised game state only: no keys, no JWTs, no addresses
- `RestClient` refuses every in-game spend endpoint as a second lock behind the
  absent buying code
- The treasury refuses any destination outside the loaded fleet, before a
  transaction is built
- Nothing secret is ever committed: `.env`, `keys/`, `data/` are gitignored
