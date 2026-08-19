# Fee Granter

A fee grant dashboard for [Secret Network](https://scrt.network), covering both **secret-4**
(mainnet) and the **pulsar-3 testnet**. Connect Keplr to see every address whose transaction
fees you are covering, how much of each allowance is left, and create, edit or revoke grants.
The wallet menu adds balance and price, deposit and send, and recent activity.

Built from the Figma design in
[`IVqCdSX1kvktVvdL0FZQaT`](https://www.figma.com/design/IVqCdSX1kvktVvdL0FZQaT/Untitled?node-id=0-1).

## Getting started

```bash
npm install
cp .env.example .env.local   # optional - sensible defaults are baked in
npm run dev
```

Open <http://localhost:3000> and connect Keplr. pulsar-3 is not in Keplr's built-in chain
registry, so the app suggests the chain the first time you connect.

You will need testnet SCRT in the granting account — the
[pulsar faucet](https://faucet.pulsar.scrttestnet.com) hands it out.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:sdk` | Fee grant selection tests (plain Node, no bundler) |

## Configuration

Everything network-related is an environment variable, so you can point the app at a
different node without touching code. See `.env.example`.

| Variable | Chain | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SECRET_LCD_URL` | pulsar-3 | `pulsar.lcd.secretnodes.com` + fallbacks |
| `NEXT_PUBLIC_SECRET_RPC_URL` | pulsar-3 | `pulsar.rpc.secretnodes.com` + fallbacks |
| `NEXT_PUBLIC_SECRET_MAINNET_LCD_URL` | secret-4 | `lcd-secret.keplr.app` + fallbacks |
| `NEXT_PUBLIC_SECRET_MAINNET_RPC_URL` | secret-4 | `rpc-secret.keplr.app` + fallbacks |
| `NEXT_PUBLIC_EXPLORER_TX_URL` | pulsar-3 | ping.pub testnet |
| `NEXT_PUBLIC_MAINNET_EXPLORER_TX_URL` | secret-4 | Mintscan |
| `NEXT_PUBLIC_PRICE_API_URL` | — | Osmosis SQS |

Public nodes go down often. Every endpoint setting takes a **comma-separated list**: the app
probes each in order and uses the first that answers with JSON *and* reports the expected
chain id, so a dead node fails over instead of breaking the page.

Endpoints can also be overridden per chain at runtime from **Settings** in the app, which
takes precedence over these.

### When a node is down

A dead node usually still answers at the HTTP level — a gateway returns an HTML error page.
Parsing that as JSON is what produces `Unexpected token '<', "<!DOCTYPE "... is not valid
JSON`, an error that says nothing about the real cause. The app checks the response body
rather than the status code, and reports which nodes it tried and what each returned:

```
Could not reach a working pulsar-3 node.
  • https://api.pulsar3.scrtlabs.com/api — returned an HTML page, not JSON (HTTP 502)
  • https://pulsar.lcd.secretnodes.com — unreachable (network error or CORS blocked)

Set a different endpoint in Settings and try again.
```

The RPC endpoint is only handed to Keplr, which checks it itself during the chain
suggestion, so a dead RPC surfaces at connect time and is reported separately.

## Wallet menu

Balance comes from `x/bank`. The USD value comes from the
[Osmosis price API](https://docs.osmosis.zone/integrate/prices/), keyed by SCRT's IBC denom.
Browser access to that host depends on it sending CORS headers, which is outside this app's
control, so **CoinGecko is tried as a fallback**; the first source returning a usable number
wins. Testnet SCRT has no market, so pulsar-3 shows "No price" rather than a fabricated
number, and if every source fails the label reads "Price unavailable" — hover it for the
reason — rather than showing a wrong figure.

**Deposit** and **Send** open inside the wallet popover itself, not as separate dialogs.
Deposit renders the address as an inline SVG QR code; Send is a plain `MsgSend` with a Max
button that leaves enough behind to cover the fee.

**Settings** is a third view in the same popover. It stays reachable while disconnected via
the gear next to Connect, since a dead endpoint is exactly when you need it.

**Activity** is limited to what this app is about: SCRT in, SCRT out, and fee grants being
spent. Cosmos exposes this only as an indexed event search, which is awkward in three ways
the implementation works around:

- The query parameter changed across SDK versions (`events=` up to 0.47, `query=` from 0.50),
  and a node given the wrong one may answer `200` with an empty list instead of an error. An
  empty result therefore means "try the next spelling", never "there is nothing".
- Which event keys a node indexes varies, so several equivalent expressions are tried per
  kind (`transfer.sender`, `message.sender`, `coin_spent.spender`, …) and merged.
- `tx_response.logs` is populated up to SDK 0.47 and empty from 0.50, where events moved to
  `tx_response.events` with base64 keys in some versions. Amounts are therefore read from
  `tx.body.messages`, which is always present; events are only a fallback.

Reading amounts from the messages has a second benefit: every transaction transfers a fee to
the fee collector, so an event-based reading lists ordinary transactions as sends. Matching
on `MsgSend`/`MsgMultiSend` instead means only real transfers appear.

A node configured not to index will legitimately return nothing — the UI says "No activity
found" rather than claiming there is none.

## Settings

- **Appearance** — dark, light, or follow the system.
- **Endpoints** — per-chain LCD and RPC overrides.
- **Daily spending ceiling** — a budget you set for yourself, shown above the figure
  calculated from your grants, with a warning when your grants exceed it.

  This is a guard rail in this app, **not a chain rule**. x/feegrant has no account-wide
  budget, so nothing stops a grant created elsewhere — or the chain itself — from going over
  it. It is a reminder, not an enforcement mechanism.

## How fee grants are modelled

Grants come in two kinds.

### One-time grants

A **`BasicAllowance`** with a spend limit and no period: a fixed pot that never refills.
`BasicAllowance.Accept` reports the grant as spent once the limit reaches zero, and
x/feegrant then deletes it — which is what makes it unusable a second time. No "infinite
period" trick is needed; a `BasicAllowance` simply has no period to reset.

One caveat worth being explicit about: this bounds the **amount**, not the number of
transactions. cosmos-sdk has no "max N transactions" allowance. If a grantee's fees come in
under the limit, they can keep spending the remainder until it is gone. Size the grant to
roughly one transaction's fee for genuinely single-use behaviour — the form says as much.

### Recurring grants

A **`PeriodicAllowance`**, which is what the design's "X SCRT / day" implies:

- `period` — the window (hour, day, week or 30 days).
- `period_spend_limit` — the most the grantee can spend on fees per window. Seeded into
  `period_can_spend` at creation so the grant is usable immediately; the chain resets it every
  period.
- `basic.spend_limit` — an optional lifetime cap. Left empty for an uncapped grant.
- `basic.expiration` — an optional expiry date.

The two summary cards aggregate across all grants:

- **Current max spending** — the sum of every `period_spend_limit`, with the usage bar showing
  `(limit − period_can_spend) / limit`. One-time grants have no period, so they are excluded
  and noted beneath the figure rather than silently dropped.
- **Total fee granted** — the sum of every lifetime cap, plus whatever is left on the one-time
  grants. Grants with no cap are called out separately rather than counted as zero.

### Using a grant

A fee grant is **never applied automatically**. The grantee's transaction has to name the
granter in `auth_info.fee.granter`; if it does not, the fee comes out of the grantee's own
balance as usual. Keplr does not fill that field in, so a wallet holding a grant will keep
paying its own fees until some application asks it to use the grant.

That is what the **Fee paid by** selector in Send does: it lists the grants the connected
wallet may spend against and sets `fee.granter` accordingly. The wallet menu also says how
many grants can cover the connected wallet, so a grant made to your own second wallet can be
confirmed from the receiving side.

The selector offers **Auto**, **Choose** and **This wallet**, all three backed by the same
selection logic described in [Using fee grants in your own app](#using-fee-grants-in-your-own-app).

One rejection the SDK cannot filter out: a grantee account that does not exist on chain yet.
Accounts are created by receiving coins, and a grant does not create one, so a brand-new
address needs a small deposit before it can sign anything.

## Using fee grants in your own app

`src/lib/feegrant-sdk.ts` is a standalone module — no React, no secretjs, no imports from the
rest of this app. Copy the single file into your project and it works anywhere `fetch` does.

It covers the read-and-choose half of `x/feegrant`: finding which grants an address may spend
against, and picking one. Building and signing the transaction stays with whatever library you
already use. All the SDK produces is the address to put in `auth_info.fee.granter`.

```bash
npm run test:sdk   # 24 checks, plain Node, no bundler
```

### The three-line version

```ts
import { fetchFeeGrants, selectFeeGrant, estimateFee } from "./feegrant-sdk";

const grants = await fetchFeeGrants(LCD_URL, myAddress);
const { granter } = selectFeeGrant(grants, {
  mode: "auto",
  fee: estimateFee(gasLimit, gasPrice),
  msgTypeUrls: ["/cosmos.bank.v1beta1.MsgSend"],
});

// granter is undefined when nothing suitable exists — then you pay your own fee.
await client.tx.bank.send(msg, { gasLimit, feeGranter: granter });
```

### Two modes

**`auto`** picks the best grant that can cover the fee, ranked:

1. **Recurring before one-time.** A periodic grant refills, so spending it costs the granter
   less than burning a one-time grant outright.
2. **More left over less.** Maximises the chance the fee fits, and leaves headroom.
3. **Shorter period over longer.** Between two grants with the same balance, the one that
   refills sooner is cheaper to draw down.
4. Granter address, so the order is stable across calls.

Given these grants, `auto` picks `A` and `rankFeeGrants` returns them in this order:

| | Grant | Left | Cadence |
| --- | --- | --- | --- |
| 1 | A | 12 SCRT | every 15 min |
| 2 | C | 12 SCRT | every day |
| 3 | B | 5 SCRT | every 15 min |
| 4 | D | 120 SCRT | one-time |
| 5 | E | 10 SCRT | one-time |

**`select`** uses the grant you name, and tells you if it cannot pay:

```ts
const choice = selectFeeGrant(grants, { mode: "select", granter: picked, fee });
if (!choice.granter) {
  // choice.rejected is "expired" | "insufficient" | "message-not-allowed"
}
```

Use `choice.candidates` — every grant that could pay, best first — to build the picker itself,
so you never offer a grant the chain would reject.

**`off`** skips grants entirely and pays from the wallet's own balance.

### What gets filtered out

`checkUsable` rejects a grant, and `rankFeeGrants` drops it, when:

| Reason | Meaning |
| --- | --- |
| `expired` | `expiration` has passed |
| `insufficient` | less left than the fee — including the lifetime cap, which the chain applies on top of the period balance |
| `message-not-allowed` | an `AllowedMsgAllowance` that does not cover every message in your transaction |

Pass the **same** gas limit and gas price you give your signing library. Estimating a smaller
fee than you actually pay is the one way to have a grant judged able to cover a transaction it
then fails.

### API

| Export | Purpose |
| --- | --- |
| `fetchFeeGrants(lcdUrl, grantee, opts?)` | Grants this address may spend against |
| `parseFeeGrant(raw, denom?)` | Normalise one LCD allowance if you fetch it yourself |
| `selectFeeGrant(grants, opts)` | Pick a granter — `auto`, `select` or `off` |
| `rankFeeGrants(grants, ctx)` | Every usable grant, best first |
| `compareGrants(a, b)` | The comparator, if you want a different order |
| `checkUsable(grant, ctx)` / `isUsable(...)` | Why one grant cannot pay |
| `availableFee(grant)` | Spendable now in base units; `undefined` = uncapped |
| `estimateFee(gasLimit, gasPrice)` | Fee in base units, rounded up |

`fetchFeeGrants` accepts `{ denom, limit, fetchImpl }`, so a non-SCRT chain or a custom
fetch (proxy, retries, test double) needs no changes to the module.

### Things the SDK cannot do for you

- **A grant is never applied automatically.** If your transaction does not set
  `fee.granter`, the fee comes from the sender, whatever grants exist.
- **The chain re-checks everything at execution.** A grant can be revoked or drained between
  your query and your broadcast; treat rejection as normal and fall back to self-paying.
- **A brand-new account still cannot transact.** Accounts are created by receiving coins, and
  a grant does not create one, so a fresh address needs a small deposit before it can sign.

### Editing a grant

`x/feegrant` rejects `MsgGrantAllowance` when a grant for that granter/grantee pair already
exists, and there is no update message. An edit is therefore a `MsgRevokeAllowance` followed by
a `MsgGrantAllowance` **in a single transaction**, so the grant is never left revoked if the
second message fails. The grantee address is read-only while editing for the same reason —
changing it would be a different grant.

"Suspend all" is the same idea at scale: one transaction carrying a revoke message per grant.

## Notable implementation details

**Listing grants by granter.** `AllowancesByGranter` only landed in cosmos-sdk v0.46. If the
node does not implement it, the app falls back to a locally stored list of grantees, verifying
each against the chain with the single-grant query. Amounts always come from the chain; only
the *set of addresses to check* is local. The UI says so when it is in that mode. Grants
created from another browser will not show up in the fallback path.

**Signing mode.** The app requests Keplr's direct-capable signer, which makes secretjs sign
with `SIGN_MODE_DIRECT` and encode allowance timestamps through protobuf. secretjs's amino
path serialises `Timestamp` as `{seconds, nanos}` rather than RFC 3339, which an amino-only
signer (a Ledger, for example) would reject. Ledger support would need that worked around
first.

**Proto3 JSON tolerance.** Depending on the node, `Duration` arrives as `"86400s"` or as
`{seconds, nanos}`, and `Timestamp` as RFC 3339 or `{seconds, nanos}`. The parser accepts both
shapes.

**Amount maths.** All SCRT ↔ uscrt conversion is done on strings and `BigInt`, so nothing is
routed through a float.

## Tech

- Next.js 15 (App Router) + TypeScript
- [secretjs](https://github.com/scrtlabs/secret.js) for queries and transactions
- [Lucide](https://lucide.dev) icons
- CSS Modules, with the Figma values centralised as custom properties in
  `src/app/globals.css`

The design specifies Google Sans Flex, which is not publicly distributed; **Figtree** is used
as the closest freely available substitute. Swap the `next/font` import in
`src/app/layout.tsx` if you have a licence for the real thing.

## Project layout

```
src/
  app/          layout, page, design tokens
  components/   dashboard, cards, rows, modals, toasts
  hooks/        wallet context, grant loading
  lib/
    feegrant-sdk.ts   standalone: fetch, parse and choose a fee grant
    feegrant.ts       grant/revoke transactions, built on the SDK
    chains.ts         chain registry
    keplr.ts          wallet connection
    bank.ts           balance and send
    history.ts        activity search
scripts/
  test-feegrant-sdk.ts
```

`feegrant-sdk.ts` deliberately imports nothing else, so it can be lifted out on its own.

## Status

Not yet implemented: wallets other than Keplr,
`AllowedMsgAllowance` creation (existing ones are displayed and can be revoked), and
grant history.
