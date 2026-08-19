import { SecretNetworkClient } from "secretjs";

import { CHAIN_ID, KEPLR_CHAIN_INFO } from "./chain";
import { resolveLcdUrl } from "./endpoint";

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
  disable?(chainId: string): Promise<void>;
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
}

/**
 * Connect to Keplr on pulsar-3.
 *
 * pulsar-3 is a testnet and is not in Keplr's built-in chain registry, so the
 * chain is suggested first. `getOfflineSigner` (rather than the amino-only
 * variant) is deliberate: it yields a direct-capable signer, which makes
 * secretjs sign with SIGN_MODE_DIRECT and encode allowance timestamps through
 * protobuf rather than its amino JSON path.
 */
export async function connectKeplr(): Promise<Connection> {
  const keplr = getKeplr();
  if (!keplr) throw new KeplrNotInstalledError();

  // Probe first: a dead LCD would otherwise surface as an opaque JSON parse
  // error from inside Keplr's own chain check.
  const lcdUrl = await resolveLcdUrl();

  try {
    await keplr.enable(CHAIN_ID);
  } catch {
    try {
      await keplr.experimentalSuggestChain({ ...KEPLR_CHAIN_INFO, rest: lcdUrl });
    } catch (caught) {
      throw new Error(
        `Keplr could not add ${CHAIN_ID}. Its RPC endpoint is likely down — set ` +
          `NEXT_PUBLIC_SECRET_RPC_URL to a working node. (${
            caught instanceof Error ? caught.message : String(caught)
          })`,
      );
    }
    await keplr.enable(CHAIN_ID);
  }

  const signer = keplr.getOfflineSigner(CHAIN_ID);
  const [account] = await signer.getAccounts();
  if (!account) throw new Error("Keplr returned no accounts for pulsar-3.");

  const client = new SecretNetworkClient({
    url: lcdUrl,
    chainId: CHAIN_ID,
    wallet: signer as never,
    walletAddress: account.address,
    encryptionUtils: keplr.getEnigmaUtils?.(CHAIN_ID) as never,
  });

  return { address: account.address, client };
}
