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
import type { SecretNetworkClient } from "secretjs";

import { describeNetworkError } from "@/lib/endpoint";
import {
  connectKeplr,
  getKeplr,
  KEPLR_ACCOUNT_CHANGE_EVENT,
  KeplrNotInstalledError,
} from "@/lib/keplr";

const AUTOCONNECT_KEY = "fee-granter:autoconnect";

export type WalletStatus = "disconnected" | "connecting" | "connected";

interface WalletContextValue {
  status: WalletStatus;
  address?: string;
  client?: SecretNetworkClient;
  error?: string;
  keplrInstalled: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<string>();
  const [client, setClient] = useState<SecretNetworkClient>();
  const [error, setError] = useState<string>();
  const [keplrInstalled, setKeplrInstalled] = useState(true);

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(undefined);
    try {
      const connection = await connectKeplr();
      setAddress(connection.address);
      setClient(connection.client);
      setStatus("connected");
      window.localStorage.setItem(AUTOCONNECT_KEY, "1");
    } catch (caught) {
      setStatus("disconnected");
      setAddress(undefined);
      setClient(undefined);
      if (caught instanceof KeplrNotInstalledError) {
        setKeplrInstalled(false);
        setError("Keplr is not installed in this browser.");
      } else {
        setError(describeNetworkError(caught));
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    setStatus("disconnected");
    setAddress(undefined);
    setClient(undefined);
    setError(undefined);
    window.localStorage.removeItem(AUTOCONNECT_KEY);
  }, []);

  // Keplr injects asynchronously, so a missing object on first paint is not
  // proof it is absent. Re-check once the page has loaded.
  useEffect(() => {
    const check = () => setKeplrInstalled(Boolean(getKeplr()));
    if (document.readyState === "complete") {
      check();
      return;
    }
    window.addEventListener("load", check);
    return () => window.removeEventListener("load", check);
  }, []);

  // Restore a previous session without prompting again.
  useEffect(() => {
    if (window.localStorage.getItem(AUTOCONNECT_KEY) !== "1") return;
    if (!getKeplr()) return;
    void connect();
  }, [connect]);

  // Follow account switches inside the extension.
  useEffect(() => {
    const handler = () => {
      if (window.localStorage.getItem(AUTOCONNECT_KEY) === "1") void connect();
    };
    window.addEventListener(KEPLR_ACCOUNT_CHANGE_EVENT, handler);
    return () => window.removeEventListener(KEPLR_ACCOUNT_CHANGE_EVENT, handler);
  }, [connect]);

  const value = useMemo<WalletContextValue>(
    () => ({ status, address, client, error, keplrInstalled, connect, disconnect }),
    [status, address, client, error, keplrInstalled, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside a WalletProvider");
  return context;
}
