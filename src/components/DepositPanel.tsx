"use client";

import { ArrowLeft, Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

import { useSettings } from "@/hooks/useSettings";

import styles from "./DepositPanel.module.css";

interface DepositPanelProps {
  address: string;
  onBack: () => void;
}

/** Deposit view, rendered inside the wallet popover rather than as a dialog. */
export function DepositPanel({ address, onBack }: DepositPanelProps) {
  const { chain } = useSettings();
  const [svg, setSvg] = useState<string>();
  const [copied, setCopied] = useState(false);

  // Rendered as inline SVG so it stays sharp and needs no canvas.
  useEffect(() => {
    let cancelled = false;
    void QRCode.toString(address, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    }).then((result) => {
      if (!cancelled) setSvg(result);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the address is on screen anyway.
    }
  };

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <button className={styles.back} onClick={onBack} aria-label="Back to wallet">
          <ArrowLeft size={16} aria-hidden />
        </button>
        <h3 className={styles.title}>Deposit SCRT</h3>
      </header>

      <div
        className={styles.qr}
        role="img"
        aria-label="QR code of your address"
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />

      <button className={styles.address} onClick={() => void copy()}>
        <span>{address}</span>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>

      <p className={styles.warning}>
        Send only SCRT on <strong>{chain.chainId}</strong>. Coins sent on another network will
        be lost.
      </p>
    </div>
  );
}
