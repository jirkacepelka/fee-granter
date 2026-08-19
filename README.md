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
| `NEXT_PUBLIC_SECRET_LCD_URL` | `https://api.pulsar3.scrtlabs.com/api` |
| `NEXT_PUBLIC_SECRET_RPC_URL` | `https://rpc.pulsar3.scrtlabs.com/rpc` |
| `NEXT_PUBLIC_EXPLORER_TX_URL` | `https://testnet.ping.pub/secret/tx/{hash}` |

Public testnet endpoints go down fairly often. If queries start failing, swap the LCD URL for
one of the alternates listed in `.env.example`.

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
