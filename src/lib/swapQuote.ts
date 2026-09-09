import type { SecretNetworkClient } from "secretjs";

import type { SwapTokenConfig } from "./chains";

/**
 * What a swap would return, asked of the ShadeSwap router before signing
 * anything.
 *
 * This exists to produce `min_out`, which the executor requires and does not
 * default. There is no honest way to guess it: stkd-SCRT is a staking
 * derivative, so its rate against SCRT is above one and rises over time.
 * Assuming parity would set a bound the swap clears trivially, which is the
 * same as having no bound at all.
 */

/** Shape of the router's `SwapSimulation` answer (`shadeswap-shared`). */
interface SimulationAnswer {
  swap_simulation?: {
    total_fee_amount?: string;
    lp_fee_amount?: string;
    shade_dao_fee_amount?: string;
    result?: { return_amount?: string };
    price?: string;
  };
}

export interface Quote {
  /** Base units of sSCRT the router expects to return. */
  expected: bigint;
  /** `expected` less the slippage allowance — what gets signed. */
  minOut: bigint;
  /** Total fee the pool takes, in base units of the input token. */
  fee: bigint;
  /**
   * How far the realised rate sits below the pool's quoted price, as a
   * fraction. Used to refuse a trade the pool is too thin for rather than
   * letting someone accept a terrible fill because the bound technically held.
   */
  priceImpact: number;
}

export const DEFAULT_SLIPPAGE = 0.01;

/**
 * Refuse to quote past this. A bound alone would not protect anyone here: they
 * would simply be signing a bad trade knowingly.
 */
export const MAX_PRICE_IMPACT = 0.05;

export class ShallowPoolError extends Error {
  constructor(readonly impact: number) {
    super(
      `The pool is too thin for this size — it would move the price by ` +
        `${(impact * 100).toFixed(1)}%. Try a smaller amount.`,
    );
    this.name = "ShallowPoolError";
  }
}

export async function quoteSwap(
  client: SecretNetworkClient,
  token: SwapTokenConfig,
  amountIn: string,
  slippage: number = DEFAULT_SLIPPAGE,
): Promise<Quote> {
  const answer = (await client.query.compute.queryContract({
    contract_address: token.router.address,
    code_hash: token.router.codeHash,
    query: {
      swap_simulation: {
        offer: {
          token: {
            custom_token: {
              contract_addr: token.address,
              token_code_hash: token.codeHash,
            },
          },
          amount: amountIn,
        },
        path: token.path,
      },
    },
  })) as SimulationAnswer;

  const simulation = answer?.swap_simulation;
  const expected = BigInt(simulation?.result?.return_amount ?? "0");
  if (expected <= 0n) {
    throw new Error("The router could not quote this swap.");
  }

  const fee = BigInt(simulation?.total_fee_amount ?? "0");

  // `price` is the pool's rate before this trade moves it. Comparing the rate
  // actually realised against it is what "price impact" means; without a price
  // there is nothing to compare to, so it is reported as zero rather than
  // invented.
  const quotedPrice = Number(simulation?.price ?? "0");
  const realised = Number(expected) / Number(BigInt(amountIn));
  const priceImpact =
    quotedPrice > 0 && realised > 0 ? Math.max(0, 1 - realised / quotedPrice) : 0;

  if (priceImpact > MAX_PRICE_IMPACT) {
    throw new ShallowPoolError(priceImpact);
  }

  return {
    expected,
    minOut: applySlippage(expected, slippage),
    fee,
    priceImpact,
  };
}

/**
 * Integer arithmetic throughout. Slippage is turned into basis points first so
 * a float never touches an amount — the same rule the rest of this codebase
 * follows for balances.
 */
export function applySlippage(amount: bigint, slippage: number): bigint {
  const bps = BigInt(Math.round(Math.min(Math.max(slippage, 0), 1) * 10_000));
  const out = (amount * (10_000n - bps)) / 10_000n;
  // A bound of zero is no bound. Anything above dust keeps at least one unit.
  return out > 0n ? out : 1n;
}
