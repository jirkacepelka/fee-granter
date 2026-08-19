/**
 * Fee grant SDK for Secret Network / cosmos-sdk chains.
 *
 * Self-contained on purpose: no React, no secretjs, no imports from the rest of
 * this app, so it can be copied into another project or published as its own
 * package. It covers the read-and-choose half of x/feegrant - discovering which
 * grants an address may spend against and picking one for a transaction.
 * Building the transaction stays with whatever signing library you already use;
 * all this produces is the address to put in `auth_info.fee.granter`.
 */

export const PERIODIC_TYPE_URL = "/cosmos.feegrant.v1beta1.PeriodicAllowance";
export const BASIC_TYPE_URL = "/cosmos.feegrant.v1beta1.BasicAllowance";
export const ALLOWED_MSG_TYPE_URL = "/cosmos.feegrant.v1beta1.AllowedMsgAllowance";

export const DEFAULT_DENOM = "uscrt";

/** `periodic` refills every period; `basic` is a fixed pot that never refills. */
export type AllowanceKind = "periodic" | "basic";

/** A fee grant, normalised from whichever allowance type the chain returned. */
export interface FeeGrant {
  granter: string;
  grantee: string;
  kind: AllowanceKind;
  /** Base units spendable per period. `periodic` only. */
  periodSpendLimit?: string;
  /** Period length in seconds. `periodic` only. */
  periodSeconds?: number;
  /** Base units left in the current period. `periodic` only. */
  periodCanSpend?: string;
  /** When the current period rolls over. Set by the chain after first use. */
  periodReset?: Date;
  /** Lifetime cap in base units. Undefined means uncapped. */
  spendLimit?: string;
  /** When the grant expires. Undefined means no expiry. */
  expiration?: Date;
  /** Present when the grant only covers certain message types. */
  allowedMessages?: string[];
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

interface RawAny {
  "@type"?: string;
  type_url?: string;
  [key: string]: unknown;
}

function coinAmount(coins: unknown, denom: string): string | undefined {
  if (!Array.isArray(coins)) return undefined;
  return (coins as Array<{ denom?: string; amount?: string }>).find(
    (coin) => coin?.denom === denom,
  )?.amount;
}

function typeUrlOf(allowance: RawAny | undefined): string {
  return (allowance?.["@type"] ?? allowance?.type_url ?? "") as string;
}

/**
 * protobuf `Duration` arrives either as the proto3-JSON string an LCD emits
 * ("86400s") or as a `{ seconds, nanos }` object, depending on the node's
 * marshaller. Accept both.
 */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const match = value.match(/^(-?\d+(?:\.\d+)?)s$/);
    if (match) return Math.round(Number(match[1]));
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? Math.round(asNumber) : undefined;
  }
  if (typeof value === "object" && "seconds" in (value as object)) {
    const seconds = Number((value as { seconds?: string | number }).seconds ?? 0);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  return undefined;
}

/** protobuf `Timestamp` as RFC 3339 or `{ seconds, nanos }`. Accept both. */
export function parseTimestamp(value: unknown): Date | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "object" && "seconds" in (value as object)) {
    const seconds = Number((value as { seconds?: string | number }).seconds ?? 0);
    if (!Number.isFinite(seconds)) return undefined;
    return new Date(seconds * 1000);
  }
  return undefined;
}

/** Unwrap an AllowedMsgAllowance, remembering which messages it is limited to. */
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
export function parseFeeGrant(
  raw: { granter?: string; grantee?: string; allowance?: unknown },
  denom = DEFAULT_DENOM,
): FeeGrant | undefined {
  if (!raw.granter || !raw.grantee) return undefined;

  const { inner, allowedMessages } = unwrap(raw.allowance as RawAny | undefined);
  if (!inner) return undefined;

  const base = {
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
      periodSpendLimit: coinAmount(inner.period_spend_limit, denom),
      periodSeconds: parseDurationSeconds(inner.period),
      periodCanSpend: coinAmount(inner.period_can_spend, denom),
      periodReset: parseTimestamp(inner.period_reset),
      spendLimit: coinAmount(basic.spend_limit, denom),
      expiration: parseTimestamp(basic.expiration),
    };
  }

  if (typeUrl === BASIC_TYPE_URL) {
    return {
      ...base,
      kind: "basic",
      spendLimit: coinAmount(inner.spend_limit, denom),
      expiration: parseTimestamp(inner.expiration),
    };
  }

  // An allowance type this SDK does not model. Better to ignore it than to
  // guess at limits and pick a grant the chain will reject.
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every grant `grantee` may spend against.
 *
 * Uses `/cosmos/feegrant/v1beta1/allowances/{grantee}`, which has existed since
 * cosmos-sdk v0.43 and therefore needs none of the version fallbacks the
 * by-granter listing does.
 */
export async function fetchFeeGrants(
  lcdUrl: string,
  grantee: string,
  options: { denom?: string; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<FeeGrant[]> {
  const { denom = DEFAULT_DENOM, limit = 100, fetchImpl = fetch } = options;
  const url =
    `${lcdUrl.replace(/\/+$/, "")}/cosmos/feegrant/v1beta1/allowances/` +
    `${encodeURIComponent(grantee)}?pagination.limit=${limit}`;

  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Fee grant lookup failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as {
    allowances?: Array<{ granter?: string; grantee?: string; allowance?: unknown }>;
  };

  return (body.allowances ?? [])
    .map((grant) => parseFeeGrant(grant, denom))
    .filter((grant): grant is FeeGrant => grant !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What can still be spent against a grant right now, in base units.
 * `undefined` means uncapped.
 *
 * For a periodic grant the lifetime cap also applies: the chain caps
 * `period_can_spend` by `basic.spend_limit` when it resets a period, so a grant
 * with 5 SCRT left this period but only 2 SCRT of lifetime budget can pay 2.
 */
export function availableFee(grant: FeeGrant): bigint | undefined {
  const lifetime = grant.spendLimit === undefined ? undefined : BigInt(grant.spendLimit);

  if (grant.kind === "basic") return lifetime;

  const period = grant.periodCanSpend ?? grant.periodSpendLimit;
  if (period === undefined) return lifetime;

  const periodValue = BigInt(period);
  if (lifetime === undefined) return periodValue;
  return periodValue < lifetime ? periodValue : lifetime;
}

/** Why a grant cannot pay for a given transaction. `undefined` means it can. */
export type Unusable = "expired" | "insufficient" | "message-not-allowed";

export interface UsabilityContext {
  /** Fee the transaction will pay, in base units. */
  fee: string | bigint;
  /** Message type URLs in the transaction, checked against AllowedMsgAllowance. */
  msgTypeUrls?: string[];
  /** Defaults to now. Injectable so callers can test deterministically. */
  now?: Date;
}

export function checkUsable(grant: FeeGrant, context: UsabilityContext): Unusable | undefined {
  const now = context.now ?? new Date();
  if (grant.expiration && grant.expiration.getTime() <= now.getTime()) return "expired";

  if (grant.allowedMessages?.length && context.msgTypeUrls?.length) {
    const allowed = new Set(grant.allowedMessages);
    if (!context.msgTypeUrls.every((type) => allowed.has(type))) return "message-not-allowed";
  }

  const available = availableFee(grant);
  if (available !== undefined && available < BigInt(context.fee)) return "insufficient";

  return undefined;
}

export function isUsable(grant: FeeGrant, context: UsabilityContext): boolean {
  return checkUsable(grant, context) === undefined;
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

/** Sorts as "uncapped beats any number", for comparing available balances. */
function compareAvailable(a: FeeGrant, b: FeeGrant): number {
  const left = availableFee(a);
  const right = availableFee(b);
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return left > right ? -1 : 1;
}

/**
 * Ranking used by `auto`, best first:
 *
 *  1. Recurring before one-time. A periodic grant refills, so spending it costs
 *     the granter less than burning a one-time grant outright.
 *  2. More left over less. Maximises the chance the fee fits and leaves headroom.
 *  3. Shorter period over longer. Between two grants with the same balance, the
 *     one that refills sooner is the cheaper one to draw down.
 *  4. Granter address, so the order is stable across calls.
 */
export function compareGrants(a: FeeGrant, b: FeeGrant): number {
  if (a.kind !== b.kind) return a.kind === "periodic" ? -1 : 1;

  const byAvailable = compareAvailable(a, b);
  if (byAvailable !== 0) return byAvailable;

  const aPeriod = a.periodSeconds ?? Number.MAX_SAFE_INTEGER;
  const bPeriod = b.periodSeconds ?? Number.MAX_SAFE_INTEGER;
  if (aPeriod !== bPeriod) return aPeriod - bPeriod;

  return a.granter.localeCompare(b.granter);
}

/** Every grant that can pay for this transaction, best first. */
export function rankFeeGrants(grants: FeeGrant[], context: UsabilityContext): FeeGrant[] {
  return grants.filter((grant) => isUsable(grant, context)).sort(compareGrants);
}

/**
 * - `auto`   — pick the best usable grant automatically. The default.
 * - `select` — use the grant from `granter`, if it can pay.
 * - `off`    — pay from the wallet's own balance.
 */
export type SelectionMode = "auto" | "select" | "off";

export interface SelectOptions extends UsabilityContext {
  /** Defaults to `auto`: spend a grant whenever one can cover the fee. */
  mode?: SelectionMode;
  /** Required when mode is `select`. */
  granter?: string;
}

export interface Selection {
  /** Put this in `auth_info.fee.granter`. Undefined means pay it yourself. */
  granter?: string;
  grant?: FeeGrant;
  /** Set when no grant was chosen, so the UI can explain why. */
  reason?: "off" | "no-usable-grant" | "granter-not-given" | "granter-not-usable";
  /** Why the named granter was rejected, when mode is `select`. */
  rejected?: Unusable;
  /** Everything that could have paid, best first. */
  candidates: FeeGrant[];
}

/**
 * Choose the fee granter for a transaction.
 *
 * Nothing here talks to a chain: pass in the grants from `fetchFeeGrants` and
 * the fee the transaction will pay, and take `granter` from the result.
 *
 * A grant is preferred over the wallet's own funds whenever one can cover the
 * fee - that is what `auto` means, and it is the default. The wallet's balance
 * is never consulted: a grant wins even when the wallet could easily pay for
 * itself, because the granter created the grant precisely so it would be used.
 * Pass `mode: "off"` to spend your own funds instead.
 */
export function selectFeeGrant(grants: FeeGrant[], options: SelectOptions): Selection {
  const candidates = rankFeeGrants(grants, options);
  const mode = options.mode ?? "auto";

  if (mode === "off") return { reason: "off", candidates };

  if (mode === "select") {
    if (!options.granter) return { reason: "granter-not-given", candidates };
    const chosen = grants.find((grant) => grant.granter === options.granter);
    const rejected = chosen ? checkUsable(chosen, options) : undefined;
    if (!chosen || rejected) {
      return { reason: "granter-not-usable", rejected, candidates };
    }
    return { granter: chosen.granter, grant: chosen, candidates };
  }

  const best = candidates[0];
  if (!best) return { reason: "no-usable-grant", candidates };
  return { granter: best.granter, grant: best, candidates };
}

/* -------------------------------------------------------------------------- */
/* Fees                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fee for a gas limit at a gas price, in base units, rounded up the way chains
 * do. Use the same numbers you pass to your signing library, or the grant may
 * be judged able to pay a fee that is actually larger.
 */
export function estimateFee(gasLimit: number, gasPriceInBaseUnits: number): string {
  return BigInt(Math.ceil(gasLimit * gasPriceInBaseUnits)).toString();
}
