import { DEFAULT_CHAIN_ID, isChainId, type ChainId } from "./chains";
import type { SelectionMode } from "./feegrant-sdk";

/** User preferences, persisted in localStorage. */
export interface Settings {
  chainId: ChainId;
  theme: ThemePreference;
  /** Per-chain endpoint overrides. Empty string means "use the defaults". */
  lcdOverride: Partial<Record<ChainId, string>>;
  rpcOverride: Partial<Record<ChainId, string>>;
  /**
   * How every transaction this app sends pays its fee.
   *
   * - `auto`   - spend a received fee grant whenever one covers the fee.
   * - `select` - always use `feeGranter`, falling back to this wallet when it
   *   cannot pay.
   * - `off`    - always pay from this wallet.
   */
  feeMode: SelectionMode;
  /** Granter used when `feeMode` is `select`. Empty means none chosen. */
  feeGranter: string;
  /** Per-chain gas-vault contract address, overriding the built-in default. */
  gasVaultOverride: Partial<Record<ChainId, string>>;
}

export type ThemePreference = "system" | "dark" | "light";

export const STORAGE_KEY = "fee-granter:settings";

export const DEFAULT_SETTINGS: Settings = {
  chainId: DEFAULT_CHAIN_ID,
  theme: "dark",
  lcdOverride: {},
  rpcOverride: {},
  feeMode: "auto",
  feeGranter: "",
  gasVaultOverride: {},
};

function isTheme(value: unknown): value is ThemePreference {
  return value === "system" || value === "dark" || value === "light";
}

function isFeeMode(value: unknown): value is SelectionMode {
  return value === "auto" || value === "select" || value === "off";
}

function overrides(value: unknown): Partial<Record<ChainId, string>> {
  if (!value || typeof value !== "object") return {};
  const result: Partial<Record<ChainId, string>> = {};
  for (const [key, url] of Object.entries(value as Record<string, unknown>)) {
    if (isChainId(key) && typeof url === "string") result[key] = url;
  }
  return result;
}

/** Read settings, ignoring anything malformed rather than throwing. */
export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      chainId: isChainId(parsed.chainId) ? parsed.chainId : DEFAULT_SETTINGS.chainId,
      theme: isTheme(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      lcdOverride: overrides(parsed.lcdOverride),
      rpcOverride: overrides(parsed.rpcOverride),
      feeMode: isFeeMode(parsed.feeMode) ? parsed.feeMode : DEFAULT_SETTINGS.feeMode,
      feeGranter: typeof parsed.feeGranter === "string" ? parsed.feeGranter : "",
      gasVaultOverride: overrides(parsed.gasVaultOverride),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode, quota).
  }
}
