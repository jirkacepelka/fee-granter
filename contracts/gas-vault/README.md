# gas-vault

A spike answering one question: **can a CosmWasm contract on Secret Network issue a fee
grant?** If it can, a bridge or sponsor can pay SCRT in and have the contract grant that
allowance to any address — no keeper, no hot key, no off-chain service.

Send it SCRT with a grantee address, and it grants that address the same amount as a fee
allowance payable from the contract:

```json
{ "grant": { "grantee": "secret1…" } }
```

## What has been verified

Reading `scrtlabs/secretnetwork` at `95d87ae` (master, 2026-07-02), and by building and
testing this contract:

| Claim | Evidence |
| --- | --- |
| `CosmosMsg::Stargate` exists | `secret-cosmwasm-std` 1.1.11, feature `stargate` |
| The chain advertises the capability | `app/keepers/keepers.go:525` — `supportedFeatures := "staking,stargate,ibc3,random"` |
| This contract asks for it | `requires_stargate` is exported by the built wasm |
| No allow-list of message types | `x/compute/internal/keeper/handler_plugin.go:463` `EncodeStargateMsg` unpacks any registered `sdk.Msg` |
| `MsgGrantAllowance` is registered | `app/modules.go:74`, keeper at `app/keepers/keepers.go:253` |
| A contract may grant **for itself** | `handler_plugin.go:580` requires every signer of a dispatched message to equal the contract address — which is what "the contract is the granter" means |
| The protobuf is on the wire correctly | `cargo test` decodes the Stargate payload back and checks every field |

```bash
cargo test                                          # 9 tests
cargo build --release --target wasm32-unknown-unknown
```

## Confirmed on pulsar-3

Deployed and exercised end to end. The contract issued a fee grant, and the grant was read back
off the chain afterwards:

| | |
| --- | --- |
| Contract | `secret16wmu0cy4ukh2g50qt7n0q62esmcz62sgrz0h8f` |

The granter is the **contract**, not the wallet that paid — which is the whole point, and the
thing the source reading above predicted.

An earlier deployment, `secret1g6aw3d26kkd88yduqxaf7axffj3xfjvuklh4jf` (code id 79), proved the
same thing on 23 August 2026 but ran the accounting described under *Solvency, and the bug that
was not there*. It wedges shut the first time a grantee spends any of the allowance and has no
`migrate` entry point to repair, so it is superseded rather than kept.

Still open: this has not been run on `secret-4`. The evidence and the deployments are all
pulsar-3, and mainnet may run an older version without the stargate encoder.

## Running it

All commands run from the repository root unless stated otherwise, and Node 22.6+ is required
for `--experimental-strip-types` (`node --version`).

### 1. Build a deployable artifact

The chain rejects wasm built by a host toolchain — Rust 1.82+ emits the `reference-types` and
`multivalue` proposals that Secret refuses at upload. Use the pinned optimizer, which also makes
the artifact hash reproducible from a commit:

```bash
cd contracts/gas-vault
docker run --rm -v "$PWD":/contract -w /contract \
  ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13
cd ../..
```

PowerShell — the mount needs `${PWD}` inside the quotes, because a bare `$PWD` expands to an
object Docker will not accept:

```powershell
cd contracts\gas-vault
$img = "ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13"
docker run --rm -v "${PWD}:/contract" -w /contract $img
cd ..\..
```

The image goes in a variable so no line is long enough to be broken up when pasted — a
`docker run` split across two lines runs once without an image and then tries to execute the
image name as a program.

Optimizer 1.0.13 writes into `optimized-wasm/`; older images wrote `contract.wasm.gz` into the
project root. The deploy script looks in both, so either layout works — check the build printed
`Finished \`release\` profile` and move on.

### 2. Get a funded account

Any mnemonic works; you need the amount you intend to grant plus roughly 1.5 SCRT for fees. On
pulsar-3, top up at <https://faucet.pulsar.scrttestnet.com>.

### 3. Deploy

```bash
MNEMONIC="your twelve words …" \
  node --experimental-strip-types contracts/gas-vault/scripts/deploy.ts
```

PowerShell has no `VAR=value command` form, so set it first:

```powershell
$env:MNEMONIC = "your twelve words …"
node --experimental-strip-types contracts/gas-vault/scripts/deploy.ts
```

It uploads and instantiates, and prints the address. That is the whole job: issuing grants
belongs in the app, not in a terminal.

Add `GRANTEE` to also buy an allowance and **read the resulting grant back off the chain**,
failing loudly if it is not there. Worth doing once per chain, because it is the only convincing
proof that the chain lets a contract be a granter — a transaction that returns without error is
not evidence, the grant existing afterwards is. `AMOUNT` sets how much, in uscrt, default 1 SCRT.

Point it at a different node with `LCD_URL` if the default is down.

The contract is instantiated with the deploying address as **admin**, so it can be migrated.
That is deliberate: `Remaining` depends on a query allow-list the chain reserves the right to
change, and an immutable contract could not be repaired if it did. The cost is that the admin
key can migrate the vault to code that empties it, so it is worth the same care as any hot key —
`secretd tx compute clear-contract-admin` gives that up permanently if you would rather not
hold it.

### 3b. Mainnet

The same script, naming the chain and confirming it:

```powershell
$env:CHAIN    = "secret-4"
$env:CONFIRM  = "secret-4"
$env:MNEMONIC = "your twelve words …"
node --experimental-strip-types contracts/gas-vault/scripts/deploy.ts
```

`CONFIRM` exists because deploying here spends real SCRT, and because anything later paid into
this contract cannot come back out: it has **no withdrawal**, and every uscrt in it leaves only
as somebody's gas. Deploying alone risks only the fees; that limit disappears the moment a
`GRANTEE` is named.

Deploying without a `GRANTEE` proves nothing about whether this chain can dispatch the grant —
the first purchase does that, and does it safely: the funds move in the same transaction as the
grant, so a chain that cannot dispatch it returns them. The cost of finding out is the gas, not
the amount. Rehearse on pulsar-3 first anyway; it is the same script.

### 4. Wire it into the dashboard

Deploying is a one-off; using it belongs in the app. Put the contract address from step 3 into
**Settings → Gas vault contract** and a **Buy gas credit** button appears beside *New fee
grant*. From then on nobody needs the terminal: pick an address, pick an amount, and the
contract issues the allowance.

On pulsar-3 the deployment below is already the built-in default, so that field only needs
filling in to point somewhere else. `NEXT_PUBLIC_GAS_VAULT_ADDRESS` changes the default for
everyone rather than per browser.

### 5. Spend it

The grantee still has to ask for the grant — a fee grant is never applied automatically. Set
`fee.granter` to the contract address, or use the dashboard in this repo: connect as the
grantee, and the contract's grant appears under **Settings → Transaction fees**.

### If the upload is rejected

`Error parsing into type ... unknown variant` or a capability error at upload means the chain
running `pulsar-3` is older than the code this was checked against (master, 2026-07-02) and
lacks the stargate encoder. Check what the node reports:

```bash
curl -s https://pulsar.lcd.secretnodes.com/cosmos/base/tendermint/v1beta1/node_info | jq .application_version
```

## Design notes

**Solvency, and the bug that was not there.** `x/feegrant` reserves nothing, so a contract that
issued more than it holds would leave a stranger's transaction failing at the fee step. The first
version of this contract answered that with a ledger: it added up what it had granted and
refused to promise past its balance.

That was both unnecessary and harmful.

Unnecessary, because the two figures cannot drift apart. A purchase raises the balance and the
allowances outstanding by the same amount. A granted fee, when spent, lowers both by the same
amount — `x/auth`'s `DeductFeeDecorator` sets `deductFeesFrom = feeGranterAddr`, so the fee comes
out of the contract, while `UseGrantedFees` takes it off the allowance. **Balance is the sum of
the outstanding allowances, identically**, which is why `Status {}` reports one figure and not
two. Anyone sending SCRT here without buying credit only moves it the safe way.

Harmful, because the ledger only counted upwards. Spending was invisible to it, so a spent uscrt
left the balance and stayed on the books. The check `outstanding + paid > balance + paid` reduces
to `outstanding > balance`, which the first spent uscrt made true forever: the vault refused
every subsequent purchase, permanently. It passed its tests because nothing in them ever spent
a grant.

What the contract does need is the *live* figure for the one grantee being topped up, since
re-granting what it issued last time would re-promise fees already spent. It reads that from
`/cosmos.feegrant.v1beta1.Query/Allowance`, which Secret allows from a contract
(`x/compute/internal/keeper/query_plugins.go:177`). `AllowancesByGranter` is deliberately not
allowed — only O(1) lookups are — which is the reason a contract cannot total its own book even
if it wanted to.

Three answers have to be told apart, and the contract does: a figure, an absent grant (drained to
zero or revoked, so nothing is owed), and a query that could not be made. The last one refuses the
top-up rather than guessing. A first-time buyer is never asked about at all, so the commonest
path keeps working even if that allow-list changes.

**Topping up is revoke + grant.** `MsgGrantAllowance` is rejected when a grant already exists
and there is no update message, so a second payment emits a revoke followed by a grant for the
new total. Both ride in one transaction, so the grant is never left revoked.

**The allowance is a `BasicAllowance`** — a fixed pot with no period, so it never refills. The
chain deletes the grant once it is spent. This is what makes the credit 1:1 with what was paid,
non-transferable, and impossible to cash out: the grantee never holds the coins, they only ever
move from the contract to the fee collector.

**Buying gas costs gas.** Calling this contract is a transaction, so a brand-new address cannot
bootstrap itself. That is fine for the case it is built for — a bridge or sponsor calling on
someone's behalf — but it is not a self-service faucet.
