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

## What has NOT been verified

**It has never run on a chain.** The egress policy of the environment this was written in
denied `pkg-containers.githubusercontent.com`, so neither LocalSecret nor the contract
optimizer image could be pulled, and the public testnet endpoints were unreachable too.
Everything above is source reading plus unit tests. The end-to-end path is scripted but unrun —
see **Running it on pulsar-3** below.

The one thing that could still make it fail: the evidence above is from master at
`95d87ae` (2026-07-02), and `pulsar-3` may run something older that lacks the stargate encoder.
That shows up as a rejection at upload.

## Running it on pulsar-3

### 1. Build a deployable artifact

The chain rejects wasm built by a host toolchain — Rust 1.82+ emits the `reference-types` and
`multivalue` proposals that Secret refuses at upload. Use the pinned optimizer, which also makes
the artifact hash reproducible from a commit:

```bash
cd contracts/gas-vault
docker run --rm -v "$PWD":/contract -w /contract \
  ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13
```

That writes `contract.wasm.gz`, which the deploy script picks up automatically.

### 2. Get a funded testnet account

Any mnemonic works; you need roughly 2 SCRT to cover the upload. Top it up at
<https://faucet.pulsar.scrttestnet.com>.

### 3. Deploy and prove it

```bash
cd ../..            # repo root, where secretjs is installed
MNEMONIC="your twelve words …" \
GRANTEE="secret1…the address that should get the allowance" \
  node --experimental-strip-types contracts/gas-vault/scripts/deploy-pulsar.ts
```

It uploads, instantiates, buys 1 SCRT of allowance (override with `AMOUNT`, in uscrt), then
**reads the grant back off the chain** and fails loudly if it is not there. A transaction that
returns without error is not evidence; the grant existing afterwards is.

Point it at a different node with `LCD_URL` if the default is down.

### 4. Spend it

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
