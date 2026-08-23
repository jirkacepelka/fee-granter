/** Chain registry. Secret Network mainnet and the pulsar-3 testnet. */

export type ChainId = "pulsar-3" | "secret-4";

export interface ChainConfig {
  chainId: ChainId;
  /** Shown in the network switcher. */
  label: string;
  /** Longer name used in Keplr's chain suggestion. */
  chainName: string;
  isTestnet: boolean;
  lcdUrls: string[];
  rpcUrls: string[];
  explorerTxTemplate: string;
  /**
   * The IBC denom SCRT trades under on Osmosis, used for price lookups.
   * Testnet SCRT has no market, so it is absent there.
   */
  osmosisDenom?: string;
  /**
   * Address of a deployed gas-vault contract, if there is one. Empty until one
   * is deployed; Settings overrides it per chain at runtime.
   */
  gasVaultAddress: string;
}

/** Both chains use the same coin, precision and address prefix. */
export const DENOM = "uscrt";
export const DISPLAY_DENOM = "SCRT";
export const DECIMALS = 6;
export const BECH32_PREFIX = "secret";

/** Gas price used to turn a gas limit into a fee amount. */
export const GAS_PRICE_USCRT = 0.1;

export const GAS_GRANT = 100_000;
export const GAS_REVOKE = 80_000;
export const GAS_SEND = 80_000;

/**
 * Endpoint settings accept a comma-separated list; the app uses the first entry
 * that answers with JSON for the right chain. Env vars override the defaults.
 */
function endpointList(configured: string | undefined, fallbacks: string[]): string[] {
  const parsed = (configured ?? "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallbacks;
}

export const CHAINS: Record<ChainId, ChainConfig> = {
  "pulsar-3": {
    chainId: "pulsar-3",
    label: "pulsar-3",
    chainName: "Secret Testnet",
    isTestnet: true,
    lcdUrls: endpointList(process.env.NEXT_PUBLIC_SECRET_LCD_URL, [
      "https://pulsar.lcd.secretnodes.com",
      "https://api.pulsar3.scrtlabs.com/api",
      "https://lcd.testnet.secretsaturn.net",
      "https://api.pulsar.scrttestnet.com",
    ]),
    rpcUrls: endpointList(process.env.NEXT_PUBLIC_SECRET_RPC_URL, [
      "https://pulsar.rpc.secretnodes.com",
      "https://rpc.pulsar3.scrtlabs.com/rpc",
      "https://rpc.testnet.secretsaturn.net",
    ]),
    explorerTxTemplate:
      process.env.NEXT_PUBLIC_EXPLORER_TX_URL ?? "https://testnet.ping.pub/secret/tx/{hash}",
    gasVaultAddress: process.env.NEXT_PUBLIC_GAS_VAULT_ADDRESS ?? "",
  },
  "secret-4": {
    chainId: "secret-4",
    label: "secret-4",
    chainName: "Secret Network",
    isTestnet: false,
    lcdUrls: endpointList(process.env.NEXT_PUBLIC_SECRET_MAINNET_LCD_URL, [
      "https://lcd-secret.keplr.app",
      "https://lcd.mainnet.secretsaturn.net",
      "https://lcd.secret.express",
      "https://secret-api.lavenderfive.com",
    ]),
    rpcUrls: endpointList(process.env.NEXT_PUBLIC_SECRET_MAINNET_RPC_URL, [
      "https://rpc-secret.keplr.app",
      "https://rpc.mainnet.secretsaturn.net",
      "https://rpc.secret.express",
    ]),
    explorerTxTemplate:
      process.env.NEXT_PUBLIC_MAINNET_EXPLORER_TX_URL ??
      "https://www.mintscan.io/secret/tx/{hash}",
    // SCRT as it is denominated on Osmosis.
    osmosisDenom:
      "ibc/0954E1C28EB7AF5B72D24F3BC2B47BBB2FDF91BDDFD57B74B99E133AED40972A",
    gasVaultAddress: process.env.NEXT_PUBLIC_GAS_VAULT_ADDRESS_MAINNET ?? "",
  },
};

export const CHAIN_IDS = Object.keys(CHAINS) as ChainId[];
export const DEFAULT_CHAIN_ID: ChainId = "pulsar-3";

export function isChainId(value: unknown): value is ChainId {
  return typeof value === "string" && value in CHAINS;
}

export function explorerTxUrl(chain: ChainConfig, hash: string): string {
  return chain.explorerTxTemplate.replace("{hash}", hash);
}

const scrtCurrency = {
  coinDenom: DISPLAY_DENOM,
  coinMinimalDenom: DENOM,
  coinDecimals: DECIMALS,
  coinGeckoId: "secret",
};

/**
 * Payload for `keplr.experimentalSuggestChain`. Only needed for pulsar-3, which
 * is not in Keplr's built-in registry, but harmless for mainnet.
 */
export function keplrChainInfo(chain: ChainConfig, rpc: string, rest: string) {
  return {
    chainId: chain.chainId,
    chainName: chain.chainName,
    rpc,
    rest,
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
      { ...scrtCurrency, gasPriceStep: { low: 0.0125, average: 0.1, high: 0.25 } },
    ],
    stakeCurrency: scrtCurrency,
    features: ["secretwasm", "ibc-transfer", "ibc-go"],
  };
}
