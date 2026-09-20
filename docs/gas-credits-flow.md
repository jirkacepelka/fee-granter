# Keeping a wallet in gas without it holding SCRT

A wallet that holds only a SNIP-20 cannot pay a fee. `Fee.amount` is `Coin[]` — bank
denominations only — and Secret ships no fee-abstraction module, so there is no version of
this where the token pays directly. Something has to put native SCRT behind the transaction.

**Gas credits** are that something, and they are not a new primitive: a credit is an ordinary
`BasicAllowance` fee grant whose granter is the `gas-vault` contract rather than a wallet. Pay
SCRT into the vault naming an address, and that address gets an allowance of the same size,
1:1. Spending one means setting `fee.granter` to the vault — nothing else.

Three properties follow from the contract and are worth stating before the flow, because they
are what the design is shaped around:

- **1:1, no margin.** The vault grants exactly what it is sent. Anyone wanting to sell credits
  at a markup takes the markup outside the contract.
- **Nothing comes back out.** There is no withdrawal. Every uscrt in the vault leaves as
  somebody's gas. Credits are prepaid fees, not savings.
- **Buying gas costs gas.** Calling the vault is a transaction. A wallet at zero cannot
  bootstrap itself, and no amount of design inside the contract changes that.

## Three states

Read `Remaining { grantee }` from the vault and the wallet's native balance — both public, so
no permit and no viewing key. `readCreditStatus` in `src/lib/gasCredits.ts` returns one of:

| State | Condition | What the app does |
| --- | --- | --- |
| `warm` | credits ≥ floor | Sign and send, `fee.granter` = vault. Nothing else involved. |
| `draining` | below floor, but enough left to pay for one refill | Refill first, out of the wallet's own sSCRT. Still nothing else involved. |
| `cold` | cannot pay for even one transaction | Deadlock. Only an outside sponsor breaks it. |
| `unknown` | the vault could not reach `x/feegrant` | Do nothing. See below. |

**`unknown` is not `cold`.** `Remaining` is answered from a stargate query the chain
allow-lists and reserves the right to change, so the contract distinguishes a figure, an absent
grant, and a question it could not ask. An app that renders the third as zero tells people
their credits are gone when they may be intact, and — worse, in an automatic refill path —
spends money to fix a problem that does not exist.

## Refilling, with no sponsor

One transaction, two messages:

```
[ MsgExecuteContract sSCRT  { redeem: { amount, denom: "uscrt" } },
  MsgExecuteContract vault  { grant: { grantee: <self> } }  sent_funds: <that amount> ]
fee.granter = vault
```

The second message spends what the first produced. Messages in a Cosmos transaction run in
order against one cached store, so the coins are there by the time the vault is called.

Two things about this are less obvious than they look:

**The transaction pays its own fee out of the credits it is refilling.** That is why the floor
is above zero and not at it. The refill has to be affordable *before* it runs, so the floor
must exceed what the refill costs. `TOPUP_FEE_USCRT` in `gasCredits.ts` is that cost; the
default floor of 5 SCRT clears it by roughly seventy times, which is runway, not caution.

**The vault revokes and re-grants the allowance that is paying for this transaction.**
`x/feegrant` rejects `MsgGrantAllowance` when a grant already exists and offers no update
message, so a top-up is a revoke followed by a grant for the new total. Both ride in one
transaction, so the grant is never left revoked. The ordering works out because the fee is
deducted in the ante handler, before any message runs — the vault reads a remainder that
already has the fee taken out of it, and re-grants from there.

## The cold start

A wallet with sSCRT and nothing else cannot buy its first credit, because buying costs gas.
Breaking that needs someone else to pay for exactly one transaction. A gas provider does it
like this:

1. The wallet gives the provider a SNIP-24 permit scoped to `balance`.
2. The provider reads the sSCRT balance and checks it covers the price.
3. The provider issues a small `MsgGrantAllowance` from its own wallet — enough for one
   transaction, short expiry.
4. The wallet signs one message, built by the provider: an sSCRT transfer paying the provider.
   `fee.granter` is the provider.
5. Once that is on chain, the provider buys credits from the vault for the wallet.
6. The provider deletes the permit. It has no further use for it.

**The permit is unavoidable here and only here.** The provider is about to spend its own gas on
a transaction that fails if the wallet cannot pay, and a SNIP-20 balance is private. Reading
its own balance afterwards answers the question too late. Once the wallet is warm it never
comes back, so the exposure is one balance read, once.

**This step is not atomic and cannot be made so with one signature.** The wallet pays, and the
credits arrive in the provider's next transaction seconds later. An atomic version needs two
signers in one transaction, which secretjs does not offer — `signTx` takes one wallet. So the
answer is operational: the provider records the paid purchase durably and retries delivery
until it lands, and an undelivered purchase is visible to whoever runs it. The wallet holds an
on-chain receipt in the meantime.

**What the provider can steal, and what it cannot.** It never signs for the wallet, so it
cannot move funds. It sees the balance, the address, and the fact that credits were bought —
the last two being public anyway. It does not see what the wallet does afterwards, because
afterwards it is not involved.

## Costs, measured where noted

| | Gas | At 0.1 uscrt/gas |
| --- | --- | --- |
| Vault purchase (`GAS_BUY`) | 400 000 | 0.04 SCRT |
| Refill, redeem + purchase (`GAS_TOPUP`) | 700 000 | 0.07 SCRT |
| `MsgGrantAllowance` from a wallet | 26 000 | 0.0026 SCRT |

`GAS_TOPUP` is an estimate until the combined transaction has been measured on chain; treat it
as a ceiling to be replaced by a reading, the way every other gas constant here was.

A provider's cold start costs it about 0.0026 SCRT of grant plus 0.04 SCRT to deliver the
credits. An address that takes the grant and never pays costs it the 0.0026 — small, but not
zero, which is why a second grant should not go to an address with an unpaid first one.
