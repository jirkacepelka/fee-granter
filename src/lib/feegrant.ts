import {
  MsgGrantAllowance,
  MsgRevokeAllowance,
  SecretNetworkClient,
  type Msg,
  type TxResponse,
} from "secretjs";

import {
  DENOM,
  GAS_GRANT,
  GAS_PRICE_USCRT,
  GAS_REVOKE,
} from "./chain";
import { parseDurationSeconds, parseTimestamp, toMicroUnits } from "./format";

export const PERIODIC_TYPE_URL = "/cosmos.feegrant.v1beta1.PeriodicAllowance";
export const BASIC_TYPE_URL = "/cosmos.feegrant.v1beta1.BasicAllowance";
export const ALLOWED_MSG_TYPE_URL = "/cosmos.feegrant.v1beta1.AllowedMsgAllowance";

export type AllowanceKind = "basic" | "periodic";

/** A fee grant, normalised from whichever allowance type the chain returned. */
export interface FeeGrant {
  granter: string;
  grantee: string;
  kind: AllowanceKind;
  /** Base units the grantee may spend per period. Undefined for basic grants. */
  periodSpendLimit?: string;
  /** Length of a period in seconds. Undefined for basic grants. */
  periodSeconds?: number;
  /** Base units still spendable in the current period. */
  periodCanSpend?: string;
  /** When the current period rolls over. Set by the chain after first use. */
  periodReset?: Date;
  /** Lifetime cap in base units. Undefined means uncapped. */
  spendLimit?: string;
  /** When the grant expires. Undefined means no expiry. */
  expiration?: Date;
  /** Present when the grant is wrapped in an AllowedMsgAllowance. */
  allowedMessages?: string[];
}

/** Values collected by the create / edit form. */
export interface GrantInput {
  grantee: string;
  /** Human decimal string, e.g. "0.15". */
  periodLimit: string;
  /** Period length in seconds. */
  periodSeconds: number;
  /** Optional lifetime cap as a human decimal string. Empty means uncapped. */
  totalLimit?: string;
  /** Optional expiry. */
  expiration?: Date;
}

type Coin = { denom: string; amount: string };

interface RawAny {
  "@type"?: string;
  type_url?: string;
  [key: string]: unknown;
}

function coinAmount(coins: unknown, denom = DENOM): string | undefined {
  if (!Array.isArray(coins)) return undefined;
  const match = (coins as Coin[]).find((coin) => coin?.denom === denom);
  return match?.amount;
}

function typeUrlOf(allowance: RawAny | undefined): string {
  return (allowance?.["@type"] ?? allowance?.type_url ?? "") as string;
}

/**
 * Unwrap an AllowedMsgAllowance so the inner basic/periodic allowance can be
 * read, remembering which messages the grant was restricted to.
 */
function unwrap(allowance: RawAny | undefined): {
  inner: RawAny | undefined;
  allowedMessages?: string[];
} {
  if (typeUrlOf(allowance) === ALLOWED_MSG_TYPE_URL) {
    return {
      inner: allowance?.allowance as RawAny | undefined,
      allowedMessages: (allowance?.allowed_messages as string[] | undefined) ?? [],
    };
  }
  return { inner: allowance };
}

/** Normalise one raw grant from the LCD into a `FeeGrant`. */
export function parseGrant(raw: {
  granter?: string;
  grantee?: string;
  allowance?: unknown;
}): FeeGrant | undefined {
  if (!raw.granter || !raw.grantee) return undefined;

  const { inner, allowedMessages } = unwrap(raw.allowance as RawAny | undefined);
  if (!inner) return undefined;

  const base: Pick<FeeGrant, "granter" | "grantee" | "allowedMessages"> = {
    granter: raw.granter,
    grantee: raw.grantee,
    allowedMessages: allowedMessages?.length ? allowedMessages : undefined,
  };

  const typeUrl = typeUrlOf(inner);

  if (typeUrl === PERIODIC_TYPE_URL) {
    const basic = (inner.basic ?? {}) as RawAny;
    return {
      ...base,
      kind: "periodic",
      periodSpendLimit: coinAmount(inner.period_spend_limit),
      periodSeconds: parseDurationSeconds(inner.period),
      periodCanSpend: coinAmount(inner.period_can_spend),
      periodReset: parseTimestamp(inner.period_reset),
      spendLimit: coinAmount(basic.spend_limit),
      expiration: parseTimestamp(basic.expiration),
    };
  }

  if (typeUrl === BASIC_TYPE_URL) {
    return {
      ...base,
      kind: "basic",
      spendLimit: coinAmount(inner.spend_limit),
      expiration: parseTimestamp(inner.expiration),
    };
  }

  return undefined;
}

/** Build the read-only client used for every query. */
export function readonlyClient(url: string, chainId: string): SecretNetworkClient {
  return new SecretNetworkClient({ url, chainId });
}

/**
 * Fetch every grant issued by `granter`.
 *
 * `AllowancesByGranter` landed in cosmos-sdk v0.46, and pulsar-3 may still be
 * running an older SDK, in which case the endpoint 501s. Callers should catch
 * `GranterQueryUnsupported` and fall back to per-grantee lookups.
 */
export class GranterQueryUnsupported extends Error {
  constructor(cause: unknown) {
    super("This node does not support querying allowances by granter.");
    this.name = "GranterQueryUnsupported";
    this.cause = cause;
  }
}

export async function queryGrantsByGranter(
  client: SecretNetworkClient,
  granter: string,
): Promise<FeeGrant[]> {
  try {
    const response = await client.query.feegrant.allowancesByGranter({
      granter,
      pagination: { limit: "500" },
    });
    return (response.allowances ?? [])
      .map(parseGrant)
      .filter((grant): grant is FeeGrant => grant !== undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/501|not implemented|unknown|unimplemented/i.test(message)) {
      throw new GranterQueryUnsupported(error);
    }
    throw error;
  }
}

/** Look up a single granter -> grantee grant. Returns undefined when absent. */
export async function queryGrant(
  client: SecretNetworkClient,
  granter: string,
  grantee: string,
): Promise<FeeGrant | undefined> {
  try {
    const response = await client.query.feegrant.allowance({ granter, grantee });
    return response.allowance ? parseGrant(response.allowance) : undefined;
  } catch {
    // A missing grant surfaces as a 404/NotFound - treat it as "no grant".
    return undefined;
  }
}

function coins(amount: string): Coin[] {
  return [{ denom: DENOM, amount }];
}

function protoTimestamp(date: Date): { seconds: string; nanos: number } {
  return { seconds: Math.floor(date.getTime() / 1000).toString(), nanos: 0 };
}

/**
 * Turn form values into a `PeriodicAllowance`.
 *
 * `period_can_spend` is seeded with the full period limit so the grantee can
 * spend immediately; the chain resets it every `period`.
 */
export function buildAllowance(input: GrantInput) {
  const periodLimit = coins(toMicroUnits(input.periodLimit));
  const hasTotal = Boolean(input.totalLimit && input.totalLimit.trim() !== "");

  return {
    basic: {
      spend_limit: hasTotal ? coins(toMicroUnits(input.totalLimit!)) : [],
      ...(input.expiration ? { expiration: protoTimestamp(input.expiration) } : {}),
    },
    period: { seconds: String(input.periodSeconds), nanos: 0 },
    period_spend_limit: periodLimit,
    period_can_spend: periodLimit,
  };
}

const txOptions = (gasLimit: number) => ({
  gasLimit,
  gasPriceInFeeDenom: GAS_PRICE_USCRT,
  feeDenom: DENOM,
});

/** Create a brand new fee grant. */
export async function grantAllowance(
  client: SecretNetworkClient,
  granter: string,
  input: GrantInput,
): Promise<TxResponse> {
  return client.tx.feegrant.grantAllowance(
    {
      granter,
      grantee: input.grantee.trim(),
      allowance: buildAllowance(input),
    },
    txOptions(GAS_GRANT),
  );
}

/**
 * Change an existing grant.
 *
 * x/feegrant rejects `MsgGrantAllowance` when a grant already exists, so an
 * edit is a revoke and a re-grant executed atomically in one transaction.
 */
export async function updateAllowance(
  client: SecretNetworkClient,
  granter: string,
  input: GrantInput,
): Promise<TxResponse> {
  const grantee = input.grantee.trim();
  const messages: Msg[] = [
    new MsgRevokeAllowance({ granter, grantee }),
    new MsgGrantAllowance({ granter, grantee, allowance: buildAllowance(input) }),
  ];
  return client.tx.broadcast(messages, txOptions(GAS_GRANT + GAS_REVOKE));
}

/** Revoke a single fee grant. */
export async function revokeAllowance(
  client: SecretNetworkClient,
  granter: string,
  grantee: string,
): Promise<TxResponse> {
  return client.tx.feegrant.revokeAllowance(
    { granter, grantee },
    txOptions(GAS_REVOKE),
  );
}

/** Revoke every listed grant in one transaction - powers "Suspend all". */
export async function revokeAll(
  client: SecretNetworkClient,
  granter: string,
  grantees: string[],
): Promise<TxResponse> {
  const messages: Msg[] = grantees.map(
    (grantee) => new MsgRevokeAllowance({ granter, grantee }),
  );
  return client.tx.broadcast(messages, txOptions(GAS_REVOKE * grantees.length));
}

/** Aggregate figures backing the two summary cards. */
export interface GrantTotals {
  /** Sum of per-period limits, in base units. */
  periodTotal: bigint;
  /** Sum of what has already been spent in the current period. */
  periodUsed: bigint;
  /** Sum of lifetime caps, in base units. */
  grantedTotal: bigint;
  /** True when at least one grant has no lifetime cap. */
  hasUncapped: boolean;
  /** The most common period across grants, used for the "/ day" label. */
  dominantPeriod?: number;
}

export function summarise(grants: FeeGrant[]): GrantTotals {
  let periodTotal = 0n;
  let periodUsed = 0n;
  let grantedTotal = 0n;
  let hasUncapped = false;
  const periodCounts = new Map<number, number>();

  for (const grant of grants) {
    if (grant.periodSpendLimit) {
      const limit = BigInt(grant.periodSpendLimit);
      periodTotal += limit;
      // period_can_spend is what is left; anything missing has been spent.
      const canSpend = grant.periodCanSpend ? BigInt(grant.periodCanSpend) : limit;
      const used = limit > canSpend ? limit - canSpend : 0n;
      periodUsed += used;
    }

    if (grant.spendLimit) {
      grantedTotal += BigInt(grant.spendLimit);
    } else {
      hasUncapped = true;
    }

    if (grant.periodSeconds) {
      periodCounts.set(grant.periodSeconds, (periodCounts.get(grant.periodSeconds) ?? 0) + 1);
    }
  }

  let dominantPeriod: number | undefined;
  let bestCount = 0;
  for (const [period, count] of periodCounts) {
    if (count > bestCount) {
      dominantPeriod = period;
      bestCount = count;
    }
  }

  return { periodTotal, periodUsed, grantedTotal, hasUncapped, dominantPeriod };
}
