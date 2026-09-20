import type { SecretNetworkClient, TxResponse } from "secretjs";

import { DENOM, GAS_PRICE_USCRT } from "./chains";
import { GAS_TOPUP, queryRemaining, topUpGasCredits } from "./gasVault";

/**
 * Keeping a wallet in gas without it ever holding SCRT.
 *
 * Gas credits are an ordinary `BasicAllowance` whose granter is the gas-vault
 * contract, so a wallet with credits transacts by setting `fee.granter` to the
 * vault and nothing else. This module answers the only question the app has to
 * ask before every transaction: are there enough, and if not, can the wallet
 * fix that by itself?
 *
 * It can, as long as the credits have not run out: unwrapping sSCRT and paying
 * it into the vault is a transaction like any other, and the remaining credits
 * pay for it. That is the whole reason for a floor above zero — the refill has
 * to be affordable before it runs. Below that, nothing on-chain is possible
 * without an outside sponsor, and this module says so rather than trying.
 */

export type CreditState =
  /** Enough credits; transact directly. */
  | "warm"
  /** Low, but still enough to pay for its own refill. */
  | "draining"
  /** Nothing to pay gas with. Only an outside sponsor can break the deadlock. */
  | "cold"
  /** The vault could not reach x/feegrant. Not the same as empty — do nothing. */
  | "unknown";

export interface CreditThresholds {
  /** Refill when the remainder drops below this, in base units. */
  floorUscrt: string;
  /** Refill up to this, in base units. */
  targetUscrt: string;
}

/**
 * 5 SCRT floor, 10 SCRT target. The floor is far above what a refill costs
 * (~0.07 SCRT) on purpose: credits paid into the vault can only ever leave as
 * somebody's gas, so the target is also the most a wallet ever has locked up
 * there, and the floor is how much runway it keeps. Both are the caller's to
 * override.
 */
export const DEFAULT_THRESHOLDS: CreditThresholds = {
  floorUscrt: "5000000",
  targetUscrt: "10000000",
};

/** What one refill transaction costs, in base units. */
export const TOPUP_FEE_USCRT = BigInt(Math.ceil(GAS_TOPUP * GAS_PRICE_USCRT));

export interface CreditStatus {
  state: CreditState;
  /** Live remainder from the vault, or `null` when it could not be read. */
  remainingUscrt: string | null;
  /** How much to buy to reach the target. `"0"` when nothing is needed. */
  shortfallUscrt: string;
  /** Native SCRT held, in base units. A wallet with SCRT is never cold. */
  nativeUscrt: string;
}

/**
 * Read the wallet's gas position.
 *
 * Both figures are public — a fee allowance and a bank balance are on-chain in
 * the clear — so this needs no permit and no viewing key.
 */
export async function readCreditStatus(
  client: SecretNetworkClient,
  vaultAddress: string,
  address: string,
  thresholds: CreditThresholds = DEFAULT_THRESHOLDS,
): Promise<CreditStatus> {
  const [remainingUscrt, nativeUscrt] = await Promise.all([
    queryRemaining(client, vaultAddress, address),
    readNativeBalance(client, address),
  ]);

  const native = BigInt(nativeUscrt);
  const floor = BigInt(thresholds.floorUscrt);
  const target = BigInt(thresholds.targetUscrt);

  if (remainingUscrt === null) {
    return { state: "unknown", remainingUscrt, shortfallUscrt: "0", nativeUscrt };
  }

  const remaining = BigInt(remainingUscrt);
  const shortfall = remaining >= target ? 0n : target - remaining;

  // Either pot can pay for the refill: the credits being topped up, or SCRT the
  // wallet already holds. Only when neither can is an outside sponsor needed.
  const canPayForRefill = remaining >= TOPUP_FEE_USCRT || native >= TOPUP_FEE_USCRT;

  const state: CreditState =
    remaining >= floor ? "warm" : canPayForRefill ? "draining" : "cold";

  return { state, remainingUscrt, shortfallUscrt: shortfall.toString(), nativeUscrt };
}

async function readNativeBalance(
  client: SecretNetworkClient,
  address: string,
): Promise<string> {
  const response = await client.query.bank.balance({ address, denom: DENOM });
  return response.balance?.amount ?? "0";
}

export type EnsureOutcome =
  /** Already above the floor; nothing was sent. */
  | { action: "none"; status: CreditStatus }
  /** Credits were topped up. */
  | { action: "topped_up"; status: CreditStatus; boughtUscrt: string; tx: TxResponse }
  /**
   * Out of reach without a sponsor — the caller should fall back to a gas
   * provider, or tell the user why nothing can be sent.
   */
  | { action: "needs_sponsor"; status: CreditStatus; reason: "no_gas" | "no_sscrt" | "unknown" };

export interface EnsureParams {
  vaultAddress: string;
  sscrtAddress: string;
  address: string;
  /** The wallet's sSCRT balance in base units — the caller already knows it. */
  sscrtBalanceUscrt: string;
  thresholds?: CreditThresholds;
}

/**
 * Bring the wallet back above the floor if it can pay to do so.
 *
 * Buys less than the target when that is all the sSCRT there is, rather than
 * refusing: a partial refill still buys runway. It refuses only when the wallet
 * cannot cover even one more transaction's worth, because buying credits that
 * do not outlast the transaction buying them leaves the wallet no better off.
 */
export async function ensureGasCredits(
  client: SecretNetworkClient,
  params: EnsureParams,
): Promise<EnsureOutcome> {
  const thresholds = params.thresholds ?? DEFAULT_THRESHOLDS;
  const status = await readCreditStatus(
    client,
    params.vaultAddress,
    params.address,
    thresholds,
  );

  if (status.state === "unknown") {
    return { action: "needs_sponsor", status, reason: "unknown" };
  }
  if (status.state === "warm") return { action: "none", status };
  if (status.state === "cold") {
    return { action: "needs_sponsor", status, reason: "no_gas" };
  }

  // Buy what is wanted, or everything there is, whichever is less.
  const wanted = BigInt(status.shortfallUscrt);
  const available = BigInt(params.sscrtBalanceUscrt);
  const buying = wanted < available ? wanted : available;

  if (buying <= TOPUP_FEE_USCRT) {
    return { action: "needs_sponsor", status, reason: "no_sscrt" };
  }

  const tx = await topUpGasCredits(client, {
    vaultAddress: params.vaultAddress,
    sscrtAddress: params.sscrtAddress,
    sender: params.address,
    amountUscrt: buying.toString(),
  });

  return { action: "topped_up", status, boughtUscrt: buying.toString(), tx };
}
