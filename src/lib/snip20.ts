import { toBase64, toUtf8 } from "@cosmjs/encoding";
import type { SecretNetworkClient, TxResponse } from "secretjs";

import type { SwapTokenConfig, TokenConfig } from "./chains";
import { getKeplr } from "./keplr";

/**
 * The bits of SNIP-20 this app needs: read a balance, and pay a contract by
 * sending tokens to it with a payload.
 *
 * Field names are the reference implementation's
 * (`scrtlabs/snip20-reference-impl`), and they are what goes on the wire — a
 * wrong one is a transaction the chain rejects, not a type error here.
 */

/** Reading a balance needs a viewing key; only the owner's wallet has one. */
export interface ViewingKey {
  token: string;
  key: string;
}

/**
 * Balances are three-valued, and the difference matters.
 *
 * `undefined` means "not asked yet or could not ask" — most often that the
 * wallet holds no viewing key for this token. Showing that as a zero would tell
 * someone they have nothing when they may have plenty. The same distinction the
 * vault draws in `RemainingResponse`.
 */
export type Balance = string | undefined;

interface BalanceAnswer {
  balance?: { amount?: string };
  viewing_key_error?: { msg?: string };
}

export class NoViewingKeyError extends Error {
  constructor(readonly token: string) {
    super("No viewing key for this token.");
    this.name = "NoViewingKeyError";
  }
}

/**
 * Ask Keplr for the viewing key it holds for a token.
 *
 * Keplr throws rather than returning null when it has none, and "none" is a
 * normal state the UI has to offer a fix for, so it is turned into a typed
 * error instead of being allowed to look like a failure.
 */
export async function viewingKeyFor(chainId: string, token: string): Promise<string> {
  const keplr = getKeplr();
  if (!keplr?.getSecret20ViewingKey) throw new NoViewingKeyError(token);

  try {
    const key = await keplr.getSecret20ViewingKey(chainId, token);
    if (!key) throw new NoViewingKeyError(token);
    return key;
  } catch {
    throw new NoViewingKeyError(token);
  }
}

/**
 * Ask Keplr to add the token, which is also how it creates a viewing key for
 * it. This is the fix offered when there is no key: it opens Keplr rather than
 * asking anyone to paste a secret into this page.
 */
export async function suggestToken(chainId: string, token: string): Promise<void> {
  const keplr = getKeplr();
  if (!keplr?.suggestToken) {
    throw new Error("This wallet cannot add tokens. Add it in the wallet, then reload.");
  }
  await keplr.suggestToken(chainId, token);
}

export async function queryBalance(
  client: SecretNetworkClient,
  token: TokenConfig,
  address: string,
  key: string,
): Promise<string> {
  const answer = (await client.query.compute.queryContract({
    contract_address: token.address,
    code_hash: token.codeHash,
    query: { balance: { address, key } },
  })) as BalanceAnswer;

  // A rejected key is a distinct answer, not an error, so it has to be checked
  // for explicitly. Reading it as zero is the bug this guards against.
  if (answer?.viewing_key_error) {
    throw new NoViewingKeyError(token.address);
  }

  const amount = answer?.balance?.amount;
  if (amount === undefined) {
    throw new Error(`${token.symbol} returned no balance.`);
  }
  return amount;
}

/** What the executor expects inside the `Send` that pays it. */
export interface BuyCreditPayload {
  buy_credit: {
    grantee: string;
    /** Required when swapping, rejected when paying with sSCRT. */
    min_out?: string;
  };
}

/**
 * Pay the executor by sending it tokens.
 *
 * `recipient_code_hash` is passed on purpose and is not optional in practice: a
 * SNIP-20 only invokes the recipient's `Receive` when the send names a code
 * hash or the recipient registered one, and the executor deliberately registers
 * nothing — that is what stops the router's own delivery of swap output from
 * re-entering it. Omit this and the tokens arrive with no callback and no
 * purchase happens.
 */
export function sendToContract(
  client: SecretNetworkClient,
  token: TokenConfig,
  sender: string,
  recipient: string,
  recipientCodeHash: string,
  amount: string,
  payload: BuyCreditPayload,
  gasLimit: number,
  gasPriceInFeeDenom: number,
  feeDenom: string,
  feeGranter?: string,
): Promise<TxResponse> {
  return client.tx.compute.executeContract(
    {
      sender,
      contract_address: token.address,
      code_hash: token.codeHash,
      msg: {
        send: {
          recipient,
          recipient_code_hash: recipientCodeHash,
          amount,
          msg: toBase64Json(payload),
        },
      },
    },
    { gasLimit, gasPriceInFeeDenom, feeDenom, feeGranter },
  );
}

/**
 * SNIP-20 carries its callback payload as base64-encoded JSON.
 *
 * Through `@cosmjs/encoding` rather than `Buffer`, which this runs too far
 * inside the browser to count on, or `btoa`, which mangles anything outside
 * Latin-1 — a memo or an address is not worth risking that on.
 */
export function toBase64Json(value: unknown): string {
  return toBase64(toUtf8(JSON.stringify(value)));
}

/** Every token the picker may offer on a chain, sSCRT first. */
export function payableTokens(
  sscrt: TokenConfig | undefined,
  swapTokens: SwapTokenConfig[],
): TokenConfig[] {
  return sscrt ? [sscrt, ...swapTokens] : [...swapTokens];
}

export function isSwapToken(token: TokenConfig): token is SwapTokenConfig {
  return "router" in token;
}
