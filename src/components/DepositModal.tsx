"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import QRCode from "qrcode";

import { useSettings } from "@/hooks/useSettings";

import { Button } from "./Button";
import styles from "./DepositModal.module.css";
import { Modal } from "./Modal";

interface DepositModalProps {
  open: boolean;
  address: string;
  onClose: () => void;
}

export function DepositModal({ open, address, onClose }: DepositModalProps) {
  const { chain } = useSettings();
  const [svg, setSvg] = useState<string>();
  const [copied, setCopied] = useState(false);

  // Rendered as inline SVG so it stays sharp and needs no canvas.
  useEffect(() => {
    if (!open) return;
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
  }, [open, address]);

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
    <Modal
      open={open}
      title="Deposit SCRT"
      description={`Send only SCRT on ${chain.chainId} to this address. Coins sent on another network will be lost.`}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className={styles.body}>
        <div
          className={styles.qr}
          aria-label="QR code of your address"
          role="img"
          dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
        />
        <button className={styles.address} onClick={() => void copy()}>
          <span>{address}</span>
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        </button>
        <span className={styles.hint}>{copied ? "Copied" : "Tap the address to copy"}</span>
      </div>
    </Modal>
  );
}
