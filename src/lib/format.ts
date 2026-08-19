import { fromBech32 } from "@cosmjs/encoding";

import { BECH32_PREFIX, DECIMALS } from "./chain";

/** Non-breaking space used as the thousands separator, matching the design. */
const GROUP_SEPARATOR = " ";

/**
 * Convert a human decimal string ("1.5") into base units ("1500000").
 * Uses string maths so large values and 6-decimal precision survive intact.
 */
export function toMicroUnits(amount: string, decimals = DECIMALS): string {
  const trimmed = amount.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`"${amount}" is not a valid amount`);
  }

  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new Error(`At most ${decimals} decimal places are supported`);
  }

  const padded = fraction.padEnd(decimals, "0");
  const result = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return result === "" ? "0" : result;
}

/** Convert base units ("1500000") back into a human decimal string ("1.5"). */
export function fromMicroUnits(micro: string, decimals = DECIMALS): string {
  const negative = micro.startsWith("-");
  const digits = (negative ? micro.slice(1) : micro).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const value = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${value}` : value;
}

/**
 * Render base units for display: grouped thousands and at most `maxDecimals`
 * fractional digits, e.g. "15 000" or "0.15".
 */
export function formatAmount(micro: string, maxDecimals = 6): string {
  const plain = fromMicroUnits(micro);
  const [whole, fraction = ""] = plain.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP_SEPARATOR);
  const shortFraction = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  return shortFraction ? `${grouped}.${shortFraction}` : grouped;
}

/** Shorten an address for display: "secret1abcd…wxyz". */
export function truncateAddress(address: string, head = 12, tail = 6): string {
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** True when `address` is a well-formed bech32 Secret Network account address. */
export function isValidAddress(address: string): boolean {
  try {
    const { prefix, data } = fromBech32(address.trim());
    return prefix === BECH32_PREFIX && data.length === 20;
  } catch {
    return false;
  }
}

/**
 * protobuf `Duration` reaches us either as the proto3-JSON string the LCD emits
 * ("86400s") or as the `{ seconds, nanos }` object secretjs's typings promise.
 * Accept both and return whole seconds.
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

/**
 * protobuf `Timestamp` reaches us either as an RFC 3339 string or as a
 * `{ seconds, nanos }` object. Accept both and return a `Date`.
 */
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

const PERIOD_LABELS: Array<[number, string]> = [
  [86_400, "day"],
  [3_600, "hour"],
  [60, "minute"],
  [1, "second"],
];

/** Turn a period in seconds into a short unit label: "day", "6 hours", "30 days". */
export function formatPeriod(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "period";
  for (const [size, label] of PERIOD_LABELS) {
    if (seconds % size === 0) {
      const count = seconds / size;
      return count === 1 ? label : `${count} ${label}s`;
    }
  }
  return `${seconds} seconds`;
}

/** Format a date for the compact metadata lines. */
export function formatDate(date: Date | undefined): string | undefined {
  if (!date) return undefined;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Clamp a 0-100 percentage derived from two base-unit strings. */
export function percentUsed(used: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const raw = Number((used * 10_000n) / total) / 100;
  return Math.min(100, Math.max(0, raw));
}

/** "1 grant" / "3 grants". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
