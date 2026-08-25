# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A fee grant dashboard for Secret Network (`secret-4` mainnet and the `pulsar-3` testnet),
built from a Figma design. Next.js 15 App Router, TypeScript, CSS Modules, secretjs, Keplr.

## Commands

```bash
npm run dev        # dev server
npm run build      # production build
npm run start      # serve the production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run test:sdk   # fee grant selection tests
```

`test:sdk` runs `scripts/test-feegrant-sdk.ts` directly through Node's
`--experimental-strip-types` — no bundler, no test framework. It is a flat list of
assertions with no filtering; to run a subset, comment out `check(...)` calls. Keep it
runnable that way, since the SDK is meant to be copied into other projects.

`tsconfig.json` sets `allowImportingTsExtensions` so that script can import
`../src/lib/feegrant-sdk.ts` by path.

**Do not run `npm run build` while a dev server is running** — the build replaces `.next`
underneath it and the dev server then 500s on missing chunks. Stop it, or use a different port
for `next start`.

## Architecture

### The SDK boundary

`src/lib/feegrant-sdk.ts` is deliberately **standalone**: no React, no secretjs, and no imports
from anywhere else in the repo. It is published as a copy-paste module (see the README's
"Using fee grants in your own app"), so keep it that way — anything needing a dependency
belongs in `feegrant.ts` instead.

The split is read vs. write:

- **`feegrant-sdk.ts`** — fetch grants by grantee, parse allowances, decide which grant pays.
  `selectFeeGrant` is the entry point; `mode` defaults to `auto`.
- **`feegrant.ts`** — everything needing secretjs: grant, edit, revoke, revoke-all. Re-exports
  `FeeGrant`, `parseGrant`, `availableFee` from the SDK so there is one parser, not two.

### Fee payment is app-wide, not per-screen

`FeePayerProvider` (`src/hooks/useFeePayer.tsx`) resolves who pays for **every** transaction,
from the preference in Settings. A new transaction must pass
`granterFor(gasLimit, msgTypeUrls)` into its tx options — there is no second place to update.
The message type URLs matter: they are checked against `AllowedMsgAllowance` restrictions so a
grant is rejected up front rather than by the chain.

Provider order in `src/app/layout.tsx` is `Settings → Wallet → FeePayer → Toast`, and each
depends on the one above it.

### Chains are runtime state

`src/lib/chains.ts` is a registry keyed by `ChainId`, not a set of constants. Anything
chain-specific — endpoint resolution, `localStorage` keys in `registry.ts`, explorer links,
Keplr's chain suggestion — is keyed by the active chain. Never reintroduce a module-level
chain constant.

### Endpoints are probed, never trusted

`src/lib/endpoint.ts` exists because a dead public node usually answers at the HTTP level with
an HTML error page, which surfaces as `Unexpected token '<'` from deep inside secretjs.
`resolveLcdUrl` tries each candidate and accepts the first that returns JSON **and** reports
the expected chain id. Endpoint settings are comma-separated lists. Use `fetchJson` for new
direct LCD calls, and `describeNetworkError` before showing a caught error to a user.

### Version tolerance is load-bearing

Node versions differ in ways that silently break things, so several places accept multiple
shapes. Do not "simplify" these away:

- `Duration` arrives as `"86400s"` or `{seconds, nanos}`; `Timestamp` as RFC 3339 or
  `{seconds, nanos}`.
- `AllowancesByGranter` (`/issued/`) is cosmos-sdk v0.46+; when a node lacks it, `useGrants`
  falls back to verifying grantees remembered in `localStorage` (`registry.ts`) and the UI says
  so. `Allowances` (by grantee) is v0.43+ and needs no fallback.
- `src/lib/history.ts`: the tx search parameter changed (`events=` up to 0.47, `query=` from
  0.50) and a node given the wrong one may answer `200` with an empty list — so an empty
  result means "try the next spelling", never "there is nothing". Transfer amounts come from
  `tx.body.messages`, not `logs`, because `logs` is empty from SDK 0.50 and because every
  transaction pays a fee that an event-based reading counts as a send.

### Signing

Keplr's **direct** signer is requested on purpose (`getOfflineSigner`, not the amino-only
variant). secretjs's amino path serialises allowance `Timestamp`s as `{seconds, nanos}` rather
than RFC 3339, which an amino-only signer such as a Ledger rejects.

## Conventions

- Amounts are handled as strings and `BigInt` end to end — `toMicroUnits` / `fromMicroUnits`
  in `format.ts`. No floats anywhere near a balance.
- Figma values live as custom properties in `src/app/globals.css`. Components reference tokens,
  not hex. The light theme redefines the same tokens; anything on the accent keeps `#ffffff`
  text explicitly, since `--color-text` inverts.
- Icons are Lucide, with an explicit `size` per use.
- The design specifies Google Sans Flex, which is not publicly distributed; Figtree stands in.

## Behaviour worth knowing before changing it

- **Editing a grant is revoke + grant in one transaction.** `x/feegrant` rejects
  `MsgGrantAllowance` when a grant already exists and has no update message. One transaction
  means the grant is never left revoked if the second message fails.
- **A fee grant is never applied automatically.** The spending transaction must set
  `auth_info.fee.granter`; Keplr does not fill it in.
- **A grant does create the grantee's account.** `GrantAllowance` calls
  `NewAccountWithAddress` when the grantee is not in state (cosmos-sdk 0.50 `x/feegrant`
  `keeper.go`), and the pubkey is filled in from the first signature. So an address holding
  nothing can transact on a grant alone — which is what the community fee grant faucet relies
  on.
- Empty results from history or grant listing mean "nothing found" — never present them as
  proof that nothing exists.

## Constraints that have already been checked

Do not re-litigate these; they were verified against the chain's module list and cosmos-sdk
behaviour:

- A SNIP-20/CW20 token cannot pay gas. `Fee.amount` is `Coin[]` — bank denominations only —
  and Secret ships no `tokenfactory`, `txfees` or fee-abstraction module.
- An account-wide spending cap cannot be enforced. `x/feegrant` knows only per-grant limits. A
  ceiling setting was built and then removed for pretending otherwise.
- A grant cannot exist before the grantee's address is known: `MsgGrantAllowance` is signed by
  the granter and names the grantee, so a voucher/QR scheme needs something that signs on
  redemption — an off-chain service, or a contract (see below).
- A contract **can** be that signer, and this is **confirmed on pulsar-3**, not just inferred:
  `contracts/gas-vault` issues fee grants via `CosmosMsg::Stargate`, and the resulting grant
  names the contract as granter. Secret advertises the `stargate` capability and its compute
  module applies no allow-list of message *types*, but requires every signer of a dispatched
  message to be the contract itself — so a contract may grant only from its own balance. The
  deployment details are in that README. Not yet exercised on `secret-4`.
- Stargate **queries** are a different matter: those *are* allow-listed
  (`x/compute/internal/keeper/query_plugins.go`). `/cosmos.feegrant.v1beta1.Query/Allowance` is
  on the list, `AllowancesByGranter` deliberately is not — only O(1) lookups are — and the
  chain reserves the right to change it. That is why the vault is deployed with an admin.
- A gas vault cannot become insolvent, and needs no ledger to prevent it. A purchase raises its
  balance and its outstanding allowances by the same amount; a spent fee lowers both by the
  same amount, because `x/auth` charges the fee to the granter. A ledger that only counted
  upwards was what bricked the first version — see that contract's README.

## Environment

All endpoints and the price API come from `NEXT_PUBLIC_*` variables (see `.env.example`);
Settings overrides them per chain at runtime. Prices are only fetched on mainnet — testnet SCRT
shows "No price" rather than a fabricated number, and Osmosis falls back to CoinGecko.
