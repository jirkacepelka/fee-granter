"use client";

import { Check, ChevronDown } from "lucide-react";

import { useSettings } from "@/hooks/useSettings";
import { CHAINS, CHAIN_IDS } from "@/lib/chains";

import { Dropdown } from "./Dropdown";
import styles from "./NetworkSwitcher.module.css";

export function NetworkSwitcher() {
  const { chainId, setChainId } = useSettings();

  return (
    <Dropdown
      label="Switch network"
      trigger={(open) => (
        <span className={styles.chip}>
          <span className={chainId === "secret-4" ? styles.dotLive : styles.dotTest} />
          {CHAINS[chainId].label}
          <ChevronDown size={14} className={open ? styles.caretOpen : undefined} aria-hidden />
        </span>
      )}
    >
      {(close) => (
        <ul className={styles.list}>
          {CHAIN_IDS.map((id) => {
            const chain = CHAINS[id];
            return (
              <li key={id}>
                <button
                  className={styles.option}
                  onClick={() => {
                    setChainId(id);
                    close();
                  }}
                >
                  <span className={chain.isTestnet ? styles.dotTest : styles.dotLive} />
                  <span className={styles.optionText}>
                    <span className={styles.optionLabel}>{chain.label}</span>
                    <span className={styles.optionMeta}>
                      {chain.isTestnet ? "Testnet" : "Mainnet"} · {chain.chainName}
                    </span>
                  </span>
                  {chainId === id ? <Check size={16} aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dropdown>
  );
}
