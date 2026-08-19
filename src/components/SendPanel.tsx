"use client";

import { ArrowLeft, CircleAlert } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { DECIMALS, DISPLAY_DENOM } from "@/lib/chains";
import { GAS_PRICE_USCRT, GAS_SEND } from "@/lib/chains";
import {
  availableFee,
  estimateFee,
  selectFeeGrant,
  type FeeGrant,
  type SelectionMode,
} from "@/lib/feegrant-sdk";
import {
  formatAmount,
  formatPeriod,
  fromMicroUnits,
  isValidAddress,
  toMicroUnits,
  truncateAddress,
} from "@/lib/format";

import { Button } from "./Button";
import styles from "./SendPanel.module.css";

interface SendPanelProps {
  balance?: string;
  /** Grants this wallet may charge the fee to. */
  feeGrants: FeeGrant[];
  submitting: boolean;
  onBack: () => void;
  onSubmit: (
    to: string,
    amount: string,
    memo: string,
    feeGranter?: string,
  ) => Promise<void>;
}

const AMOUNT_PATTERN = /^\d*(\.\d*)?$/;

/** Leave enough behind to pay the fee when sending "max". */
const FEE_HEADROOM_USCRT = 25_000n;

/** Send view, rendered inside the wallet popover rather than as a dialog. */
export function SendPanel({
  balance,
  feeGrants,
  submitting,
  onBack,
  onSubmit,
}: SendPanelProps) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [touched, setTouched] = useState(false);
  const [feeMode, setFeeMode] = useState<SelectionMode>("auto");
  /** Only consulted when feeMode is "select". */
  const [chosenGranter, setChosenGranter] = useState("");

  // What the transaction will actually pay, so a grant is only offered when it
  // can really cover it.
  const fee = estimateFee(GAS_SEND, GAS_PRICE_USCRT);

  const selection = useMemo(
    () =>
      selectFeeGrant(feeGrants, {
        mode: feeMode,
        granter: chosenGranter || undefined,
        fee,
        msgTypeUrls: ["/cosmos.bank.v1beta1.MsgSend"],
      }),
    [feeGrants, feeMode, chosenGranter, fee],
  );

  const errors = useMemo(() => {
    const result: { to?: string; amount?: string } = {};

    if (!to.trim()) result.to = "Enter the address to send to.";
    else if (!isValidAddress(to)) result.to = "That is not a valid Secret Network address.";

    const value = amount.trim();
    if (!value) result.amount = "Enter an amount.";
    else if (!AMOUNT_PATTERN.test(value) || Number(value) <= 0)
      result.amount = "Enter an amount greater than zero.";
    else if ((value.split(".")[1] ?? "").length > DECIMALS)
      result.amount = `At most ${DECIMALS} decimal places.`;
    else if (balance !== undefined) {
      try {
        if (BigInt(toMicroUnits(value)) > BigInt(balance)) {
          result.amount = "That is more than your balance.";
        }
      } catch {
        result.amount = "Enter a valid amount.";
      }
    }

    return result;
  }, [to, amount, balance]);

  const hasErrors = Object.keys(errors).length > 0;

  const setMax = () => {
    if (balance === undefined) return;
    const spendable = BigInt(balance) - FEE_HEADROOM_USCRT;
    setAmount(fromMicroUnits((spendable > 0n ? spendable : 0n).toString()));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    await onSubmit(to.trim(), amount.trim(), memo, selection.granter);
  };

  return (
    <form className={styles.panel} onSubmit={handleSubmit} noValidate>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          onClick={onBack}
          aria-label="Back to wallet"
        >
          <ArrowLeft size={16} aria-hidden />
        </button>
        <h3 className={styles.title}>Send {DISPLAY_DENOM}</h3>
      </header>

      <label className={styles.field}>
        <span className={styles.label}>Recipient</span>
        <input
          className={styles.input}
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="secret1…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={Boolean(touched && errors.to)}
        />
        {touched && errors.to ? (
          <span className={styles.error} role="alert">
            <CircleAlert size={13} aria-hidden /> {errors.to}
          </span>
        ) : null}
      </label>

      <div className={styles.field}>
        <span className={styles.labelRow}>
          <span className={styles.label}>Amount</span>
          {balance !== undefined ? (
            <button type="button" className={styles.max} onClick={setMax}>
              Max: {formatAmount(balance, 4)} {DISPLAY_DENOM}
            </button>
          ) : null}
        </span>
        <div className={styles.inputWithSuffix}>
          <input
            className={styles.input}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.0"
            inputMode="decimal"
            autoComplete="off"
            aria-label={`Amount in ${DISPLAY_DENOM}`}
            aria-invalid={Boolean(touched && errors.amount)}
          />
          <span className={styles.suffix}>{DISPLAY_DENOM}</span>
        </div>
        {touched && errors.amount ? (
          <span className={styles.error} role="alert">
            <CircleAlert size={13} aria-hidden /> {errors.amount}
          </span>
        ) : null}
      </div>

      <label className={styles.field}>
        <span className={styles.label}>
          Memo <span className={styles.optional}>optional</span>
        </span>
        <input
          className={styles.input}
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          placeholder="Public on-chain"
          autoComplete="off"
        />
      </label>

      {feeGrants.length > 0 ? (
        <div className={styles.field}>
          <span className={styles.label}>Fee paid by</span>
          <div className={styles.segmented} role="group" aria-label="Fee payer">
            {(
              [
                ["auto", "Auto"],
                ["select", "Choose"],
                ["off", "This wallet"],
              ] as Array<[SelectionMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`${styles.segment} ${feeMode === mode ? styles.segmentActive : ""}`}
                aria-pressed={feeMode === mode}
                onClick={() => setFeeMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          {feeMode === "select" ? (
            <select
              className={styles.select}
              value={chosenGranter}
              onChange={(event) => setChosenGranter(event.target.value)}
              aria-label="Fee granter"
            >
              <option value="">Pick a grant…</option>
              {feeGrants.map((grant) => (
                <option key={grant.granter} value={grant.granter}>
                  {grantLabel(grant)}
                </option>
              ))}
            </select>
          ) : null}

          <span className={styles.feeNote}>{describeSelection(selection, feeMode)}</span>
        </div>
      ) : null}

      <Button type="submit" loading={submitting} className={styles.submit}>
        Send
      </Button>
    </form>
  );
}

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

/** One line explaining what will actually pay, and why. */
function describeSelection(
  selection: ReturnType<typeof selectFeeGrant>,
  mode: SelectionMode,
): string {
  if (selection.grant) {
    const who = truncateAddress(selection.grant.granter, 10, 4);
    return mode === "auto" ? `Auto-picked ${who}.` : `Paid by ${who}.`;
  }

  switch (selection.reason) {
    case "off":
      return "The fee comes out of this wallet.";
    case "no-usable-grant":
      return "No grant can cover this fee — paying from this wallet.";
    case "granter-not-given":
      return "Pick a grant, or the fee comes from this wallet.";
    case "granter-not-usable":
      return selection.rejected === "expired"
        ? "That grant has expired — paying from this wallet."
        : selection.rejected === "message-not-allowed"
          ? "That grant does not cover transfers — paying from this wallet."
          : "That grant cannot cover this fee — paying from this wallet.";
    default:
      return "The fee comes out of this wallet.";
  }
}
