"use client";

import { ArrowLeft, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { useSettings } from "@/hooks/useSettings";
import { CHAINS, DISPLAY_DENOM } from "@/lib/chains";
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
    dailyCap,
    setTheme,
    setEndpointOverride,
    setDailyCap,
  } = useSettings();

  // Endpoint fields are edited locally and committed on blur, so typing a URL
  // does not re-probe on every keystroke.
  const [draftLcd, setDraftLcd] = useState("");
  const [draftRpc, setDraftRpc] = useState("");
  const [draftCap, setDraftCap] = useState("");

  useEffect(() => {
    setDraftLcd(lcdOverride[chainId] ?? "");
    setDraftRpc(rpcOverride[chainId] ?? "");
    setDraftCap(dailyCap);
  }, [chainId, lcdOverride, rpcOverride, dailyCap]);

  const chain = CHAINS[chainId];
  const capInvalid = draftCap.trim() !== "" && !/^\d*(\.\d*)?$/.test(draftCap.trim());

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
          Leave empty to use the built-in list. Several URLs can be given, comma separated —
          the first that answers for {chain.chainId} is used. Queries go through the LCD; the
          RPC is only handed to Keplr.
        </span>
      </div>

      <div className={styles.section}>
        <span className={styles.label}>Daily spending ceiling</span>
        <div className={styles.inputWithSuffix}>
          <input
            className={styles.input}
            value={draftCap}
            onChange={(event) => setDraftCap(event.target.value)}
            onBlur={() => {
              if (!capInvalid) setDailyCap(draftCap.trim());
            }}
            placeholder="No ceiling"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={capInvalid}
          />
          <span className={styles.suffix}>{DISPLAY_DENOM} / day</span>
        </div>
        <span className={styles.hint}>
          A budget you set for yourself, shown above the figure calculated from your grants.
          This app warns you before a grant would push the daily total over it —{" "}
          <strong>it is not enforced on-chain</strong>, since x/feegrant has no account-wide
          budget, so a grant made elsewhere can still exceed it.
        </span>
      </div>

    </div>
  );
}
