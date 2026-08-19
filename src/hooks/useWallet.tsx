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

import { useSettings } from "@/hooks/useSettings";
import { queryBalance } from "@/lib/bank";
import { describeNetworkError } from "@/lib/endpoint";
import {
  connectKeplr,
  getKeplr,
  KEPLR_ACCOUNT_CHANGE_EVENT,
  KeplrNotInstalledError,
} from "@/lib/keplr";
import { fetchScrtPrice, type PriceResult } from "@/lib/price";

const AUTOCONNECT_KEY = "fee-granter:autoconnect";

export type WalletStatus = "disconnected" | "connecting" | "connected";

interface WalletContextValue {
  status: WalletStatus;
  address?: string;
  client?: SecretNetworkClient;
  /** The endpoint the connection settled on, reused for direct LCD queries. */
  lcdUrl?: string;
  error?: string;
  keplrInstalled: boolean;
  /** Spendable balance in base units, undefined while loading. */
  balance?: string;
  price: PriceResult;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { chain, activeLcdOverride, activeRpcOverride, ready } = useSettings();

  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [address, setAddress] = useState<string>();
  const [client, setClient] = useState<SecretNetworkClient>();
  const [lcdUrl, setLcdUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [keplrInstalled, setKeplrInstalled] = useState(true);
  const [balance, setBalance] = useState<string>();
  const [price, setPrice] = useState<PriceResult>({ status: "none" });

  const connect = useCallback(async () => {
    setStatus("connecting");
    setError(undefined);
    try {
      const connection = await connectKeplr(chain, activeLcdOverride, activeRpcOverride);
      setAddress(connection.address);
      setClient(connection.client);
      setLcdUrl(connection.lcdUrl);
      setStatus("connected");
      window.localStorage.setItem(AUTOCONNECT_KEY, "1");
    } catch (caught) {
      setStatus("disconnected");
      setAddress(undefined);
      setClient(undefined);
      setLcdUrl(undefined);
      if (caught instanceof KeplrNotInstalledError) {
        setKeplrInstalled(false);
        setError("Keplr is not installed in this browser.");
      } else {
        setError(describeNetworkError(caught));
      }
    }
  }, [chain, activeLcdOverride, activeRpcOverride]);

  const disconnect = useCallback(() => {
    setStatus("disconnected");
    setAddress(undefined);
    setClient(undefined);
    setLcdUrl(undefined);
    setBalance(undefined);
    setError(undefined);
    window.localStorage.removeItem(AUTOCONNECT_KEY);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!client || !address) return;
    try {
      setBalance(await queryBalance(client, address));
    } catch {
      // A balance we cannot read is left undefined rather than shown as zero.
      setBalance(undefined);
    }
  }, [client, address]);

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

  // Restore a previous session, and reconnect whenever the chain changes.
  useEffect(() => {
    if (!ready) return;
    if (window.localStorage.getItem(AUTOCONNECT_KEY) !== "1") return;
    if (!getKeplr()) return;
    void connect();
  }, [connect, ready]);

  useEffect(() => {
    const handler = () => {
      if (window.localStorage.getItem(AUTOCONNECT_KEY) === "1") void connect();
    };
    window.addEventListener(KEPLR_ACCOUNT_CHANGE_EVENT, handler);
    return () => window.removeEventListener(KEPLR_ACCOUNT_CHANGE_EVENT, handler);
  }, [connect]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  // Testnet SCRT has no market, so the price call is skipped there entirely.
  useEffect(() => {
    let cancelled = false;
    void fetchScrtPrice(chain).then((result) => {
      if (!cancelled) setPrice(result);
    });
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      address,
      client,
      lcdUrl,
      error,
      keplrInstalled,
      balance,
      price,
      connect,
      disconnect,
      refreshBalance,
    }),
    [
      status,
      address,
      client,
      lcdUrl,
      error,
      keplrInstalled,
      balance,
      price,
      connect,
      disconnect,
      refreshBalance,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside a WalletProvider");
  return context;
}
