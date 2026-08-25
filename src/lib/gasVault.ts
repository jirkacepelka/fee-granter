import type { SecretNetworkClient, TxResponse } from "secretjs";

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
