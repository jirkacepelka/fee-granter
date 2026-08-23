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
optimizer image could be pulled. Everything above is source reading plus unit tests; the
end-to-end path — upload, instantiate, execute, then read the grant back out of
`/cosmos/feegrant/v1beta1/allowances/{grantee}` — is still open.

Two things to settle before trusting it:

1. **Run it on LocalSecret.** `docker run -d -p 1317:1317 -p 26657:26657 ghcr.io/scrtlabs/localsecret:v1.24.0`,
   upload, instantiate, fund, execute, and query the grantee's allowances.
2. **Check the deployed chain version.** The evidence above is from master. `secret-4` and
   `pulsar-3` may run something older that lacks the stargate encoder.

**The wasm in `target/` is not deployable.** It is a host build with Rust 1.94, which emits
the `reference-types` and `multivalue` proposals that Secret rejects at upload. Build with the
pinned optimizer for anything real:

```bash
docker run --rm -v "$PWD":/contract -w /contract \
  ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13
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
