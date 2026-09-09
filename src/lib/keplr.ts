import { SecretNetworkClient } from "secretjs";

import { keplrChainInfo, type ChainConfig } from "./chains";
import { resolveLcdUrl, rpcUrlFor } from "./endpoint";

/**
 * Minimal shape of the pieces of the Keplr API this app uses. Typing it here
 * avoids pulling in @keplr-wallet/types just for four method signatures.
 */
interface KeplrWindow {
  enable(chainId: string): Promise<void>;
  experimentalSuggestChain(chainInfo: unknown): Promise<void>;
  getOfflineSigner(chainId: string): OfflineSigner;
  getOfflineSignerOnlyAmino(chainId: string): OfflineSigner;
  getEnigmaUtils?(chainId: string): unknown;
  /** Throws rather than returning null when the wallet holds no key. */
  getSecret20ViewingKey?(chainId: string, contractAddress: string): Promise<string>;
  /** Adds the token to the wallet, which is also how a viewing key is made. */
  suggestToken?(chainId: string, contractAddress: string): Promise<void>;
}

interface OfflineSigner {
  getAccounts(): Promise<Array<{ address: string }>>;
}

declare global {
  interface Window {
    keplr?: KeplrWindow;
  }
}

export class KeplrNotInstalledError extends Error {
  constructor() {
    super("Keplr is not installed.");
    this.name = "KeplrNotInstalledError";
  }
}

export function getKeplr(): KeplrWindow | undefined {
  if (typeof window === "undefined") return undefined;
  return window.keplr;
}

/** Fires whenever the user switches accounts inside Keplr. */
export const KEPLR_ACCOUNT_CHANGE_EVENT = "keplr_keystorechange";

export interface Connection {
  address: string;
  client: SecretNetworkClient;
  lcdUrl: string;
}

/**
 * Connect to Keplr on the given chain.
 *
 * pulsar-3 is a testnet and is not in Keplr's built-in chain registry, so the
 * chain is suggested when `enable` fails. `getOfflineSigner` (rather than the
 * amino-only variant) is deliberate: it yields a direct-capable signer, which
 * makes secretjs sign with SIGN_MODE_DIRECT and encode allowance timestamps
 * through protobuf rather than its amino JSON path.
 */
export async function connectKeplr(
  chain: ChainConfig,
  lcdOverride?: string,
  rpcOverride?: string,
): Promise<Connection> {
  const keplr = getKeplr();
  if (!keplr) throw new KeplrNotInstalledError();

  // Probe first: a dead LCD would otherwise surface as an opaque JSON parse
  // error from inside Keplr's own chain check.
  const lcdUrl = await resolveLcdUrl(chain, lcdOverride);

  try {
    await keplr.enable(chain.chainId);
  } catch {
    try {
      await keplr.experimentalSuggestChain(
        keplrChainInfo(chain, rpcUrlFor(chain, rpcOverride), lcdUrl),
      );
    } catch (caught) {
      throw new Error(
        `Keplr could not add ${chain.chainId}. Its RPC endpoint is likely down — set a ` +
          `different one in Settings. (${
            caught instanceof Error ? caught.message : String(caught)
          })`,
      );
    }
    await keplr.enable(chain.chainId);
  }

  const signer = keplr.getOfflineSigner(chain.chainId);
  const [account] = await signer.getAccounts();
  if (!account) throw new Error(`Keplr returned no accounts for ${chain.chainId}.`);

  const client = new SecretNetworkClient({
    url: lcdUrl,
    chainId: chain.chainId,
    wallet: signer as never,
    walletAddress: account.address,
    encryptionUtils: keplr.getEnigmaUtils?.(chain.chainId) as never,
  });

  return { address: account.address, client, lcdUrl };
}
