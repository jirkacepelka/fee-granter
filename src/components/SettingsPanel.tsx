"use client";

import { ArrowLeft, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { useFeePayer } from "@/hooks/useFeePayer";
import { useSettings } from "@/hooks/useSettings";
import { CHAINS, DISPLAY_DENOM } from "@/lib/chains";
import { availableFee, type FeeGrant, type SelectionMode } from "@/lib/feegrant-sdk";
import { formatAmount, formatPeriod, truncateAddress } from "@/lib/format";
import type { ThemePreference } from "@/lib/settings";

import styles from "./SettingsPanel.module.css";

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

interface SettingsPanelProps {
  onBack: () => void;
}

/** Settings view, rendered inside the wallet popover rather than as a dialog. */
export function SettingsPanel({ onBack }: SettingsPanelProps) {
  const {
    chainId,
    theme,
    lcdOverride,
    rpcOverride,
    feeMode,
    feeGranter,
    setTheme,
    setEndpointOverride,
    setFeeMode,
    setFeeGranter,
  } = useSettings();
  const { grants } = useFeePayer();

  // Endpoint fields are edited locally and committed on blur, so typing a URL
  // does not re-probe on every keystroke.
  const [draftLcd, setDraftLcd] = useState("");
  const [draftRpc, setDraftRpc] = useState("");

  useEffect(() => {
    setDraftLcd(lcdOverride[chainId] ?? "");
    setDraftRpc(rpcOverride[chainId] ?? "");
  }, [chainId, lcdOverride, rpcOverride]);

  const chain = CHAINS[chainId];

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <button className={styles.back} onClick={onBack} aria-label="Back to wallet">
          <ArrowLeft size={16} aria-hidden />
        </button>
        <h3 className={styles.title}>Settings</h3>
      </header>

      <div className={styles.section}>
        <span className={styles.label}>Appearance</span>
        <div className={styles.segmented} role="group" aria-label="Theme">
          {THEMES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`${styles.segment} ${theme === value ? styles.segmentActive : ""}`}
              aria-pressed={theme === value}
              onClick={() => setTheme(value)}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Endpoints for {chain.label}</span>
        <label className={styles.field}>
          <span className={styles.sublabel}>LCD / REST</span>
          <input
            className={styles.input}
            value={draftLcd}
            onChange={(event) => setDraftLcd(event.target.value)}
            onBlur={() => setEndpointOverride("lcd", chainId, draftLcd.trim())}
            placeholder={chain.lcdUrls[0]}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.sublabel}>RPC</span>
          <input
            className={styles.input}
            value={draftRpc}
            onChange={(event) => setDraftRpc(event.target.value)}
            onBlur={() => setEndpointOverride("rpc", chainId, draftRpc.trim())}
            placeholder={chain.rpcUrls[0]}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <span className={styles.hint}>
          Empty uses the built-in list. Comma-separate to add fallbacks.
        </span>
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Transaction fees</span>
        <div className={styles.segmented} role="group" aria-label="Fee payer">
          {FEE_MODES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`${styles.segment} ${feeMode === value ? styles.segmentActive : ""}`}
              aria-pressed={feeMode === value}
              onClick={() => setFeeMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {feeMode === "select" ? (
          <select
            className={styles.select}
            value={feeGranter}
            onChange={(event) => setFeeGranter(event.target.value)}
            aria-label="Fee granter"
          >
            <option value="">Pick a grant…</option>
            {grants.map((grant) => (
              <option key={grant.granter} value={grant.granter}>
                {grantLabel(grant)}
              </option>
            ))}
          </select>
        ) : null}

        <span className={styles.hint}>{FEE_HINTS[feeMode]}</span>
      </div>
    </div>
  );
}

const FEE_MODES: Array<{ value: SelectionMode; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "select", label: "Choose" },
  { value: "off", label: "This wallet" },
];

const FEE_HINTS: Record<SelectionMode, string> = {
  auto: "Uses a fee grant whenever one covers the fee, otherwise this wallet pays.",
  select: "Always uses this grant. This wallet pays when it cannot cover the fee.",
  off: "This wallet always pays its own fees, even when a grant is available.",
};

/** "secret1abc…wxyz — 0.15 SCRT / day" */
function grantLabel(grant: FeeGrant): string {
  const available = availableFee(grant);
  const amount =
    available === undefined
      ? "unlimited"
      : `${formatAmount(available.toString(), 4)} ${DISPLAY_DENOM}`;
  const cadence =
    grant.kind === "periodic" ? ` / ${formatPeriod(grant.periodSeconds)}` : " one-time";
  return `${truncateAddress(grant.granter, 10, 4)} — ${amount}${cadence}`;
}
