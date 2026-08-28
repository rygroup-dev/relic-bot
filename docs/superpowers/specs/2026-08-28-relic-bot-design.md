# relic-bot — Design Spec

Date: 2026-08-28
Status: Approved (user: "gas", sell-focused, multi-account)
Target: `playrelic.gg` — isometric dungeon-crawler MMO on Solana

---

## 1. Audit findings (evidence-backed)

### 1.1 The supplied HAR is unusable
`/root/playrelic.gg.har` is truncated at exactly 8,200,000 bytes (cut mid-string).
Salvaged 258 entries via incremental `raw_decode`. Contents:

- 100% static assets (tile PNGs, `.opus`, `town.scene.json`)
- **0** API calls, **0** WebSocket frames, **0** auth headers/cookies, **0** POST bodies
- Capture window: 5 seconds (08:47:29 → 08:47:34) — town scene load only

**Decision:** discard the HAR as a protocol source. Protocol was reverse-engineered
from the production JS bundles instead, which yielded a far more complete picture.

### 1.2 Architecture (from production bundles)
Phaser client + **Colyseus `colyseus.js@0.16.22`** with `@colyseus/schema` v5
(binary serialization + runtime `Reflection`).

- Prod endpoint: `wss://playrelic.gg` — dev fallback `ws://<host>:2567`
- Rooms: `town`, `lobby`, `arenaLobby` (+ dungeon rooms via `i.descend.req`)
- Chunks RE'd: `main`, `modal`, `NetTestScene`, `zoneClient`, `tokens`,
  `ReliquaryScene`, `UserBuilderScene`, `docs`

`colyseus.js@0.16.22` is published on npm — pinned **exactly** to the deployed
client version. This removes an entire bug class (schema decoding, handshake,
reconnect) that a hand-rolled Python decoder would reintroduce.

**Language decision: TypeScript / Node 24.** Python has no maintained Colyseus
0.16 client; schema v5 encoding would need hand reimplementation. That directly
conflicts with the "zero mistake" requirement.

### 1.3 Authentication — fully reproducible from a raw private key
No browser or wallet extension required. ed25519 message signing only:

```
GET  /api/auth/now                    -> { now: number }
message = [
  "Relic — sign in",
  `Wallet: ${walletAddress}`,
  `Timestamp: ${now}`,
  "Only sign this on the official Relic site."
].join("\n")
POST /api/auth/verify
  { deviceId, walletType, proof: { walletAddress, message, signature, timestamp } }
                                      -> JWT
```
JWT is then used as `Authorization: Bearer <jwt>` for REST and as the
`token` room option for Colyseus `joinOrCreate`.

### 1.4 Token — $RELIC verified on-chain
```
mint      2ABbnf3EzGfiMa3PE2bseAWwRD4jAE4KgE8YjSTxpump
program   TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   (SPL Token-2022)
decimals  6
supply    999,678,544.470010
mintAuth  null      freezeAuth  null
extensions: metadataPointer, tokenMetadata  (NO transfer-fee, NO transfer-hook)
```
Confirms the user's "token 2022" statement. Absence of transfer hook/fee keeps
settlement arithmetic simple and makes balance reads exact.

### 1.5 Economy — money flows one direction
Complete enumeration of 37 REST endpoints. Every payment path is
`intent -> sign -> confirm` for a **purchase**. There is **no cashout/withdraw
endpoint**. (`withdraw` in the bundle is only `i.satchel.withdraw` /
`i.stash.withdraw` — inventory moves.)

| Direction | Path |
| --- | --- |
| Out (spend) | reliquary buy, `/api/shop/rare`, `/api/battlepass`, rebirth artifact-offer, marketplace buy |
| **In (earn)** | **`POST /api/marketplace/listings`** — sell farmed loot to another player |
| In (gold) | Reliquary defence: character earns gold per challenger defeated |

**Marketplace fee (docs, verbatim): "10% for USDC listings or 5% for RELIC listings"**,
seller-paid, deducted on settlement. Listing/selling is REST + Bearer and requires
**no transaction signature**.

Therefore the only revenue channel is farming loot and selling it to other
players. This is extraction from a PvP economy, not a measurable gold/hr faucet
like SLCW. Profitability depends on other players' demand.

### 1.6 Risk register
- **ToS §4 forbids automation**, verbatim: *"you agree not to exploit bugs or
  errors; use cheats, bots, automation, or unauthorized third-party software"*
- Enforcement is real and present in the client: ban objects with
  `reason`/`expiresAt`/`permanent`, `deviceId` fingerprinting, server-side
  `rate_limited`, `client_outdated` version check, `device_busy` single-session
- Ban dialog: *"Repeating the offense from new accounts will result in a
  permanent ban."* — multi-account ban risk is **correlated** across the fleet
  (shared VPS IP, similar behaviour patterns)
- ToS §6: in-game content carries *"no guarantee of continued existence,
  availability, or value"*; all acquisitions final, no refunds
- ToS §7: *"no representation that any token will be created, issued,
  distributed, supported, or maintained"*

User acknowledged these and elected to proceed. Design mitigates the
**financial** limb of the risk structurally (§2.1).

---

## 2. Design

### 2.1 Payment hard-lock — a structural property, not a flag

> **The bot signs only UTF-8 login messages. It never signs a Solana `Transaction`.**

Gameplay (`i.move`, `i.attack`, `i.loot.pickup`, …) travels over WebSocket and
needs no signature at all. Selling (`POST /api/marketplace/listings`) is REST +
Bearer and needs no signature. Only *buying* requires transaction signing — and
that code path **is not written**.

```
src/wallet/signer.ts
  export function signLoginMessage(msg: Uint8Array): Uint8Array
  // signTransaction() does not exist. Not flagged off — absent.
```

Consequence, provable by test: even under total compromise of the bot process,
the hot key cannot move funds, because no code exists to build or sign a
transfer. This is strictly stronger than a spend cap or an env flag.

**Buy seam (deliberately left, not implemented):** if buying is ever needed,
it is added as one new module `src/wallet/spender.ts` behind explicit user
approval. Architecture does not need to change.

### 2.2 Otak — two layers, LLM optional

```
Deterministic heuristics   -> always run; bot plays fully with LLM off
        v  (candidates + scores + reasons)
Otak LLM (if enabled)      -> re-ranks / vetoes; chooses only among candidates
        v
Guardrails                 -> final veto; LLM can never unlock a payment path,
                              exceed a cap, or synthesise a novel action
```
The LLM selects from a heuristic-validated candidate set. It never invents
actions. Pattern inherited from `pons-sniper-4663/sniper/agent.py`, tightened.

**Providers:** OpenAI, Anthropic, Sakana Fugu. Selected via `/otak` in Telegram;
API key entered in chat, stored encrypted at rest, toggleable off. Each provider
gets a health check plus automatic fallback to the next provider, then to pure
heuristics. (Memory: the Sakana key in `hoodsniper` previously returned 401 —
fallback is mandatory, not optional.)

**Four domains:**
1. **Economy & pricing** — reads `/api/marketplace/listings` + `/logs`; prices
   farmed loot; models the 5% RELIC vs 10% USDC fee against RELIC volatility risk
2. **Combat & build** — target selection, cooldown/cast, `i.attrs.set`,
   `i.talents.set`, descend-vs-return, revive
3. **Progression** — rebirth timing, artifact socket/chisel/gem, battlepass, stash
4. **Safety governor** — self-monitors tempo/jitter, handles `rate_limited`,
   `client_outdated`, `device_busy`, ban; auto-parks wallets

### 2.3 Liveness detectors (lesson from SLCW)

SLCW memory: *"Signature failure = healthy but produces nothing — 10 occurrences."*
A refused action looped forever at zero errors.

**Liveness is therefore measured by output, never by absence of errors:**
- last loot timestamp per wallet in `data/ledger.jsonl`
- per-monster kill counters in `data/combat_memory.json`
- watchdog: no increment within N minutes -> Telegram alert even at 0 errors

Inherited rule from SLCW session 3: **every free-value branch must route through
a single `free()` helper that checks park state** — so "park recorded but never
read" cannot recur.

### 2.4 Token gate
`GET /api/token-gate/status` -> `{ allowed: boolean }`. The threshold is
**server-side only** — it appears in neither the client bundle nor the docs. The
user believes it is 10,000 RELIC; this is **unverified**.

**Design: never hardcode a threshold.** The bot reads the gate per wallet at
runtime, records `allowed` in state, and reports the true status to Telegram.
If gated, market features are skipped for that wallet and it keeps farming.

### 2.5 Multi-account fleet
Modelled on the SLCW orchestrator (50 wallets).

- One keypair + one distinct persistent `deviceId` per account
- `device_busy` = one live session per account; N accounts = N sessions, fine
- Per-wallet: independent JWT, park state, ledger, gate status, Otak budget
- Staggered start + per-wallet jitter to avoid a synchronised fleet signature
- Fleet-wide park: a wallet-independent refusal (e.g. `client_outdated`) parks
  **all** wallets, not just the one that hit it

**Capital note:** if the gate is real, it applies per wallet — cost scales
linearly with fleet size. Reported, not assumed.

### 2.6 Repository layout
```
relic-bot/
  src/
    index.ts  cli.ts  config.ts  log.ts
    wallet/    signer.ts  keystore.ts
    auth/      client.ts
    net/       rest.ts  zone.ts
    protocol/  messages.ts  endpoints.ts
    game/      loop.ts  combat.ts  loot.ts  state.ts
    economy/   marketplace.ts  pricing.ts  gate.ts
    otak/      index.ts  heuristics.ts  prompt.ts  providers/{openai,anthropic,fugu}.ts
    safety/    park.ts  watchdog.ts  ledger.ts
    telegram/  bot.ts
    fleet/     orchestrator.ts  account.ts
  tests/       protocol, guardrails, signer-cannot-sign-tx, pricing, park
  scripts/install.sh
  docs/PROTOCOL.md   (68 messages + 37 endpoints)
  .env.example  README.md
```
Repo: `rygroup-dev/relic-bot`. One-liner installer provisions systemd unit,
Node deps, and an interactive `.env` wizard.

### 2.7 Security
- Key files `0600`, outside the repo tree; `.gitignore` + pre-commit guard
- Private keys never logged, never sent to Telegram, never sent to any LLM
- Otak prompts carry only sanitised game state — no keys, no JWTs, no addresses
- Telegram bot restricted to an owner chat allowlist

---

## 3. Non-goals
- No buying / transaction signing (see §2.1)
- No ban evasion tooling, no fingerprint spoofing beyond distinct per-account IDs
- No claim of a measurable gold/hr faucet — none exists (§1.5)
