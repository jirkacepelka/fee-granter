"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { CHAINS, type ChainConfig, type ChainId } from "@/lib/chains";
import type { SelectionMode } from "@/lib/feegrant-sdk";
import { resetResolvedEndpoints } from "@/lib/endpoint";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
  type ThemePreference,
} from "@/lib/settings";

interface SettingsContextValue extends Settings {
  chain: ChainConfig;
  /** Endpoint overrides for the active chain, or "" when using defaults. */
  activeLcdOverride: string;
  activeRpcOverride: string;
  setChainId: (chainId: ChainId) => void;
  setTheme: (theme: ThemePreference) => void;
  setEndpointOverride: (kind: "lcd" | "rpc", chainId: ChainId, url: string) => void;
  setFeeMode: (mode: SelectionMode) => void;
  setFeeGranter: (granter: string) => void;
  /** True once localStorage has been read, so the UI does not flash defaults. */
  ready: boolean;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  // localStorage is not available during SSR, so settings load after mount.
  useEffect(() => {
    setSettings(loadSettings());
    setReady(true);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const setChainId = useCallback(
    (chainId: ChainId) => {
      resetResolvedEndpoints();
      update({ chainId });
    },
    [update],
  );

  const setEndpointOverride = useCallback(
    (kind: "lcd" | "rpc", chainId: ChainId, url: string) => {
      resetResolvedEndpoints();
      setSettings((current) => {
        const key = kind === "lcd" ? "lcdOverride" : "rpcOverride";
        const next: Settings = { ...current, [key]: { ...current[key], [chainId]: url } };
        saveSettings(next);
        return next;
      });
    },
    [],
  );

  // Reflect the theme on <html> so CSS can switch tokens.
  useEffect(() => {
    if (!ready) return;
    const root = document.documentElement;
    if (settings.theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", settings.theme);
    }
  }, [settings.theme, ready]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      ...settings,
      chain: CHAINS[settings.chainId],
      activeLcdOverride: settings.lcdOverride[settings.chainId] ?? "",
      activeRpcOverride: settings.rpcOverride[settings.chainId] ?? "",
      setChainId,
      setTheme: (theme) => update({ theme }),
      setEndpointOverride,
      setFeeMode: (feeMode) => update({ feeMode }),
      setFeeGranter: (feeGranter) => update({ feeGranter }),
      ready,
    }),
    [settings, setChainId, setEndpointOverride, update, ready],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used inside a SettingsProvider");
  return context;
}
