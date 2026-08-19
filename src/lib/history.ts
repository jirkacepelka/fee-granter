import { DENOM } from "./chains";
import { fetchJson } from "./endpoint";

/**
 * Recent activity for one address, limited to what this app is about: SCRT
 * moving in or out, and fee grants being spent.
 *
 * Cosmos exposes this only as an indexed event search, and the parameter name
 * changed across SDK versions (`events=` up to 0.47, `query=` from 0.50), so
 * both are tried. Nodes can also be configured not to index at all, in which
 * case the search legitimately returns nothing — callers should present an
 * empty history as "nothing found", never as fact.
 */

export type HistoryKind = "sent" | "received" | "feegrant";

export interface HistoryEntry {
  kind: HistoryKind;
  hash: string;
  height: number;
  timestamp?: Date;
  /** Base units moved. Absent for fee grant usage, where the fee is the cost. */
  amount?: string;
  /** The other party: recipient for sends, sender for receives, grantee for grants. */
  counterparty?: string;
  /** Fee paid on the transaction, in base units. */
  fee?: string;
}

interface RawTxResponse {
  txhash?: string;
  height?: string;
  timestamp?: string;
  code?: number;
  tx?: {
    auth_info?: {
      fee?: { amount?: Array<{ denom?: string; amount?: string }>; granter?: string };
    };
    body?: { messages?: Array<Record<string, unknown>> };
  };
  logs?: Array<{ events?: Array<{ type?: string; attributes?: Array<{ key?: string; value?: string }> }> }>;
}

const PAGE_LIMIT = 25;

function coinAmount(coins: unknown): string | undefined {
  if (!Array.isArray(coins)) return undefined;
  const match = (coins as Array<{ denom?: string; amount?: string }>).find(
    (coin) => coin?.denom === DENOM,
  );
  return match?.amount;
}

/** Pull "1234uscrt" style values out of a transfer event's amount attribute. */
function parseEventAmount(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(new RegExp(`(\\d+)${DENOM}`));
  return match?.[1];
}

function attr(
  event: { attributes?: Array<{ key?: string; value?: string }> } | undefined,
  key: string,
): string | undefined {
  return event?.attributes?.find((a) => a.key === key)?.value;
}

/**
 * Run one tx search. Tries the modern `query=` parameter first and falls back
 * to the older `events=` form when the node rejects it.
 */
async function searchTxs(lcdUrl: string, expression: string): Promise<RawTxResponse[]> {
  const base = `${lcdUrl}/cosmos/tx/v1beta1/txs`;
  const variants = [
    `${base}?query=${encodeURIComponent(expression)}&limit=${PAGE_LIMIT}&order_by=ORDER_BY_DESC`,
    `${base}?events=${encodeURIComponent(expression)}&pagination.limit=${PAGE_LIMIT}&order_by=ORDER_BY_DESC`,
  ];

  let lastError: unknown;
  for (const url of variants) {
    try {
      const body = (await fetchJson(url, 12_000)) as { tx_responses?: RawTxResponse[] };
      return body.tx_responses ?? [];
    } catch (caught) {
      lastError = caught;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function feeOf(tx: RawTxResponse): string | undefined {
  return coinAmount(tx.tx?.auth_info?.fee?.amount);
}

function transferEvents(tx: RawTxResponse) {
  return (tx.logs ?? [])
    .flatMap((log) => log.events ?? [])
    .filter((event) => event.type === "transfer");
}

function toEntry(tx: RawTxResponse, kind: HistoryKind, address: string): HistoryEntry | undefined {
  if (!tx.txhash) return undefined;
  // Failed transactions still cost a fee, but they moved nothing - skip them
  // for transfers while keeping them for fee grant usage, where the fee is
  // exactly the point.
  if (kind !== "feegrant" && tx.code && tx.code !== 0) return undefined;

  const base: HistoryEntry = {
    kind,
    hash: tx.txhash,
    height: Number(tx.height ?? 0),
    timestamp: tx.timestamp ? new Date(tx.timestamp) : undefined,
    fee: feeOf(tx),
  };

  if (kind === "feegrant") {
    const grantee = (tx.tx?.body?.messages?.[0] as { grantee?: string } | undefined)?.grantee;
    return { ...base, counterparty: grantee };
  }

  const events = transferEvents(tx);
  const match = events.find((event) =>
    kind === "sent" ? attr(event, "sender") === address : attr(event, "recipient") === address,
  );

  return {
    ...base,
    amount: parseEventAmount(attr(match, "amount")),
    counterparty: kind === "sent" ? attr(match, "recipient") : attr(match, "sender"),
  };
}

export interface HistoryResult {
  entries: HistoryEntry[];
  /** Set when every search failed, so the UI can say why it is empty. */
  error?: string;
}

/** Fetch sends, receives and fee-grant usage, newest first. */
export async function fetchHistory(
  lcdUrl: string,
  address: string,
): Promise<HistoryResult> {
  const searches: Array<{ kind: HistoryKind; expression: string }> = [
    { kind: "sent", expression: `transfer.sender='${address}'` },
    { kind: "received", expression: `transfer.recipient='${address}'` },
    // x/feegrant emits this when a granted allowance actually pays a fee.
    { kind: "feegrant", expression: `use_feegrant.granter='${address}'` },
  ];

  const results = await Promise.allSettled(
    searches.map(async ({ kind, expression }) => {
      const txs = await searchTxs(lcdUrl, expression);
      return txs
        .map((tx) => toEntry(tx, kind, address))
        .filter((entry): entry is HistoryEntry => entry !== undefined);
    }),
  );

  const entries: HistoryEntry[] = [];
  const failures: string[] = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      entries.push(...result.value);
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${searches[index].kind}: ${reason}`);
    }
  });

  // A transaction can match more than one search (sending to yourself, or
  // paying a grantee whose fee you also cover).
  const seen = new Set<string>();
  const deduped = entries.filter((entry) => {
    const key = `${entry.kind}:${entry.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => b.height - a.height);

  return {
    entries: deduped,
    error:
      failures.length === searches.length
        ? `This node did not answer the history query (${failures[0]}). It may not index transactions.`
        : undefined,
  };
}
