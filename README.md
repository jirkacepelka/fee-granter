# Fee Granter

A fee grant dashboard for [Secret Network](https://scrt.network) — **secret-4** (mainnet) and
the **pulsar-3** testnet. Connect Keplr to see every address whose transaction fees you cover,
create, edit or revoke grants, and buy **gas credits** from a vault contract for someone else to
spend. Next.js 15 (App Router) + TypeScript, [secretjs](https://github.com/scrtlabs/secret.js)
for chain access, CSS Modules for styling.

Built from the Figma design
[`IVqCdSX1kvktVvdL0FZQaT`](https://www.figma.com/design/IVqCdSX1kvktVvdL0FZQaT/Untitled?node-id=0-1).

## Running it locally

```bash
npm install
cp .env.example .env.local   # optional — sensible defaults are baked in
npm run dev
```

Open <http://localhost:3000> and connect Keplr. pulsar-3 is not in Keplr's built-in chain
registry, so the app suggests it the first time you connect. You'll need testnet SCRT in the
granting account — the [pulsar faucet](https://faucet.pulsar.scrttestnet.com) hands it out.

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:sdk` | Fee grant selection tests — plain Node, no bundler |

All endpoints, the gas-vault address and the price API are `NEXT_PUBLIC_*` environment
variables — see `.env.example`. Every endpoint setting accepts a **comma-separated list**: the
app probes each in order and uses the first that answers with JSON *and* reports the expected
chain id, so one dead public node fails over instead of breaking the page. Endpoints can also be
overridden per chain at runtime from Settings in the app, which takes precedence.

| Variable | Chain | Default |
| --- | --- | --- |
| `NEXT_PUBLIC_SECRET_LCD_URL` / `_RPC_URL` | pulsar-3 | secretnodes.com + fallbacks |
| `NEXT_PUBLIC_SECRET_MAINNET_LCD_URL` / `_RPC_URL` | secret-4 | keplr.app + fallbacks |
| `NEXT_PUBLIC_EXPLORER_TX_URL` | pulsar-3 | ping.pub testnet |
| `NEXT_PUBLIC_MAINNET_EXPLORER_TX_URL` | secret-4 | Mintscan |
| `NEXT_PUBLIC_PRICE_API_URL` | mainnet only | Osmosis SQS, falls back to CoinGecko |
| `NEXT_PUBLIC_GAS_VAULT_ADDRESS` / `_MAINNET` | either | pulsar-3 defaults to this repo's deployment; secret-4 defaults to `secret1kkmu4vydkppkhzmx00glm20vn47t09544adv0g` |

---

# SDK: fee grants and gas credits

Everything below is usable outside this app. Two modules, split by whether they need a chain
library:

- **`src/lib/feegrant-sdk.ts`** is standalone — no React, no secretjs, no imports from the rest
  of this repo. Copy the single file into another project and it works anywhere `fetch` does.
  It covers the read half of `x/feegrant`: fetching which grants an address may spend against,
  and picking one.
- **`src/lib/feegrant.ts`** and **`src/lib/gasVault.ts`** need [secretjs](https://github.com/scrtlabs/secret.js):
  building and sending the transactions that create, edit, revoke or buy a grant. They re-export
  the SDK's types so there is one `FeeGrant` shape everywhere.

```bash
npm run test:sdk   # plain Node, no bundler — the SDK's own test suite
```

## How a fee grant works, briefly

`x/feegrant` lets one account (the **granter**) pay gas for another (the **grantee**), up to a
limit. A grant is **never applied automatically** — the grantee's transaction has to set
`auth_info.fee.granter` itself, or the fee comes out of its own balance as usual. Keplr does not
fill that field in; an application has to.

A grant does not create an account, either — accounts are created by receiving coins, so a
brand-new address still needs a small deposit before it can sign anything, grant or not.

Two allowance shapes exist:

- **`BasicAllowance`** — a fixed pot with a spend limit and no period. Once it is spent,
  `x/feegrant` deletes it; it cannot be reused. This is what one-time grants and gas credits are
  built from.
- **`PeriodicAllowance`** — a spend limit that refills every period (hour, day, week, …), plus
  an optional lifetime cap and expiry. This is what a recurring "0.15 SCRT / day" grant is.

## Reading and choosing a grant (`feegrant-sdk.ts`)

```ts
import { fetchFeeGrants, selectFeeGrant, estimateFee } from "./feegrant-sdk";

const grants = await fetchFeeGrants(LCD_URL, myAddress);
const { granter } = selectFeeGrant(grants, {
  // mode defaults to "auto" — spend a grant whenever one can cover the fee
  fee: estimateFee(gasLimit, gasPrice),
  msgTypeUrls: ["/cosmos.bank.v1beta1.MsgSend"],
});

// granter is undefined when nothing suitable exists — then pay the fee yourself.
await client.tx.bank.send(msg, { gasLimit, feeGranter: granter });
```

Building and signing the transaction stays with whatever library you already use. All the SDK
produces is the address to put in `auth_info.fee.granter`.

### The three fee-payer modes

This dashboard exposes all three under **Settings → Transaction fees**, labelled **Auto**,
**Choose** and **This wallet**:

| `SelectionMode` | UI label | Behaviour |
| --- | --- | --- |
| `auto` (default) | **Auto** | Spends the best usable grant whenever one covers the fee. The wallet's own balance is never consulted first — a grant wins even when the wallet could easily pay for itself, because the granter made the grant precisely so it would be used. Falls back to the wallet's own balance only when no grant can cover the fee. |
| `select` | **Choose** | Always uses the grant named in `granter`. Falls back to the wallet's own balance only when that specific grant cannot pay (see `rejected` below). |
| `off` | **This wallet** | Never spends a grant, even if one is usable. The only way to opt out entirely — there is no "only when I'm short" mode, because a fee grant is a standing offer, not a last resort. |

```ts
// auto (default) — just estimate the fee and go
selectFeeGrant(grants, { fee, msgTypeUrls });

// select — name a specific granter
const choice = selectFeeGrant(grants, { mode: "select", granter: picked, fee });
if (!choice.granter) {
  // choice.rejected is "expired" | "insufficient" | "message-not-allowed"
}

// off — always pay from the wallet's own funds
selectFeeGrant(grants, { mode: "off", fee });
```

`auto` ranks every usable grant and picks the first:

1. **Recurring before one-time.** A periodic grant refills, so spending it costs the granter
   less than burning a one-time grant outright.
2. **More left over less.** Maximises the chance the fee fits, and leaves headroom.
3. **Shorter period over longer.** Between two grants with the same balance, the one that
   refills sooner is cheaper to draw down.
4. Granter address, so the order is stable across calls.

Given these grants, `auto` picks `A`:

| | Grant | Left | Cadence |
| --- | --- | --- | --- |
| 1 | A | 12 SCRT | every 15 min |
| 2 | C | 12 SCRT | every day |
| 3 | B | 5 SCRT | every 15 min |
| 4 | D | 120 SCRT | one-time |
| 5 | E | 10 SCRT | one-time |

Use `choice.candidates` — every grant that could pay, best first — to build a picker UI, so you
never offer a grant the chain would reject.

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
| `selectFeeGrant(grants, opts)` | Pick a granter — `auto` (default), `select` or `off` |
| `rankFeeGrants(grants, ctx)` | Every usable grant, best first |
| `compareGrants(a, b)` | The comparator, if you want a different order |
| `checkUsable(grant, ctx)` / `isUsable(...)` | Why one grant cannot pay |
| `availableFee(grant)` | Spendable now, in base units; `undefined` = uncapped |
| `estimateFee(gasLimit, gasPrice)` | Fee in base units, rounded up |

`fetchFeeGrants` accepts `{ denom, limit, fetchImpl }`, so a non-SCRT chain or a custom fetch
(proxy, retries, test double) needs no changes to the module.

### Things the SDK cannot do for you

- **A grant is never applied automatically.** If your transaction doesn't set `fee.granter`,
  the fee comes from the sender, whatever grants exist.
- **The chain re-checks everything at execution.** A grant can be revoked or drained between
  your query and your broadcast; treat rejection as normal and fall back to self-paying.
- **A brand-new account still cannot transact.** A grant does not create one.

### Parsing details worth knowing before you "simplify" them away

- `Duration` arrives as either `"86400s"` or `{ seconds, nanos }`, and `Timestamp` as either RFC
  3339 or `{ seconds, nanos }`, depending on the node's marshaller. `parseDurationSeconds` and
  `parseTimestamp` accept both.
- Amounts are strings and `BigInt` end to end (`toMicroUnits` / `fromMicroUnits` if you copy
  `format.ts` too) — nothing routed through a float.

## Creating, editing and revoking grants (`feegrant.ts`)

This half needs secretjs. It re-exports `FeeGrant`, `parseGrant` and `availableFee` from the SDK,
so there is one parser in play, not two.

```ts
import { grantAllowance, updateAllowance, revokeAllowance, revokeAll } from "./feegrant";

await grantAllowance(client, granterAddress, {
  grantee: "secret1…",
  kind: "periodic",        // or "oneshot"
  amount: "0.15",          // human decimal string — per period for periodic, total for oneshot
  periodSeconds: 86_400,
  totalLimit: "5",         // optional lifetime cap, periodic only
  expiration: undefined,   // optional Date
});
```

- **`grantAllowance`** creates a new grant. `kind: "oneshot"` builds a plain `BasicAllowance`;
  `kind: "periodic"` builds a `PeriodicAllowance` and seeds `period_can_spend` with the full
  period limit so the grant is usable immediately.
- **`updateAllowance`** edits one. `x/feegrant` rejects `MsgGrantAllowance` when a grant for
  that granter/grantee pair already exists and there's no update message, so an edit is a
  `MsgRevokeAllowance` followed by a `MsgGrantAllowance`, broadcast **as one transaction** — the
  grant is never left revoked if the second message fails.
- **`revokeAllowance`** removes a single grant; **`revokeAll`** revokes a list in one
  transaction ("suspend everything").
- **`queryGrantsByGrantee`** (v0.43+, always available) lists what an address may spend.
  **`queryGrantsByGranter`** (v0.46+) lists what an address has given out; on an older node it
  throws `GranterQueryUnsupported`, which callers should catch and fall back to a locally
  remembered list of grantees, verified one by one — this app does exactly that in
  `useGrants`/`registry.ts`, and says so in the UI when it's running in that mode.

Every write here takes an optional `feeGranter` and passes it straight through as
`auth_info.fee.granter` — nothing is implicit.

### A note on signing

Request Keplr's **direct**-capable signer (`getOfflineSigner`, not the amino-only variant).
secretjs's amino signing path serialises an allowance `Timestamp` as `{ seconds, nanos }` rather
than RFC 3339, which an amino-only signer (a Ledger, for instance) rejects.

---

## Gas credits: fee grants from a contract instead of a wallet

A **gas credit** is nothing new at the protocol level — it's an ordinary `BasicAllowance` fee
grant, read and spent exactly like any other with the SDK above. What's different is the
**granter**: instead of a wallet, it's `contracts/gas-vault`, a CosmWasm contract that issues the
grant itself via `CosmosMsg::Stargate`. Pay it SCRT with a grantee address, and it grants that
address the same amount, **payable from the contract's own balance** — so the grantee's ability
to spend doesn't depend on whoever bought the credit staying funded afterwards. That's the
difference from a wallet-issued grant, and the whole reason to use one: a bridge or an event
sponsor handing out gas to strangers, at scale, without minding its own accounts one by one.

Confirmed working end to end on pulsar-3 — see `contracts/gas-vault/README.md` for the on-chain
evidence, the deployed address, and how to deploy your own instance. Not yet run on secret-4.

### Buying gas credit (`src/lib/gasVault.ts`)

```ts
import { buyGasCredit, queryVaultSolvency, GAS_BUY } from "./gasVault";

const tx = await buyGasCredit(
  client,
  vaultAddress,     // the gas-vault contract
  senderAddress,    // who pays
  granteeAddress,   // who receives the allowance
  "1.5",            // human decimal string, in SCRT
  feeGranter,       // optional — who pays *this* transaction's own fee
);
```

Under the hood this executes `{ grant: { grantee } }` on the contract with the SCRT attached as
`sent_funds` — the payment and the grant happen in one transaction. `GAS_BUY` (`400_000`) is the
gas limit to size that transaction with; it covers the execute plus the grant message the
contract dispatches (and a revoke, when the call tops up an existing grant instead of creating a
new one — `x/feegrant` rejects a second `MsgGrantAllowance` for the same pair, so the contract
revokes and re-grants for the new total, same as `updateAllowance` above).

**Buying again for the same grantee raises the allowance to the new total** rather than adding
to what's left — size the payment for the total you want outstanding, not the top-up amount.

```ts
const { outstanding, balance } = await queryVaultSolvency(client, vaultAddress);
```

`Solvency` reports what the contract has promised (`outstanding`) against what it actually holds
(`balance`). A grant is a promise, not an escrow — `x/feegrant` reserves nothing on the chain
side — so a vault that issued more than it holds would leave some stranger's transaction failing
at the fee step. The contract tracks this itself and refuses to over-commit; querying solvency
before a large purchase is how the dashboard's "Buy gas credit" form shows the vault is healthy.

The contract's code hash is **always read from the chain**, never hardcoded — `codeHashFor`
caches it for the page's lifetime only. A migration changes the hash, and a stale one doesn't
degrade gracefully, it stops every query dead, so it's cheaper to re-fetch once per load than to
risk that.

### Spending gas credit

There is no separate API for this — that's the point. Once bought, gas credit **is** a fee grant
with `granter = vaultAddress`, so the grantee's application uses the exact same
`fetchFeeGrants` → `selectFeeGrant` flow as any other grant:

```ts
const grants = await fetchFeeGrants(LCD_URL, myAddress);
const { granter } = selectFeeGrant(grants, { fee, msgTypeUrls });
// granter === vaultAddress when the credit is what ends up paying
```

One consequence of the ranking rules above worth knowing: gas credit is always a `BasicAllowance`
(rule 1, "recurring before one-time"), so in `auto` mode a wallet-issued periodic grant will
outrank it even when the credit has more left. Use `mode: "select"` with the vault's address if
a caller specifically wants to draw down the credit first.

### Properties worth knowing before relying on this

- **A fixed pot, non-transferable.** The allowance is always a `BasicAllowance` — no period, no
  refill. The chain deletes it once spent. The grantee never holds the underlying coins; they
  move directly from the contract to the fee collector, so credit can't be cashed out.
- **1:1 with what was paid.** No fee, no markup, no minimum.
- **Buying gas costs gas.** Calling the contract is itself a transaction, so a brand-new address
  can't bootstrap its own first credit — this is built for a sponsor buying on someone else's
  behalf, not a self-service faucet.
- **No message restriction.** The contract issues a plain `BasicAllowance`, not an
  `AllowedMsgAllowance`, so the credit can pay the fee on any transaction — same as a wallet's
  own unrestricted grant.

### Deploying your own vault

`NEXT_PUBLIC_GAS_VAULT_ADDRESS` (pulsar-3) and `NEXT_PUBLIC_GAS_VAULT_ADDRESS_MAINNET` point this
dashboard at a deployed vault — hardcoded per chain, not user-configurable at runtime. Leaving
either unset keeps the built-in default (this repo's own pulsar-3 deployment; mainnet has none
yet, so **Buy gas credit** stays hidden there until one is set). Building, deploying and
verifying your own instance is covered start to finish in `contracts/gas-vault/README.md`.

### Paying with a SNIP-20 instead of SCRT

The vault takes native `uscrt` and nothing else, so holding sSCRT or stkd-SCRT would
otherwise mean unwrapping or selling in a separate transaction first — and the amount that
comes out cannot be known when the transaction is signed. `contracts/swap-and-grant` closes
that gap: it takes the token, redeems or swaps it, and pays the vault, all in one signature,
reading the runtime amount in a `reply`. The vault itself is untouched.

Set `NEXT_PUBLIC_SWAP_AND_GRANT_ADDRESS_MAINNET` and a token picker appears in **Buy gas
credit**; the stkd-SCRT route additionally needs the four ShadeSwap variables in
`.env.example`, which the contract's deploy script reads off the chain and prints for you.
Nothing keys off the chain id — with no executor address set, everything behaves exactly as
it did before, which is also what pulsar-3 gets, since ShadeSwap is deployed on secret-4
only.

Two things to know before relying on it: the swap path quotes `min_out` from the pool for
every trade, because stkd-SCRT is a staking derivative whose rate against SCRT is above one
and rising — parity would be no bound at all. And the whole chain of calls is deep enough
that its gas cost is the open question, not a detail; see `contracts/swap-and-grant/README.md`.

## Project layout

```
src/
  app/          layout, page, design tokens (globals.css)
  components/   dashboard, cards, rows, modals, wallet menu
  hooks/        wallet context, grant loading, app-wide fee payer
  lib/
    feegrant-sdk.ts   standalone: fetch, parse and choose a fee grant
    feegrant.ts       grant/edit/revoke transactions, built on the SDK
    gasVault.ts       buy gas credit from the vault contract, query solvency
    chains.ts         chain registry (secret-4 / pulsar-3)
    keplr.ts          wallet connection
    bank.ts           balance and send
    history.ts        activity search
scripts/
  test-feegrant-sdk.ts
contracts/
  gas-vault/    the CosmWasm contract gas credits are issued from
```

`feegrant-sdk.ts` deliberately imports nothing else in this repo, so it can be lifted out on its
own; `feegrant.ts` and `gasVault.ts` both build on it rather than re-parsing allowances
themselves.

## Status

Not yet implemented: wallets other than Keplr, `AllowedMsgAllowance` creation (existing ones are
displayed and can be revoked), and grant history. The gas vault is confirmed working on
pulsar-3 only.
