# playrelic.gg — protocol reference

Reverse-engineered 2026-08-28 from the production JavaScript bundles.
Nothing here came from the supplied HAR: that capture contained only static
tile assets (see the spec, §1.1).

Source chunks: `main`, `modal`, `NetTestScene`, `zoneClient`, `tokens`,
`ReliquaryScene`, `UserBuilderScene`, `docs`.

---

## Transport

| | |
|---|---|
| Engine | Phaser (client) + **Colyseus `colyseus.js@0.16.22`** |
| Serialisation | `@colyseus/schema` v5, binary, runtime `Reflection` |
| Endpoint | `wss://playrelic.gg` (prod) · `ws://<host>:2567` (dev) |
| Rooms | `town`, `lobby`, `arenaLobby` |

The client version is pinned exactly in `package.json`. The schema wire format
is versioned; a mismatched or hand-rolled decoder silently corrupts state.

---

## Authentication

Fully reproducible from a raw Solana secret key — no browser, no extension.

```
GET  /api/auth/now                -> { now: number }

message = [
  "Relic — sign in",                              # em dash is U+2014
  "Wallet: " + walletAddress,
  "Timestamp: " + now,
  "Only sign this on the official Relic site."
].join("\n")

signature = base64( ed25519_sign(utf8(message), secretKey) )   # client uses btoa()

POST /api/auth/verify
  { deviceId, walletType, proof: { walletAddress, message, signature, timestamp } }
  -> { token, walletAddress, character, characters, ban? }
```

The JWT is then sent as `Authorization: Bearer <token>` on REST, and as the
`token` room option to `joinOrCreate`.

**Two details that break auth if wrong:** the separator is a literal `\n`
(`.join("\n")`), and the signature is **base64**, not base58.

---

## Client → server messages (68)

All travel over the WebSocket. **None carries a signature; none can move funds.**

### Movement & combat
`i.move` `i.attack` `i.cast` `i.roll` `i.use` `i.use.instance` `i.revive` `i.inspect`

### Loot & inventory
`i.loot.pickup` `i.chest.open` `i.mysterybox.open` `i.inv.equip` `i.inv.unequip`
`i.inv.discard` `i.inv.destroyjunk`

### Storage
`i.stash.deposit` `i.stash.withdraw` `i.satchel.deposit` `i.satchel.withdraw`
`i.satchel.move`

> `withdraw` here means moving items between containers. It is **not** a cashout.

### Character build
`i.attrs.set` `i.talents.set`

### Gems & artifacts
`i.gem.socket` `i.gem.unsocket` `i.chisel.apply` `i.artifact.state`
`i.artifact.equip` `i.artifact.unequip` `i.artifact.spend` `i.artifact.sockets`
`i.artifact.stone.socket` `i.artifact.stone.unsocket`

### Shops (gold-denominated, in-world)
`i.shop.stock` `i.shop.buy` `i.shop.sell` `i.wandering.open` `i.wandering.buy`

### Dungeon
`i.descend.req` `i.dungeon.fountain.use` `i.dungeon.resurrection.use`
`i.dungeon.roland.interact` `i.dungeon.roland.aggro` `i.dungeon.delver.interact`
`i.dungeon.necromancer.interact` `i.dungeon.apparition-knight.interact`
`i.dungeon.fallen-huntress.interact` `i.dungeon.mad-pyromancer.interact`
`i.dungeon.knight-corpse.interact` `i.dungeon.slain-crusader.interact`

### Rebirth
`i.rebirth.preview` `i.rebirth.confirm` `i.rebirth.hud.dismiss`
`i.rebirth.tutorial.dismiss`

### PvP
`i.duel.challenge` `i.duel.accept` `i.duel.decline` `i.duel.pref`
`i.pos.killsettle` `i.ranked.ticket.claim`

### Chat & UI
`i.chat` `i.chat.history` `i.hardcore.dismiss` `i.level90.dismiss` `i.portal.dismiss`

### Server → client
Not enumerable from the bundle: Colyseus 0.16 sends schema definitions by
reflection at handshake, so state field names exist only at runtime.
`src/game/state.ts` therefore reads defensively and ships
`describeUnknownState()` to dump the real shape on first connect.

---

## REST endpoints (37)

### Auth & character
`/api/auth/now` `/api/auth/verify` `/api/auth/logout`
`/api/characters` `/api/character` `/api/character/select` `/api/tutorial/town`

### Read-only
`/api/token-gate/status` -> `{ allowed: boolean }`
`/api/payments/usdc-balance` · `/api/payments/solana-blockhash`

### Marketplace — EARN (Bearer only, **no signature**)
| Method | Path |
|---|---|
| GET | `/api/marketplace/listings` |
| POST | `/api/marketplace/listings` ← **the only revenue path** |
| GET | `/api/marketplace/my-listings` |
| GET | `/api/marketplace/logs` |
| POST | `/api/marketplace/listings/{id}/cancel` |

### SPEND — requires a signed Solana transaction (never called)
`/api/marketplace/listings/{id}/payment-intent`
`/api/marketplace/payment-intents/{id}` · `.../sign`
`/api/reliquaries/{id}/buy/intent` · `.../buy/confirm`
`/api/shop/rare` (+ `/{id}/intent`, `/{id}/confirm`)
`/api/battlepass` (+ `/intent`, `/confirm`, `/claim`)
`/api/rebirth/artifact-offer` (+ `/intent`, `/confirm`, `/intent/cancel`, `/select`)

`RestClient` refuses every path matching `SPEND_ENDPOINT_PATTERNS`, as a second
lock behind the absence of any transaction-signing code.

### Reliquaries
`/api/reliquaries` · `/{id}` · `/visits` · `/{id}/enter` · `/{id}/thumbnail`
· `/{id}/claim-ticket`

---

## Economy

**Marketplace fee** — quoted verbatim from `/docs`:

> "A seller-paid marketplace fee is deducted on settlement: 10% for USDC
> listings or 5% for RELIC listings."

| Currency | Fee | Seller keeps |
|---|---|---|
| USDC | 10% | 90% |
| RELIC | 5% | 95% |

RELIC's lower fee is offset by volatility. `src/economy/pricing.ts` applies a
configurable discount to RELIC proceeds and picks whichever currency maximises
risk-adjusted net. Crossover sits near a 5.26% discount.

**Reliquaries** earn passive gold: *"Your character earns gold each time it
defeats a challenger."*

**There is no cashout endpoint.** Money enters via purchases and leaves only to
another player buying your listing.

---

## $RELIC token (verified on-chain 2026-08-28)

```
mint       2ABbnf3EzGfiMa3PE2bseAWwRD4jAE4KgE8YjSTxpump
program    TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   (SPL Token-2022)
decimals   6
supply     999,678,544.470010
mintAuth   null        freezeAuth  null
extensions metadataPointer, tokenMetadata
```

No transfer-fee and no transfer-hook extension, so balances are exact and ATA
derivation is standard — **but it must use the Token-2022 program id**;
deriving with the classic SPL Token program yields a different address that
always reads zero.

**Token gate:** `/api/token-gate/status` returns only `{ allowed }`. The
threshold is server-side and appears in neither the bundle nor the docs. It is
deliberately not hardcoded anywhere in this repo.

---

## Refusals and enforcement

Observed in the client's error handling:

| Reason | Meaning | Fleet response |
|---|---|---|
| `banned` | account ban, with `reason` / `expiresAt` / `permanent` | park account indefinitely, alert |
| `client_outdated` | deployed client moved on | park **whole fleet**, alert |
| `device_busy` | account already has a live session | park account 120s, alert |
| `rate_limited` | server-side throttle | park account 60s |

The ban dialog states: *"Repeating the offense from new accounts will result in
a permanent ban."*

The Terms of Service (§4 Acceptable Use) prohibit automation:

> "you agree not to exploit bugs or errors; use cheats, bots, automation, or
> unauthorized third-party software"

Operating this bot is a decision for the account owner.
