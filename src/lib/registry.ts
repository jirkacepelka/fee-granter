/**
 * Local record of grantees this browser has granted to.
 *
 * `AllowancesByGranter` only exists on cosmos-sdk v0.46+. When the node does
 * not expose it there is no way to enumerate grants from the granter side, so
 * we remember grantees locally and verify each one against the chain with the
 * single-grant query. The chain always stays the source of truth - this is
 * just a list of addresses worth checking.
 */

function storageKey(chainId: string, granter: string): string {
  return `fee-granter:grantees:${chainId}:${granter}`;
}

function read(chainId: string, granter: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(storageKey(chainId, granter));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function write(chainId: string, granter: string, grantees: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(chainId, granter), JSON.stringify(grantees));
  } catch {
    // Storage may be unavailable (private mode, quota). Not worth failing over.
  }
}

export function listKnownGrantees(chainId: string, granter: string): string[] {
  return read(chainId, granter);
}

export function rememberGrantee(chainId: string, granter: string, grantee: string): void {
  const known = read(chainId, granter);
  if (known.includes(grantee)) return;
  write(chainId, granter, [...known, grantee]);
}

export function forgetGrantee(chainId: string, granter: string, grantee: string): void {
  write(
    chainId,
    granter,
    read(chainId, granter).filter((address) => address !== grantee),
  );
}

/** Keep the local list in sync with whatever the chain reported. */
export function syncKnownGrantees(chainId: string, granter: string, grantees: string[]): void {
  const known = read(chainId, granter);
  const merged = [...new Set([...known, ...grantees])];
  write(chainId, granter, merged);
}
