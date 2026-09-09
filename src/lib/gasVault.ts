import type { SecretNetworkClient, TxResponse } from "secretjs";

import { DENOM, GAS_PRICE_USCRT, type TokenConfig } from "./chains";
import { toMicroUnits } from "./format";
import { isSwapToken, sendToContract, type BuyCreditPayload } from "./snip20";

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
 * Paying with sSCRT through `contracts/swap-and-grant`: the token's Send, the
 * executor's Receive, a Redeem, and then the vault's own work.
 *
 * **Provisional.** These two are the only numbers in this file that have not
 * been measured against a chain — the executor could not be exercised on a
 * devnet where they were written, and ShadeSwap exists only on mainnet.
 * `contracts/swap-and-grant/scripts/deploy.ts` prints the gas actually used by
 * its verification purchase; put those figures here and delete this note.
 *
 * They are set high on purpose. Unused gas is not charged on Secret, so an
 * over-estimate costs nothing, while an under-estimate burns the whole fee on
 * a transaction that runs out half way through.
 */
export const GAS_BUY_WITH_SSCRT = 900_000;

/**
 * Paying with a token that has to be swapped first. The swap leg alone carries
 * a ~1.27M limit in real ShadeSwap transactions, and this chain adds the
 * executor's reply, a Redeem, and the vault's feegrant query, revoke and grant
 * on top.
 *
 * If this turns out not to fit under the chain's per-transaction gas ceiling,
 * that is not a number to tune — it means the one-signature premise does not
 * hold, and splitting the work across two transactions puts back exactly the
 * problem the executor exists to solve.
 */
export const GAS_BUY_VIA_SWAP = 2_400_000;

/** What a purchase with `token` should be given, by which path it takes. */
export function gasForToken(token: TokenConfig): number {
  return isSwapToken(token) ? GAS_BUY_VIA_SWAP : GAS_BUY_WITH_SSCRT;
}

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

/**
 * Buy credit with a SNIP-20 instead of native SCRT, through
 * `contracts/swap-and-grant`.
 *
 * The transaction is sent to the *token*, not to the executor: SNIP-20 moves
 * value by having the token call the recipient back. So this is a `Send` whose
 * payload tells the executor what to do with what arrives.
 *
 * `minOut` is required for a token that has to be swapped and refused for
 * sSCRT, and the contract enforces both — passing the wrong one is a rejected
 * transaction, not a silently different trade.
 */
export async function buyGasCreditWithToken(
  client: SecretNetworkClient,
  executorAddress: string,
  token: TokenConfig,
  sender: string,
  grantee: string,
  amount: string,
  minOut: bigint | undefined,
  feeGranter?: string,
): Promise<TxResponse> {
  const executorCodeHash = await codeHashFor(client, executorAddress);
  const swapping = isSwapToken(token);

  if (swapping && minOut === undefined) {
    throw new Error("A minimum return is required when swapping.");
  }

  const payload: BuyCreditPayload = {
    buy_credit: {
      grantee: grantee.trim(),
      ...(swapping ? { min_out: minOut!.toString() } : {}),
    },
  };

  return sendToContract(
    client,
    token,
    sender,
    executorAddress,
    executorCodeHash,
    toMicroUnits(amount, token.decimals),
    payload,
    gasForToken(token),
    GAS_PRICE_USCRT,
    DENOM,
    feeGranter,
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
