# swap-and-grant

Buy gas credit from [`contracts/gas-vault`](../gas-vault) with a SNIP-20 instead of native
SCRT, in one signature.

The vault takes native `uscrt` as `info.funds` and nothing else. Holding sSCRT or stkd-SCRT
therefore means unwrapping or selling first, in a separate transaction. That cannot be
collapsed by hand: `funds` and `Redeem.amount` are fixed in the signed transaction body, so
message three cannot use what message two produced. Only a contract, reading the value at
run time in `reply`, can.

**The vault is not modified and not trusted with anything new.** This contract is just
another address paying it `uscrt`.

```json
{ "buy_credit": { "grantee": "secret1…", "min_out": "4820000" } }
```

base64-encoded into the `msg` of a SNIP-20 `Send` addressed to this contract.

## Two ways in, one tail

| | |
| --- | --- |
| **sSCRT** | No swap, no reply. The amount is already known from `Receive` and redeeming is one for one. Two ordinary messages: `Redeem`, then the vault's `Grant`. |
| **a routed token** (stkd-SCRT) | One `reply_on_success` hop through the ShadeSwap router, then the same tail. |

The tail is byte-for-byte the same code, called from `execute` in one case and `reply` in
the other. That is the whole argument for one contract rather than two.

## What has been verified

Reading `securesecrets/shadeswap` and `scrtlabs/snip20-reference-impl` at `main`, and by
building and testing this contract:

| Claim | Evidence |
| --- | --- |
| The router's payload is `InvokeMsg::SwapTokensForExact { path, expected_return, recipient }` | `packages/shadeswap-shared/src/msg.rs`, module `router` |
| `Hop` is `{ addr, code_hash }` — `addr`, not `address` | same file |
| **The router drives its own hops with `SubMsg::reply_always`**, keeping state in `CurrentSwapInfo` | `contracts/router/src/operations.rs`, `src/state.rs` |
| `expected_return` is checked at the end of the chain and errors when unmet | `operations.rs`, `next_swap` |
| The router delivers output with a SNIP-20 **`Send`** carrying `recipient_code_hash: None` | `packages/shadeswap-shared/src/core/token_type.rs`, `create_send_msg` |
| A token invokes `Receive` only when the send names a code hash, or the recipient registered one | `snip20-reference-impl`, `try_add_receiver_api_callback` |
| The emitted messages match those shapes on the wire | `cargo test` decodes every one back and checks it field by field |
| This wasm demands no chain capability | the built artifact exports `reply` and no `requires_*` |

```bash
cargo test        # 28 tests
```

## Design notes

**The swap's output is measured, never taken on trust.** The received amount is the
difference in this contract's own sSCRT balance either side of the swap, not a number
parsed out of the router's answer. That is not merely distrust of a foreign response
format. The router drives its hops with `reply_always`, so *its* handler decides whether a
failed hop propagates or is swallowed — and a swallowed one would come back looking like
success with nothing delivered. Two tests cover exactly that case.

`min_out` is then checked again here, against the measured difference. Passing it to the
router as `expected_return` is only convenience: the router is a foreign, admin-switchable
contract, so the check that carries the safety has to be ours.

**Never registering a receive callback is a security property.** A SNIP-20 calls the
recipient's `Receive` only when the send names a code hash or the recipient registered one.
The router delivers with `recipient_code_hash: None`, so staying unregistered means the
router's delivery of swap output cannot re-enter this contract at all. The buyer's own send
names the code hash explicitly instead — which is why `sendToContract` in
`src/lib/snip20.ts` always passes it.

**A payload-less arrival is accepted and ignored, not refused.** Anyone may send with an
explicit code hash, and erroring on an empty payload would let a stranger break every
purchase in flight. Nothing is promised, and the tokens become sweepable.

**Re-entrancy is refused outright.** Foreign code runs between `Receive` and `reply`; a
nested call would overwrite the balance snapshot and make the difference meaningless. A
second purchase cannot start while one is in flight. The lock cannot stick: storage rolls
back with a failed transaction, so it can never be left set with no reply coming.

**"The swap went through but the grant did not" has no path.** `Redeem` and `Grant` are
ordinary messages, never submessages, so a failure propagates and takes the transaction
down rather than being observed and continued past. There is exactly one `reply` in this
contract and it is `on_success`. *No `reply_always` anywhere in here* is an invariant worth
checking in review, not only in tests.

**The vault's address is frozen; only its code hash can be corrected.** Redirecting the
vault is the one route to taking someone's money and delivering nothing, so an admin cannot
do it. But the vault is migratable and migrating changes its code hash, which this contract
pins — so `SetCodeHashes` fixes that without letting anything point anywhere else. A wrong
hash only makes calls fail.

**No migrate admin.** Deployed immutable. This contract holds nothing between transactions,
depends on no query allow-list (unlike the vault, which stands on a Stargate query the chain
reserves the right to withdraw), and the one thing that would otherwise force a migration is
covered above. The in-contract admin can still repoint the router and the routes — bounded,
because the damage a hostile router could do is capped by the caller's own `min_out`.

**Stray tokens go to the vault, not to anyone's credit.** `SweepToVault` is unpermissioned
because nobody gains by calling it: the money becomes backing for grants already issued,
which the vault documents as the safe direction.

## Invariants

| | |
| --- | --- |
| **I1** | The contract holds nothing at rest — sSCRT, every routed token, and native `uscrt`. `Balances {}` reports all three, and should read zero between transactions. |
| **I2** | No path where the swap succeeds and the grant does not. |
| **I3** | The vault is unchanged: only its documented `Grant { grantee }` is used, with funds. |
| **I4** | sSCRT redeems one for one — the direct path grants exactly what was sent. |
| **I5** | The swap path grants exactly (balance after − before), and never less than `min_out`. |
| **I6** | A balance that was already here does not inflate the difference. |
| **I7** | The re-entrancy lock cannot stick. |

## Still open

Two questions this contract's design rests on could **not** be settled where it was
written, because no devnet could be started there and ShadeSwap exists only on mainnet:

1. **Does a `reply` still run after a submessage whose own execution used `reply_always`?**
   This is the load-bearing assumption of the swap path. `mock_dependencies` never executes
   submessages, so no unit test can answer it.
2. **Does `CosmosMsg::Stargate` dispatch from the vault when the vault is itself called as a
   nested contract?** The compute module's signer check is per-message and the signer is the
   vault, so it *should* — but it is unverified, and it blocks **both** paths, not just the
   swap.

[`contracts/mock-router`](../mock-router) exists to settle the first cheaply: it reproduces
the `reply_always` nesting and can, on demand, under-deliver, report success having
delivered nothing, and re-enter this contract mid-swap. Run it on a LocalSecret devnet
against this contract and the real vault before any mainnet money moves.

**Gas is unmeasured.** A real ShadeSwap swap carries a ~1.27M limit for the swap leg alone,
and this chain adds a `Receive`, two balance queries, a `reply`, a `Redeem`, and the vault's
feegrant query, revoke and grant on top. `GAS_BUY_VIA_SWAP` in `src/lib/gasVault.ts` is set
high and marked provisional; the deploy script prints what a verification purchase actually
used. If the total does not fit under the chain's per-transaction ceiling, that is not a
number to tune — it means the one-signature premise does not hold, and splitting the work
across two transactions puts back the exact problem this contract exists to solve.

## Building and deploying

The chain rejects wasm built by a host toolchain — Rust 1.82+ emits the `reference-types`
and `multivalue` proposals that Secret refuses at upload. Use the pinned optimizer:

```bash
cd contracts/swap-and-grant
docker run --rm -v "$PWD":/contract -w /contract \
  ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13
cd ../..
```

PowerShell — the image goes in a variable so no line is long enough to be broken when
pasted:

```powershell
cd contracts\swap-and-grant
$img = "ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13"
docker run --rm -v "${PWD}:/contract" -w /contract $img
cd ..\..
```

Then deploy. **secret-4 only in practice** — ShadeSwap has no pulsar-3 deployment:

```bash
CHAIN=secret-4 CONFIRM=secret-4 \
GAS_VAULT=secret1kkmu4vydkppkhzmx00glm20vn47t09544adv0g \
MNEMONIC="your twelve words …" \
  node --experimental-strip-types contracts/swap-and-grant/scripts/deploy.ts
```

Without `ROUTER` this deploys an executor that accepts sSCRT only, which is a valid
deployment rather than a broken one — and needs no address anyone had to guess.

To enable the stkd-SCRT path, add `ROUTER=secret1…` plus either `PAIR=secret1…` or
`FACTORY=secret1…` to find the pair. The script **reads every code hash off the chain**
rather than trusting a constant, and refuses to continue unless the pair really holds both
sSCRT and stkd-SCRT. It prints the pool's reserves too, so you can see whether it is deep
enough to be worth offering.

Add `VERIFY=100000` to also buy a dust-sized credit with stkd-SCRT and read the resulting
grant back off the chain. Worth doing once: a transaction that returns without error is not
evidence, the grant existing afterwards is. The purchase is atomic, so a chain that cannot
dispatch it returns the tokens — the cost of finding out is the gas, not the amount.

The script prints the `.env.local` lines to paste when it finishes.

## Wiring it into the dashboard

Put the printed values in `.env.local` and a token picker appears in **Buy gas credit**.
Nothing keys off the chain id: with no executor address set, the dialogue behaves exactly as
it did before this contract existed. See the root README under *Gas credits*.
