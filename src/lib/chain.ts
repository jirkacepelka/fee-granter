/** Secret Network pulsar-3 testnet configuration. */

export const CHAIN_ID = "pulsar-3";
export const CHAIN_NAME = "Secret Testnet";

/**
 * Public pulsar-3 nodes are frequently down or behind a gateway that answers
 * with an HTML error page. Both settings therefore take a comma-separated list
 * and the app uses the first entry that actually answers with JSON for
 * pulsar-3. Set a single URL to pin one node.
 */
function endpointList(configured: string | undefined, fallbacks: string[]): string[] {
  const parsed = (configured ?? "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallbacks;
}

export const LCD_URLS = endpointList(process.env.NEXT_PUBLIC_SECRET_LCD_URL, [
  "https://pulsar.lcd.secretnodes.com",
  "https://api.pulsar3.scrtlabs.com/api",
  "https://lcd.testnet.secretsaturn.net",
  "https://api.pulsar.scrttestnet.com",
]);

export const RPC_URLS = endpointList(process.env.NEXT_PUBLIC_SECRET_RPC_URL, [
  "https://pulsar.rpc.secretnodes.com",
  "https://rpc.pulsar3.scrtlabs.com/rpc",
  "https://rpc.testnet.secretsaturn.net",
]);

/** First configured endpoint, used before probing resolves a live one. */
export const LCD_URL = LCD_URLS[0];
export const RPC_URL = RPC_URLS[0];

const EXPLORER_TX_TEMPLATE =
  process.env.NEXT_PUBLIC_EXPLORER_TX_URL ?? "https://testnet.ping.pub/secret/tx/{hash}";

export const DENOM = "uscrt";
export const DISPLAY_DENOM = "SCRT";
export const DECIMALS = 6;

/** Bech32 prefix for account addresses on Secret Network. */
export const BECH32_PREFIX = "secret";

/** Gas price used to turn a gas limit into a fee amount. */
export const GAS_PRICE_USCRT = 0.1;

/** Gas limits, tuned generously - feegrant messages are small. */
export const GAS_GRANT = 100_000;
export const GAS_REVOKE = 80_000;

export function explorerTxUrl(hash: string): string {
  return EXPLORER_TX_TEMPLATE.replace("{hash}", hash);
}

const scrtCurrency = {
  coinDenom: DISPLAY_DENOM,
  coinMinimalDenom: DENOM,
  coinDecimals: DECIMALS,
  coinGeckoId: "secret",
};

/**
 * Payload for `keplr.experimentalSuggestChain`. pulsar-3 is a testnet, so it is
 * not part of Keplr's built-in registry and has to be suggested before use.
 */
export const KEPLR_CHAIN_INFO = {
  chainId: CHAIN_ID,
  chainName: CHAIN_NAME,
  rpc: RPC_URL,
  rest: LCD_URL,
  bip44: { coinType: 529 },
  bech32Config: {
    bech32PrefixAccAddr: BECH32_PREFIX,
    bech32PrefixAccPub: `${BECH32_PREFIX}pub`,
    bech32PrefixValAddr: `${BECH32_PREFIX}valoper`,
    bech32PrefixValPub: `${BECH32_PREFIX}valoperpub`,
    bech32PrefixConsAddr: `${BECH32_PREFIX}valcons`,
    bech32PrefixConsPub: `${BECH32_PREFIX}valconspub`,
  },
  currencies: [scrtCurrency],
  feeCurrencies: [
    {
      ...scrtCurrency,
      gasPriceStep: { low: 0.0125, average: 0.1, high: 0.25 },
    },
  ],
  stakeCurrency: scrtCurrency,
  features: ["secretwasm", "ibc-transfer", "ibc-go"],
} as const;
