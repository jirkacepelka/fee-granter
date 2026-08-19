import { DENOM } from "./chains";
import { fetchJson } from "./endpoint";

/**
 * Recent activity for one address, limited to what this app is about: SCRT
 * moving in or out, and fee grants being spent.
 *
 * Cosmos exposes this only as an indexed event search, which is awkward in
 * three ways this module works around:
 *
 *  - The query parameter changed across SDK versions (`events=` up to 0.47,
 *    `query=` from 0.50) and a node given the wrong one may answer 200 with an
 *    empty list rather than an error, so an empty result is treated as "try the
 *    next form", never as "there is nothing".
 *  - Which event keys are indexed varies, so several equivalent expressions are
 *    tried per kind and the results merged.
 *  - `tx_response.logs` is populated up to SDK 0.47 and empty from 0.50, where
 *    events moved to `tx_response.events` with base64 keys in some versions.
 *    Amounts are therefore read from `tx.body.messages`, which is always
 *    present, and events are only a fallback.
 *
 * A node can also be configured not to index at all, in which case the search
 * legitimately returns nothing - callers should present an empty history as
 * "nothing found", never as fact.
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

const MSG_SEND = "/cosmos.bank.v1beta1.MsgSend";
const MSG_MULTI_SEND = "/cosmos.bank.v1beta1.MsgMultiSend";

interface RawCoin {
  denom?: string;
  amount?: string;
}

interface RawMessage {
  "@type"?: string;
  from_address?: string;
  to_address?: string;
  amount?: RawCoin[];
  inputs?: Array<{ address?: string; coins?: RawCoin[] }>;
  outputs?: Array<{ address?: string; coins?: RawCoin[] }>;
}

interface RawEvent {
  type?: string;
  attributes?: Array<{ key?: string; value?: string }>;
}

interface RawTxResponse {
  txhash?: string;
  height?: string;
  timestamp?: string;
  code?: number;
  tx?: {
    auth_info?: { fee?: { amount?: RawCoin[]; granter?: string } };
    body?: { messages?: RawMessage[] };
  };
  logs?: Array<{ events?: RawEvent[] }>;
  events?: RawEvent[];
}

const PAGE_LIMIT = 30;

function coinAmount(coins: RawCoin[] | undefined): string | undefined {
  return coins?.find((coin) => coin?.denom === DENOM)?.amount;
}

/** Sum the uscrt across a list of coins. */
function sumCoins(coins: RawCoin[] | undefined): bigint {
  return (coins ?? []).reduce(
    (total, coin) => (coin?.denom === DENOM ? total + BigInt(coin.amount ?? "0") : total),
    0n,
  );
}

/**
 * Attribute lookup that tolerates both plain and base64-encoded keys, since
 * `logs[].events` uses plain strings while `tx_response.events` has used base64
 * in some SDK versions.
 */
function decode(value: string | undefined): string | undefined {
  if (!value) return value;
  if (typeof atob !== "function") return value;
  try {
    const decoded = atob(value);
    // Only accept it if the result is printable - random bytes mean it was not
    // base64 to begin with.
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

function attrMap(event: RawEvent | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const attribute of event?.attributes ?? []) {
    const rawKey = attribute.key;
    const rawValue = attribute.value ?? "";
    if (!rawKey) continue;
    // Register both readings so lookups work either way.
    map.set(rawKey, rawValue);
    const decodedKey = decode(rawKey);
    if (decodedKey && !map.has(decodedKey)) map.set(decodedKey, decode(rawValue) ?? rawValue);
  }
  return map;
}

function allEvents(tx: RawTxResponse): RawEvent[] {
  const fromLogs = (tx.logs ?? []).flatMap((log) => log.events ?? []);
  return fromLogs.length > 0 ? fromLogs : (tx.events ?? []);
}

/** Pull "1234uscrt" style values out of a transfer event's amount attribute. */
function parseEventAmount(value: string | undefined): string | undefined {
  const match = value?.match(new RegExp(`(\\d+)${DENOM}`));
  return match?.[1];
}

/**
 * Run one tx search across both parameter spellings.
 *
 * A variant that errors, or that answers with an empty list, falls through to
 * the next: a node given the wrong parameter name may ignore it and return an
 * unfiltered-but-empty page rather than a 400, and treating that as a real
 * "no results" is what silently hides transfers.
 */
async function searchTxs(lcdUrl: string, expression: string): Promise<RawTxResponse[]> {
  const base = `${lcdUrl}/cosmos/tx/v1beta1/txs`;
  const variants = [
    `${base}?events=${encodeURIComponent(expression)}&pagination.limit=${PAGE_LIMIT}&order_by=ORDER_BY_DESC`,
    `${base}?query=${encodeURIComponent(expression)}&limit=${PAGE_LIMIT}&order_by=ORDER_BY_DESC`,
  ];

  let lastError: unknown;
  let sawEmpty = false;

  for (const url of variants) {
    try {
      const body = (await fetchJson(url, 12_000)) as { tx_responses?: RawTxResponse[] };
      const found = body.tx_responses ?? [];
      if (found.length > 0) return found;
      sawEmpty = true;
    } catch (caught) {
      lastError = caught;
    }
  }

  // Every variant answered, just with nothing in it.
  if (sawEmpty) return [];
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Amount and counterparty for a transfer, read from the transaction's own
 * messages. This is version-independent, and it naturally ignores the fee
 * payment that every transaction makes to the fee collector - which would
 * otherwise make every transaction look like a send.
 */
function transferFromMessages(
  tx: RawTxResponse,
  kind: "sent" | "received",
  address: string,
): { amount: string; counterparty?: string } | undefined {
  let total = 0n;
  let counterparty: string | undefined;

  for (const message of tx.tx?.body?.messages ?? []) {
    if (message["@type"] === MSG_SEND) {
      const isMatch =
        kind === "sent" ? message.from_address === address : message.to_address === address;
      if (!isMatch) continue;
      total += sumCoins(message.amount);
      counterparty ??= kind === "sent" ? message.to_address : message.from_address;
    } else if (message["@type"] === MSG_MULTI_SEND) {
      if (kind === "sent") {
        for (const input of message.inputs ?? []) {
          if (input.address === address) total += sumCoins(input.coins);
        }
        counterparty ??= message.outputs?.[0]?.address;
      } else {
        for (const output of message.outputs ?? []) {
          if (output.address === address) total += sumCoins(output.coins);
        }
        counterparty ??= message.inputs?.[0]?.address;
      }
    }
  }

  return total > 0n ? { amount: total.toString(), counterparty } : undefined;
}

/** Fallback for transfers that did not come from a recognised bank message. */
function transferFromEvents(
  tx: RawTxResponse,
  kind: "sent" | "received",
  address: string,
): { amount: string; counterparty?: string } | undefined {
  for (const event of allEvents(tx)) {
    if (decode(event.type) !== "transfer" && event.type !== "transfer") continue;
    const attrs = attrMap(event);
    const sender = attrs.get("sender");
    const recipient = attrs.get("recipient");
    if (kind === "sent" ? sender !== address : recipient !== address) continue;
    // Skip the fee payment leg, which every transaction has.
    if (kind === "sent" && recipient && recipient === feeCollectorOf(tx)) continue;

    const amount = parseEventAmount(attrs.get("amount"));
    if (!amount) continue;
    return { amount, counterparty: kind === "sent" ? recipient : sender };
  }
  return undefined;
}

/** The fee payment's recipient, so it can be excluded from "sent". */
function feeCollectorOf(tx: RawTxResponse): string | undefined {
  const fee = coinAmount(tx.tx?.auth_info?.fee?.amount);
  if (!fee) return undefined;
  for (const event of allEvents(tx)) {
    if (decode(event.type) !== "transfer" && event.type !== "transfer") continue;
    const attrs = attrMap(event);
    if (parseEventAmount(attrs.get("amount")) === fee) return attrs.get("recipient");
  }
  return undefined;
}

function granteeOf(tx: RawTxResponse): string | undefined {
  for (const event of allEvents(tx)) {
    const type = decode(event.type) ?? event.type;
    if (type !== "use_feegrant") continue;
    return attrMap(event).get("grantee");
  }
  return undefined;
}

function toEntry(
  tx: RawTxResponse,
  kind: HistoryKind,
  address: string,
): HistoryEntry | undefined {
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
    fee: coinAmount(tx.tx?.auth_info?.fee?.amount),
  };

  if (kind === "feegrant") {
    // The search can only filter on indexed events; confirm from the tx itself
    // that this address really was the granter.
    const granter = tx.tx?.auth_info?.fee?.granter;
    if (granter && granter !== address) return undefined;
    return { ...base, counterparty: granteeOf(tx) };
  }

  const transfer =
    transferFromMessages(tx, kind, address) ?? transferFromEvents(tx, kind, address);
  // No SCRT actually moved to or from this address - most likely the tx merely
  // matched because the address paid its fee.
  if (!transfer) return undefined;

  return { ...base, amount: transfer.amount, counterparty: transfer.counterparty };
}

/**
 * Several equivalent expressions per kind, because which event keys a node
 * indexes varies. Results are merged and de-duplicated.
 */
function expressionsFor(kind: HistoryKind, address: string): string[] {
  switch (kind) {
    case "sent":
      return [
        `transfer.sender='${address}'`,
        `message.sender='${address}'`,
        `coin_spent.spender='${address}'`,
      ];
    case "received":
      return [`transfer.recipient='${address}'`, `coin_received.receiver='${address}'`];
    case "feegrant":
      return [`use_feegrant.granter='${address}'`];
  }
}

export interface HistoryResult {
  entries: HistoryEntry[];
  /** Set when every search failed, so the UI can say why it is empty. */
  error?: string;
}

/** Fetch sends, receives and fee-grant usage, newest first. */
export async function fetchHistory(lcdUrl: string, address: string): Promise<HistoryResult> {
  const kinds: HistoryKind[] = ["sent", "received", "feegrant"];

  const queries = kinds.flatMap((kind) =>
    expressionsFor(kind, address).map((expression) => ({ kind, expression })),
  );

  const results = await Promise.allSettled(
    queries.map(async ({ kind, expression }) => {
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
      failures.push(
        `${queries[index].expression}: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`,
      );
    }
  });

  // The same transaction turns up under several expressions, and can legitimately
  // be both a send and a receive (paying yourself, or covering a grantee's fee).
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
      failures.length === queries.length
        ? `This node did not answer the history query (${failures[0]}). It may not index transactions.`
        : undefined,
  };
}
