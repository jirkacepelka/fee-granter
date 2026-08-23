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
cargo test                                          # 5 tests
cargo build --release --target wasm32-unknown-unknown
```

## Confirmed on pulsar-3

Deployed and exercised end to end on 23 August 2026. The contract issued a fee grant, and the
grant was read back off the chain afterwards:

| | |
| --- | --- |
| Contract | `secret1g6aw3d26kkd88yduqxaf7axffj3xfjvuklh4jf` |
| Code id | 79 |
| Code hash | `998473c0e1e3a8a1335ea695042b6de2b4503376b8679bdd5fda601b35bee021` |
| Upload | `A2EB7B48A5B5A3D76BA8069B379333E555F5B454252EC78A6D919AB02DBAD795` |
| Instantiate | `53786DE31B27844B39BF18787AE2F6D504C1601B21D7F7337DE9C421ECB5D060` |
| Buy 1 SCRT of credit | `EC38B953B3EBD9F3A0C98B2D5F5349B96C10241AD017EF75ED9342D44231FDB0` |

The resulting grant, from `/cosmos/feegrant/v1beta1/allowances/{grantee}`:

```json
{
  "granter": "secret1g6aw3d26kkd88yduqxaf7axffj3xfjvuklh4jf",
  "grantee": "secret1nfuen7f7ntrwqud7rzl4zu88kkerx0ykn6axhs",
  "allowance": {
    "@type": "/cosmos.feegrant.v1beta1.BasicAllowance",
    "spend_limit": [{ "denom": "uscrt", "amount": "1000000" }],
    "expiration": null
  }
}
```

The granter is the **contract**, not the wallet that paid — which is the whole point, and the
thing the source reading above predicted.

Still open: this has not been run on `secret-4`. The evidence and the deployment are both
pulsar-3, and mainnet may run an older version without the stargate encoder.

## Running it on pulsar-3

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

### 2. Get a funded testnet account

Any mnemonic works; you need roughly 2 SCRT to cover the upload. Top it up at
<https://faucet.pulsar.scrttestnet.com>.

### 3. Deploy and prove it

```bash
MNEMONIC="your twelve words …" \
GRANTEE="secret1…the address that should get the allowance" \
  node --experimental-strip-types contracts/gas-vault/scripts/deploy-pulsar.ts
```

PowerShell has no `VAR=value command` form, so set them first:

```powershell
$env:MNEMONIC = "your twelve words …"
$env:GRANTEE  = "secret1…the address that should get the allowance"
node --experimental-strip-types contracts/gas-vault/scripts/deploy-pulsar.ts
```

It uploads, instantiates, buys 1 SCRT of allowance (override with `AMOUNT`, in uscrt), then
**reads the grant back off the chain** and fails loudly if it is not there. A transaction that
returns without error is not evidence; the grant existing afterwards is.

Point it at a different node with `LCD_URL` if the default is down.

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

**A grant is a promise, not an escrow.** `x/feegrant` reserves nothing, so a contract that
issued more than it holds would leave a stranger's transaction failing at the fee step. The
contract therefore tracks what it owes and refuses to over-commit — `Solvency {}` reports both
sides.

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
