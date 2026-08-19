import type { ChainConfig } from "./chains";
import { fetchJson } from "./endpoint";

/**
 * SCRT spot price.
 *
 * The primary source is Osmosis (https://docs.osmosis.zone/integrate/prices/),
 * whose SQS endpoint is keyed by IBC denom. Browser access to it depends on the
 * host sending CORS headers, which is outside our control, so CoinGecko is
 * tried afterwards - it is CORS-open and needs no key for a simple spot price.
 *
 * Response shapes differ between sources and Osmosis has changed its own over
 * time, so each source parses its own body and the first usable number wins.
 * Anything unparseable is reported as unavailable rather than shown as a wrong
 * number.
 */

export type PriceResult =
  | { status: "ok"; usd: number; source: string }
  /** Testnet coins have no market - not an error. */
  | { status: "none" }
  | { status: "unavailable"; reason: string };

interface PriceSource {
  name: string;
  url: (chain: ChainConfig) => string | undefined;
  parse: (body: unknown, chain: ChainConfig) => number | undefined;
}

/** Depth-first search for the first finite positive number in a JSON value. */
function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
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

const OSMOSIS_BASE =
  process.env.NEXT_PUBLIC_PRICE_API_URL ?? "https://sqsprod.osmosis.zone/tokens/prices";

const SOURCES: PriceSource[] = [
  {
    name: "Osmosis",
    url: (chain) =>
      chain.osmosisDenom
        ? `${OSMOSIS_BASE}?coinMinimalDenoms=${encodeURIComponent(chain.osmosisDenom)}`
        : undefined,
    parse: (body, chain) => {
      // { "<denom>": { "<quote denom>": "0.23" } }
      const scoped =
        body && typeof body === "object" && chain.osmosisDenom &&
        chain.osmosisDenom in (body as object)
          ? (body as Record<string, unknown>)[chain.osmosisDenom]
          : body;
      return firstNumber(scoped);
    },
  },
  {
    name: "CoinGecko",
    url: () => "https://api.coingecko.com/api/v3/simple/price?ids=secret&vs_currencies=usd",
    // { "secret": { "usd": 0.23 } }
    parse: (body) => firstNumber((body as { secret?: unknown })?.secret),
  },
];

export async function fetchScrtPrice(chain: ChainConfig): Promise<PriceResult> {
  // Testnet SCRT is not traded anywhere; skip the network entirely.
  if (!chain.osmosisDenom) return { status: "none" };

  const failures: string[] = [];

  for (const source of SOURCES) {
    const url = source.url(chain);
    if (!url) continue;

    try {
      const usd = source.parse(await fetchJson(url, 8_000), chain);
      if (usd !== undefined && usd > 0) {
        return { status: "ok", usd, source: source.name };
      }
      failures.push(`${source.name}: no usable value in the response`);
    } catch (caught) {
      failures.push(
        `${source.name}: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  }

  return { status: "unavailable", reason: failures.join("; ") };
}
