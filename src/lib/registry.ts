import { CHAIN_ID } from "./chain";

/**
 * Local record of grantees this browser has granted to.
 *
 * `AllowancesByGranter` only exists on cosmos-sdk v0.46+. When the node does
 * not expose it there is no way to enumerate grants from the granter side, so
 * we remember grantees locally and verify each one against the chain with the
 * single-grant query. The chain always stays the source of truth - this is
 * just a list of addresses worth checking.
 */

function storageKey(granter: string): string {
  return `fee-granter:grantees:${CHAIN_ID}:${granter}`;
}

function read(granter: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(storageKey(granter));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function write(granter: string, grantees: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(granter), JSON.stringify(grantees));
  } catch {
    // Storage may be unavailable (private mode, quota). Not worth failing over.
  }
}

export function listKnownGrantees(granter: string): string[] {
  return read(granter);
}

export function rememberGrantee(granter: string, grantee: string): void {
  const known = read(granter);
  if (known.includes(grantee)) return;
  write(granter, [...known, grantee]);
}

export function forgetGrantee(granter: string, grantee: string): void {
  write(
    granter,
    read(granter).filter((address) => address !== grantee),
  );
}

/** Keep the local list in sync with whatever the chain reported. */
export function syncKnownGrantees(granter: string, grantees: string[]): void {
  const known = read(granter);
  const merged = [...new Set([...known, ...grantees])];
  write(granter, merged);
}
