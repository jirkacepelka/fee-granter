"use client";

import { ArrowDownToLine, Fuel, LogOut, Send, Settings, Wallet } from "lucide-react";
import { useState } from "react";

import { useHistory } from "@/hooks/useHistory";
import { useFeePayer } from "@/hooks/useFeePayer";
import { useSettings } from "@/hooks/useSettings";
import { useWallet } from "@/hooks/useWallet";
import { DISPLAY_DENOM } from "@/lib/chains";
import { formatAmount, fromMicroUnits, truncateAddress } from "@/lib/format";

import { Button } from "./Button";
import { DepositPanel } from "./DepositPanel";
import { Dropdown } from "./Dropdown";
import { HistoryList } from "./HistoryList";
import { SendPanel } from "./SendPanel";
import { SettingsPanel } from "./SettingsPanel";
import styles from "./WalletMenu.module.css";

/** Which view the popover is showing. Deposit and send stay in place. */
type View = "main" | "deposit" | "send" | "settings";

interface WalletMenuProps {
  /** Opens the send flow; the dashboard owns the transaction so it can refresh. */
  onSend: (to: string, amount: string, memo: string) => Promise<void>;
  sending: boolean;
}

/** Render the fiat value of a balance, or say why there isn't one. */
function fiatLine(
  balance: string | undefined,
  price: ReturnType<typeof useWallet>["price"],
): string {
  if (price.status === "none") return "No price — testnet coin";
  if (price.status === "unavailable") return "Price unavailable";
  if (balance === undefined) return "";
  const value = Number(fromMicroUnits(balance)) * price.usd;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function WalletMenu({ onSend, sending }: WalletMenuProps) {
  const { status, address, lcdUrl, balance, price, keplrInstalled, connect, disconnect } =
    useWallet();
  const { chain } = useSettings();

  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState<View>("main");

  const history = useHistory(lcdUrl, address, menuOpen);
  const { grants: feeGrants } = useFeePayer();

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
      <div className={styles.disconnected}>
        <Button
          icon={<Wallet size={16} aria-hidden />}
          loading={status === "connecting"}
          onClick={() => void connect()}
        >
          {status === "connecting" ? "Connecting" : "Connect wallet"}
        </Button>
        <Dropdown
          label="Settings"
          align="right"
          panelClassName={styles.panel}
          trigger={() => (
            <span className={styles.gear}>
              <Settings size={16} aria-hidden />
            </span>
          )}
        >
          {(close) => <SettingsPanel onBack={close} />}
        </Dropdown>
      </div>
    );
  }

  return (
    <>
      <Dropdown
        label="Wallet menu"
        align="right"
        panelClassName={styles.panel}
        onOpenChange={(open) => {
          setMenuOpen(open);
          // Always reopen on the main view rather than wherever it was left.
          if (!open) setView("main");
        }}
        trigger={(open) => (
          <span className={`${styles.chip} ${open ? styles.chipOpen : ""}`}>
            <Wallet size={16} aria-hidden />
            <span className={styles.chipText}>
              <span className={styles.chipAddress}>{truncateAddress(address, 10, 4)}</span>
              <span className={styles.chipBalance}>
                {balance === undefined
                  ? "—"
                  : `${formatAmount(balance, 2)} ${DISPLAY_DENOM}`}
              </span>
            </span>
          </span>
        )}
      >
        {(close) => {
          if (view === "deposit") {
            return <DepositPanel address={address} onBack={() => setView("main")} />;
          }

          if (view === "settings") {
            return <SettingsPanel onBack={() => setView("main")} />;
          }

          if (view === "send") {
            return (
              <SendPanel
                balance={balance}
                submitting={sending}
                onBack={() => setView("main")}
                onSubmit={async (to, amount, memo) => {
                  await onSend(to, amount, memo);
                  setView("main");
                  close();
                }}
              />
            );
          }

          return (
            <div className={styles.menu}>
              <div className={styles.balanceBlock}>
                <span className={styles.balanceLabel}>{chain.label} balance</span>
                <span className={styles.balanceValue}>
                  {balance === undefined ? "—" : formatAmount(balance)} {DISPLAY_DENOM}
                </span>
                <span
                  className={styles.balanceFiat}
                  title={price.status === "unavailable" ? price.reason : undefined}
                >
                  {fiatLine(balance, price)}
                </span>
              </div>

              <div className={styles.actions}>
                <Button
                  size="sm"
                  icon={<ArrowDownToLine size={15} aria-hidden />}
                  onClick={() => setView("deposit")}
                >
                  Deposit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Send size={15} aria-hidden />}
                  onClick={() => setView("send")}
                >
                  Send
                </Button>
              </div>

              {feeGrants.length > 0 ? (
                <p className={styles.grantNote}>
                  <Fuel size={13} aria-hidden />
                  {feeGrants.length === 1
                    ? "1 fee grant can cover this wallet's fees"
                    : `${feeGrants.length} fee grants can cover this wallet's fees`}
                  . Pick it under Send.
                </p>
              ) : null}

              <div className={styles.historyBlock}>
                <span className={styles.sectionLabel}>Activity</span>
                <HistoryList
                  entries={history.entries}
                  loading={history.loading}
                  error={history.error}
                />
              </div>

              <div className={styles.footer}>
                <button className={styles.footerButton} onClick={() => setView("settings")}>
                  <Settings size={15} aria-hidden /> Settings
                </button>
                <button
                  className={styles.footerButton}
                  onClick={() => {
                    disconnect();
                    close();
                  }}
                >
                  <LogOut size={15} aria-hidden /> Disconnect
                </button>
              </div>
            </div>
          );
        }}
      </Dropdown>

    </>
  );
}
