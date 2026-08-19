import type { SecretNetworkClient, TxResponse } from "secretjs";

import { DENOM, GAS_PRICE_USCRT, GAS_SEND } from "./chains";
import { toMicroUnits } from "./format";

/** Spendable uscrt balance, as a base-unit string. */
export async function queryBalance(
  client: SecretNetworkClient,
  address: string,
): Promise<string> {
  const response = await client.query.bank.balance({ address, denom: DENOM });
  return response.balance?.amount ?? "0";
}

/**
 * Send SCRT to another address. `amount` is a human decimal string.
 *
 * `feeGranter` sets `auth_info.fee.granter` on the transaction. A fee grant is
 * never applied automatically - the spending transaction has to name the
 * granter, or the fee comes out of the sender's own balance.
 */
export async function sendScrt(
  client: SecretNetworkClient,
  from: string,
  to: string,
  amount: string,
  memo?: string,
  feeGranter?: string,
): Promise<TxResponse> {
  return client.tx.bank.send(
    {
      from_address: from,
      to_address: to.trim(),
      amount: [{ denom: DENOM, amount: toMicroUnits(amount) }],
    },
    {
      gasLimit: GAS_SEND,
      gasPriceInFeeDenom: GAS_PRICE_USCRT,
      feeDenom: DENOM,
      memo: memo?.trim() || undefined,
      feeGranter,
    },
  );
}
