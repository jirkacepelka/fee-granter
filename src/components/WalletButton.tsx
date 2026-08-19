"use client";

import { Check, Copy, LogOut, Wallet } from "lucide-react";
import { useState } from "react";

import { useWallet } from "@/hooks/useWallet";
import { truncateAddress } from "@/lib/format";

import { Button } from "./Button";
import styles from "./WalletButton.module.css";

export function WalletButton() {
  const { status, address, keplrInstalled, connect, disconnect } = useWallet();
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked by permissions; the address is visible anyway.
    }
  };

  if (!keplrInstalled) {
    return (
      <Button
        variant="ghost"
        icon={<Wallet size={16} aria-hidden />}
        onClick={() => window.open("https://www.keplr.app/get", "_blank", "noreferrer")}
      >
        Install Keplr
      </Button>
    );
  }

  if (status !== "connected" || !address) {
    return (
      <Button
        icon={<Wallet size={16} aria-hidden />}
        loading={status === "connecting"}
        onClick={() => void connect()}
      >
        {status === "connecting" ? "Connecting" : "Connect wallet"}
      </Button>
    );
  }

  return (
    <div className={styles.connected}>
      <button
        className={styles.address}
        onClick={() => void copyAddress()}
        title={address}
        aria-label={copied ? "Address copied" : `Copy address ${address}`}
      >
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        <span>{truncateAddress(address)}</span>
      </button>
      <Button
        variant="quiet"
        onClick={disconnect}
        aria-label="Disconnect wallet"
        icon={<LogOut size={16} aria-hidden />}
      />
    </div>
  );
}
