"use client";

import { ArrowDownLeft, ArrowUpRight, ExternalLink, Fuel } from "lucide-react";

import { useSettings } from "@/hooks/useSettings";
import { DISPLAY_DENOM, explorerTxUrl } from "@/lib/chains";
import type { HistoryEntry, HistoryKind } from "@/lib/history";
import { formatAmount, truncateAddress } from "@/lib/format";

import styles from "./HistoryList.module.css";

const ICONS: Record<HistoryKind, typeof ArrowDownLeft> = {
  sent: ArrowUpRight,
  received: ArrowDownLeft,
  feegrant: Fuel,
};

const LABELS: Record<HistoryKind, string> = {
  sent: "Sent",
  received: "Received",
  feegrant: "Fee grant used",
};

interface HistoryListProps {
  entries: HistoryEntry[];
  loading: boolean;
  error?: string;
}

function relativeTime(date: Date | undefined): string {
  if (!date) return "";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HistoryList({ entries, loading, error }: HistoryListProps) {
  const { chain } = useSettings();

  if (loading) return <p className={styles.state}>Loading activity…</p>;
  if (error) return <p className={styles.state}>{error}</p>;
  if (entries.length === 0) return <p className={styles.state}>No activity found.</p>;

  return (
    <ul className={styles.list}>
      {entries.map((entry) => {
        const Icon = ICONS[entry.kind];
        return (
          <li key={`${entry.kind}:${entry.hash}`}>
            <a
              className={styles.row}
              href={explorerTxUrl(chain, entry.hash)}
              target="_blank"
              rel="noreferrer"
            >
              <span className={`${styles.icon} ${styles[entry.kind]}`}>
                <Icon size={14} aria-hidden />
              </span>
              <span className={styles.text}>
                <span className={styles.title}>{LABELS[entry.kind]}</span>
                <span className={styles.meta}>
                  {entry.counterparty ? truncateAddress(entry.counterparty, 10, 4) : "—"}
                  {entry.timestamp ? ` · ${relativeTime(entry.timestamp)}` : ""}
                </span>
              </span>
              <span className={styles.amount}>
                {entry.kind === "feegrant"
                  ? entry.fee
                    ? `${formatAmount(entry.fee)} ${DISPLAY_DENOM}`
                    : "fee"
                  : entry.amount
                    ? `${entry.kind === "sent" ? "−" : "+"}${formatAmount(entry.amount)} ${DISPLAY_DENOM}`
                    : "—"}
              </span>
              <ExternalLink size={13} className={styles.link} aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
