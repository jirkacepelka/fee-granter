import type { ChainConfig } from "./chains";
import { fetchJson } from "./endpoint";

/**
 * SCRT spot price from Osmosis.
 *
 * https://docs.osmosis.zone/integrate/prices/ — the SQS endpoint is keyed by
 * IBC denom and answers `{ "<denom>": { "<quote denom>": "0.23" } }`. Other
 * Osmosis price endpoints have answered with a bare number or `{ price }` over
 * the years, so all three shapes are accepted; anything else is treated as
 * "unavailable" rather than shown as a wrong number.
 */

const PRICE_API =
  process.env.NEXT_PUBLIC_PRICE_API_URL ?? "https://sqsprod.osmosis.zone/tokens/prices";

export type PriceResult =
  | { status: "ok"; usd: number }
  /** Testnet coins have no market — not an error. */
  | { status: "none" }
  | { status: "unavailable"; reason: string };

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = firstNumber(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export async function fetchScrtPrice(chain: ChainConfig): Promise<PriceResult> {
  if (!chain.osmosisDenom) return { status: "none" };

  try {
    const url = `${PRICE_API}?coinMinimalDenoms=${encodeURIComponent(chain.osmosisDenom)}`;
    const body = await fetchJson(url, 8_000);

    const scoped =
      body && typeof body === "object" && chain.osmosisDenom in (body as object)
        ? (body as Record<string, unknown>)[chain.osmosisDenom]
        : body;

    const usd = firstNumber(scoped);
    if (usd === undefined || usd <= 0) {
      return { status: "unavailable", reason: "the price feed returned no usable value" };
    }
    return { status: "ok", usd };
  } catch (caught) {
    return {
      status: "unavailable",
      reason: caught instanceof Error ? caught.message : String(caught),
    };
  }
}
