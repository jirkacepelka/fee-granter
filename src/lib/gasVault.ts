import { MsgExecuteContract, type SecretNetworkClient, type TxResponse } from "secretjs";

import { DENOM, GAS_PRICE_USCRT } from "./chains";
import { toMicroUnits } from "./format";

/**
 * Client for the gas-vault contract (`contracts/gas-vault`).
 *
 * Pay SCRT in with a grantee address and the contract issues that address a
 * fee allowance of the same size, payable from the contract rather than from
 * you. Unlike granting directly, the grant does not depend on your balance
 * afterwards — which is the point for a bridge or sponsor.
 */

/** Gas for the execute plus the grant (and a revoke when topping up). */
export const GAS_BUY = 400_000;

/**
 * Gas for the combined top-up: a SNIP-20 redeem followed by a vault purchase,
 * where the purchase is itself a revoke plus a grant. Measured, not guessed —
 * see `docs/gas-credits-flow.md` for the calibration.
 */
export const GAS_TOPUP = 700_000;

export interface VaultStatus {
  /**
   * What the contract holds, in base units — which is also the sum of every
   * allowance it has issued and not seen spent.
   *
   * The two cannot drift: a purchase raises both by what was paid, and a
   * granted fee, charged to the granter, lowers both by what it cost. So the
   * vault cannot owe more than it holds, and this one figure says everything
   * about whether its grants are backed.
   */
  balance: string;
}

interface StatusReply {
  balance?: string;
}

interface RemainingReply {
  grantee?: string;
  /** Absent or null when the contract could not ask x/feegrant. */
  amount?: string | null;
}

/**
 * Contract queries are encrypted against the code hash, and a migration
 * changes it — a stale one does not degrade, it stops every query dead. So it
 * is always read from the chain, and only cached for this page load.
 */
const codeHashes = new Map<string, Promise<string>>();

export function codeHashFor(
  client: SecretNetworkClient,
  contractAddress: string,
): Promise<string> {
  const cached = codeHashes.get(contractAddress);
  if (cached) return cached;

  const pending = client.query.compute
    .codeHashByContractAddress({ contract_address: contractAddress })
    .then((response) => {
      const hash = response.code_hash;
      if (!hash) throw new Error("The vault address returned no code hash.");
      return hash;
    })
    .catch((error) => {
      // Do not cache a failure; the next attempt should retry.
      codeHashes.delete(contractAddress);
      throw error;
    });

  codeHashes.set(contractAddress, pending);
  return pending;
}

export function forgetCodeHashes(): void {
  codeHashes.clear();
}

/** Buy `amount` (a human decimal string) of allowance for `grantee`. */
export async function buyGasCredit(
  client: SecretNetworkClient,
  contractAddress: string,
  sender: string,
  grantee: string,
  amount: string,
  feeGranter?: string,
): Promise<TxResponse> {
  const code_hash = await codeHashFor(client, contractAddress);

  return client.tx.compute.executeContract(
    {
      sender,
      contract_address: contractAddress,
      code_hash,
      msg: { grant: { grantee: grantee.trim() } },
      // The funds land before the contract runs, so this pays for the
      // allowance and tops the contract up in one transaction.
      sent_funds: [{ denom: DENOM, amount: toMicroUnits(amount) }],
    },
    {
      gasLimit: GAS_BUY,
      gasPriceInFeeDenom: GAS_PRICE_USCRT,
      feeDenom: DENOM,
      feeGranter,
    },
  );
}

/** What the vault holds, and so what it can still honour. */
export async function queryVaultStatus(
  client: SecretNetworkClient,
  contractAddress: string,
): Promise<VaultStatus> {
  const code_hash = await codeHashFor(client, contractAddress);

  const reply = (await client.query.compute.queryContract({
    contract_address: contractAddress,
    code_hash,
    query: { status: {} },
  })) as StatusReply;

  return { balance: reply?.balance ?? "0" };
}

/**
 * What `x/feegrant` says this address still has from the vault, in base units.
 *
 * **`null` is not zero.** The contract reads the figure live through a stargate
 * query the chain allow-lists and reserves the right to change; when it cannot
 * ask, it says so rather than guessing. A caller that renders `null` as "0"
 * would tell someone their credits are gone when they may be intact — and, in
 * the auto-top-up path, would buy credits nobody needed. Treat it as "unknown"
 * and do nothing.
 */
export async function queryRemaining(
  client: SecretNetworkClient,
  contractAddress: string,
  grantee: string,
): Promise<string | null> {
  const code_hash = await codeHashFor(client, contractAddress);

  const reply = (await client.query.compute.queryContract({
    contract_address: contractAddress,
    code_hash,
    query: { remaining: { grantee: grantee.trim() } },
  })) as RemainingReply;

  return reply?.amount ?? null;
}

export interface TopUpParams {
  vaultAddress: string;
  /** The SNIP-20 that wraps SCRT 1:1, i.e. sSCRT. Nothing else can be redeemed. */
  sscrtAddress: string;
  sender: string;
  /** How much credit to buy, in base units. */
  amountUscrt: string;
}

/**
 * Top up your own gas credits without holding any SCRT, and without a sponsor.
 *
 * One transaction, two messages: unwrap sSCRT into native SCRT, then pay that
 * SCRT straight into the vault. The second message spends what the first
 * produced — messages in a Cosmos transaction run in order against one cached
 * store, so the coins are there by the time the vault is called.
 *
 * The fee is paid by the credits being topped up, which is why the app must
 * never let them reach zero: the transaction that refills them has to be
 * affordable before it runs. It is also why the vault's purchase is a revoke
 * followed by a grant — it re-issues the allowance that is paying for this very
 * transaction, reading the live remainder after the fee has already been taken.
 */
export async function topUpGasCredits(
  client: SecretNetworkClient,
  { vaultAddress, sscrtAddress, sender, amountUscrt }: TopUpParams,
): Promise<TxResponse> {
  const [vaultCodeHash, sscrtCodeHash] = await Promise.all([
    codeHashFor(client, vaultAddress),
    codeHashFor(client, sscrtAddress),
  ]);

  const redeem = new MsgExecuteContract({
    sender,
    contract_address: sscrtAddress,
    code_hash: sscrtCodeHash,
    msg: { redeem: { amount: amountUscrt, denom: DENOM } },
    sent_funds: [],
  });

  const buy = new MsgExecuteContract({
    sender,
    contract_address: vaultAddress,
    code_hash: vaultCodeHash,
    msg: { grant: { grantee: sender } },
    sent_funds: [{ denom: DENOM, amount: amountUscrt }],
  });

  return client.tx.broadcast([redeem, buy], {
    gasLimit: GAS_TOPUP,
    gasPriceInFeeDenom: GAS_PRICE_USCRT,
    feeDenom: DENOM,
    feeGranter: vaultAddress,
  });
}
