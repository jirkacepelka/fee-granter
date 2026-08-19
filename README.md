# Fee Granter

A fee grant dashboard for [Secret Network](https://scrt.network), currently targeting the
**pulsar-3 testnet** only. Connect Keplr to see every address whose transaction fees you are
covering, how much of each allowance is left, and create, edit or revoke grants.

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

## Configuration

Everything network-related is an environment variable, so you can point the app at a
different node without touching code. See `.env.example`.

| Variable | Default |
| --- | --- |
| `NEXT_PUBLIC_SECRET_LCD_URL` | `api.pulsar3.scrtlabs.com/api`, then three fallbacks |
| `NEXT_PUBLIC_SECRET_RPC_URL` | `rpc.pulsar3.scrtlabs.com/rpc`, then two fallbacks |
| `NEXT_PUBLIC_EXPLORER_TX_URL` | `https://testnet.ping.pub/secret/tx/{hash}` |

Public pulsar-3 nodes go down often. Both endpoint settings therefore take a
**comma-separated list**: the app probes each in order and uses the first that answers with
JSON *and* reports `pulsar-3`, so a dead node fails over instead of breaking the page. Set a
single URL to pin one node.

### When a node is down

A dead node usually still answers at the HTTP level — a gateway returns an HTML error page.
Parsing that as JSON is what produces `Unexpected token '<', "<!DOCTYPE "... is not valid
JSON`, an error that says nothing about the real cause. The app checks the response body
rather than the status code, and reports which nodes it tried and what each returned:

```
Could not reach a working pulsar-3 node.
  • https://api.pulsar3.scrtlabs.com/api — returned an HTML page, not JSON (HTTP 502)
  • https://pulsar.lcd.secretnodes.com — unreachable (network error or CORS blocked)

Set NEXT_PUBLIC_SECRET_LCD_URL to a node you trust and reload.
```

The RPC endpoint is only handed to Keplr, which checks it itself during the chain
suggestion, so a dead RPC surfaces at connect time and is reported separately.

## How fee grants are modelled

Grants are created as a cosmos-sdk **`PeriodicAllowance`**, which is what the design's
"X SCRT / day" implies:

- `period` — the window (hour, day, week or 30 days).
- `period_spend_limit` — the most the grantee can spend on fees per window. Seeded into
  `period_can_spend` at creation so the grant is usable immediately; the chain resets it every
  period.
- `basic.spend_limit` — an optional lifetime cap. Left empty for an uncapped grant.
- `basic.expiration` — an optional expiry date.

The two summary cards aggregate across all grants:

- **Current max spending** — the sum of every `period_spend_limit`, with the usage bar showing
  `(limit − period_can_spend) / limit`.
- **Total fee granted** — the sum of every lifetime cap. Grants with no cap are called out
  separately rather than silently counted as zero.

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
  lib/          chain config, Keplr, feegrant domain logic, formatting
```

## Status

Not yet implemented: mainnet (`secret-4`) support, wallets other than Keplr,
`AllowedMsgAllowance` creation (existing ones are displayed and can be revoked), and
grant history.
