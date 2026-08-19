import {
  MsgGrantAllowance,
  MsgRevokeAllowance,
  SecretNetworkClient,
  type Msg,
  type TxResponse,
} from "secretjs";

import { DENOM, GAS_GRANT, GAS_PRICE_USCRT, GAS_REVOKE } from "./chains";
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

/**
 * What kind of allowance to create.
 *
 * - `periodic` - a budget that refills every period ("0.15 SCRT / day").
 * - `oneshot`  - a fixed pot that never refills. x/feegrant deletes the grant
 *   the moment it is used up, so the grantee cannot spend against it again.
 */
export type GrantKind = "periodic" | "oneshot";

/** Values collected by the create / edit form. */
export interface GrantInput {
  grantee: string;
  kind: GrantKind;
  /**
   * Human decimal string. The per-period limit for `periodic` grants, or the
   * whole one-time budget for `oneshot` ones.
   */
  amount: string;
  /** Period length in seconds. `periodic` only. */
  periodSeconds?: number;
  /** Optional lifetime cap as a human decimal string. `periodic` only. */
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

/**
 * Fetch every grant this address may spend against.
 *
 * Unlike `AllowancesByGranter`, this endpoint has existed since cosmos-sdk
 * v0.43, so it works on every Secret Network version.
 */
export async function queryGrantsByGrantee(
  client: SecretNetworkClient,
  grantee: string,
): Promise<FeeGrant[]> {
  const response = await client.query.feegrant.allowances({
    grantee,
    pagination: { limit: "100" },
  });
  return (response.allowances ?? [])
    .map(parseGrant)
    .filter((grant): grant is FeeGrant => grant !== undefined);
}

/**
 * What the grantee can still spend against a grant right now, in base units.
 * `undefined` means uncapped.
 */
export function availableNow(grant: FeeGrant): string | undefined {
  if (grant.kind === "periodic") return grant.periodCanSpend ?? grant.periodSpendLimit;
  return grant.spendLimit;
}

/** Grants that have not expired and still have something left on them. */
export function usableGrants(grants: FeeGrant[]): FeeGrant[] {
  const now = Date.now();
  return grants.filter((grant) => {
    if (grant.expiration && grant.expiration.getTime() < now) return false;
    const available = availableNow(grant);
    return available === undefined || BigInt(available) > 0n;
  });
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
 * Turn form values into the allowance the chain should store.
 *
 * A `oneshot` grant is a plain `BasicAllowance`: a fixed pot with no period, so
 * nothing ever refills it. `BasicAllowance.Accept` reports the grant as spent
 * once the limit reaches zero and x/feegrant then deletes it, which is what
 * makes it unusable a second time. Note that this bounds the *amount*, not the
 * number of transactions - a grantee whose fees come in under the limit can
 * keep spending the remainder. Size it to roughly one transaction's fee for
 * genuinely single-use behaviour.
 *
 * A `periodic` grant seeds `period_can_spend` with the full period limit so the
 * grantee can spend immediately; the chain resets it every `period`.
 */
export function buildAllowance(input: GrantInput) {
  const amount = coins(toMicroUnits(input.amount));
  const expiration = input.expiration
    ? { expiration: protoTimestamp(input.expiration) }
    : {};

  if (input.kind === "oneshot") {
    return { spend_limit: amount, ...expiration };
  }

  const hasTotal = Boolean(input.totalLimit && input.totalLimit.trim() !== "");

  return {
    basic: {
      spend_limit: hasTotal ? coins(toMicroUnits(input.totalLimit!)) : [],
      ...expiration,
    },
    period: { seconds: String(input.periodSeconds ?? 86_400), nanos: 0 },
    period_spend_limit: amount,
    period_can_spend: amount,
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
  /** Number of one-time (BasicAllowance) grants outstanding. */
  oneshotCount: number;
  /** Base units still sitting on those one-time grants. */
  oneshotTotal: bigint;
  /** The most common period across grants, used for the "/ day" label. */
  dominantPeriod?: number;
}

export function summarise(grants: FeeGrant[]): GrantTotals {
  let periodTotal = 0n;
  let periodUsed = 0n;
  let grantedTotal = 0n;
  let hasUncapped = false;
  let oneshotCount = 0;
  let oneshotTotal = 0n;
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

    if (grant.kind === "basic") {
      oneshotCount += 1;
      if (grant.spendLimit) oneshotTotal += BigInt(grant.spendLimit);
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

  return {
    periodTotal,
    periodUsed,
    grantedTotal,
    hasUncapped,
    oneshotCount,
    oneshotTotal,
    dominantPeriod,
  };
}
