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
   * Address of a deployed gas-vault contract, if there is one. Empty when none
   * is deployed. Hardcoded per chain, not user-configurable.
   */
  gasVaultAddress: string;
  /**
   * Address of a deployed swap-and-grant executor (`contracts/swap-and-grant`),
   * which lets credit be bought with a SNIP-20 instead of native SCRT. Empty
   * when none is deployed, and then the app behaves exactly as it did before it
   * existed — nothing checks the chain id to decide that.
   */
  swapAndGrantAddress: string;
  /**
   * Wrapped SCRT. Redeemed one for one by the executor, so it needs no router,
   * no pool and no slippage — which is why it is configured separately from
   * `swapTokens` rather than as a degenerate route.
   */
  sscrt?: TokenConfig;
  /**
   * Tokens reachable by swapping to sSCRT first. Absent or empty means the
   * picker only offers what needs no pool.
   */
  swapTokens: SwapTokenConfig[];
}

/** A SNIP-20 the dashboard can show a balance for and spend. */
export interface TokenConfig {
  /** Shown in the picker. */
  symbol: string;
  address: string;
  codeHash: string;
  decimals: number;
}

export interface SwapTokenConfig extends TokenConfig {
  router: { address: string; codeHash: string };
  /**
   * The route to sSCRT in the router's own shape — `addr`, not `address`,
   * because this is serialised straight into its `SwapTokensForExact`.
   */
  path: { addr: string; code_hash: string }[];
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

/**
 * An env var set to nothing counts as unset, so a blank line in `.env` keeps the
 * built-in default rather than silently clearing it. Applies to any string
 * setting, not just addresses — an empty `explorerTxTemplate` would otherwise
 * turn every explorer link into `href=""`, which just reopens the current page.
 */
function configuredValue(configured: string | undefined, fallback: string): string {
  return (configured ?? "").trim() || fallback;
}

/**
 * The gas vault this repo deployed on pulsar-3 (`contracts/gas-vault`), confirmed
 * issuing fee grants. That contract's README has the code id and tx hashes.
 *
 * Migratable, so the query allow-list it depends on can be adapted to.
 */
const PULSAR_GAS_VAULT = "secret16wmu0cy4ukh2g50qt7n0q62esmcz62sgrz0h8f";
/** The gas vault deployed on secret-4. */
const MAINNET_GAS_VAULT = "secret1kkmu4vydkppkhzmx00glm20vn47t09544adv0g";

/**
 * sSCRT on secret-4. Address and code hash agree across the Secret Foundation
 * token registry and `scrtlabs/wrap.scrt.network`, and the code hash is what a
 * contract call is encrypted against — a wrong one does not degrade, it stops
 * every call dead.
 */
const MAINNET_SSCRT: TokenConfig = {
  symbol: "sSCRT",
  address: "secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek",
  codeHash: "af74387e276be8874f07bec3a87023ee49b0e7ebe08178c49d0a49c3c98ed60e",
  decimals: DECIMALS,
};

/**
 * stkd-SCRT on secret-4. Same two sources, and confirmed a third time by
 * decoding the contract address out of a real swap transaction.
 *
 * Worth knowing before wiring anything to it: this is a staking derivative, so
 * it is **not** one for one with SCRT and the rate rises over time. Any figure
 * shown for it has to come from a swap simulation, never from assuming parity.
 */
const MAINNET_STKD_SCRT: TokenConfig = {
  symbol: "stkd-SCRT",
  address: "secret1k6u0cy4feepm6pehnz804zmwakuwdapm69tuc4",
  codeHash: "f6be719b3c6feb498d3554ca0398eb6b7e7db262acb33f84a8f12106da6bbb09",
  decimals: DECIMALS,
};

/**
 * The ShadeSwap router and the sSCRT/stkd-SCRT pair.
 *
 * Deliberately **not** hardcoded. The router's code hash and the pair's address
 * could not be confirmed from a second source, and a guessed code hash is a
 * contract call that fails rather than one that misbehaves visibly. They are
 * read off the chain by `contracts/swap-and-grant/scripts/deploy.ts` and set
 * here through the environment afterwards.
 *
 * Until they are set, the swap route is simply not offered and the sSCRT path —
 * which needs neither — works on its own.
 */
function swapTokens(): SwapTokenConfig[] {
  const router = configuredValue(process.env.NEXT_PUBLIC_SHADE_ROUTER_ADDRESS, "");
  const routerHash = configuredValue(process.env.NEXT_PUBLIC_SHADE_ROUTER_CODE_HASH, "");
  const pair = configuredValue(process.env.NEXT_PUBLIC_SSCRT_STKD_PAIR_ADDRESS, "");
  const pairHash = configuredValue(process.env.NEXT_PUBLIC_SSCRT_STKD_PAIR_CODE_HASH, "");

  // All four or none. A half-filled route would surface as an inscrutable
  // failure at signing time instead of an option that is simply absent.
  if (!router || !routerHash || !pair || !pairHash) return [];

  return [
    {
      ...MAINNET_STKD_SCRT,
      router: { address: router, codeHash: routerHash },
      path: [{ addr: pair, code_hash: pairHash }],
    },
  ];
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
    explorerTxTemplate: configuredValue(
      process.env.NEXT_PUBLIC_EXPLORER_TX_URL,
      "https://testnet.ping.pub/secret/tx/{hash}",
    ),
    gasVaultAddress: configuredValue(process.env.NEXT_PUBLIC_GAS_VAULT_ADDRESS, PULSAR_GAS_VAULT),
    // ShadeSwap is on secret-4 only, so there is nothing here to swap through
    // and no executor deployed. Buying credit on pulsar-3 works exactly as it
    // always has, with native SCRT.
    swapAndGrantAddress: configuredValue(process.env.NEXT_PUBLIC_SWAP_AND_GRANT_ADDRESS, ""),
    swapTokens: [],
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
    explorerTxTemplate: configuredValue(
      process.env.NEXT_PUBLIC_MAINNET_EXPLORER_TX_URL,
      "https://www.mintscan.io/secret/tx/{hash}",
    ),
    // SCRT as it is denominated on Osmosis.
    osmosisDenom:
      "ibc/0954E1C28EB7AF5B72D24F3BC2B47BBB2FDF91BDDFD57B74B99E133AED40972A",
    gasVaultAddress: configuredValue(
      process.env.NEXT_PUBLIC_GAS_VAULT_ADDRESS_MAINNET,
      MAINNET_GAS_VAULT,
    ),
    swapAndGrantAddress: configuredValue(
      process.env.NEXT_PUBLIC_SWAP_AND_GRANT_ADDRESS_MAINNET,
      "",
    ),
    sscrt: MAINNET_SSCRT,
    swapTokens: swapTokens(),
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
