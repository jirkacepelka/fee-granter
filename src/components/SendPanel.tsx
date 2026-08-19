"use client";

import { ArrowLeft, CircleAlert } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { DECIMALS, DISPLAY_DENOM } from "@/lib/chains";
import { availableNow, type FeeGrant } from "@/lib/feegrant";
import { formatAmount, fromMicroUnits, isValidAddress, truncateAddress, toMicroUnits } from "@/lib/format";

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
  /** "" means pay the fee from this wallet's own balance. */
  const [feeGranter, setFeeGranter] = useState("");

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
    await onSubmit(to.trim(), amount.trim(), memo, feeGranter || undefined);
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
        <label className={styles.field}>
          <span className={styles.label}>Fee paid by</span>
          <select
            className={styles.select}
            value={feeGranter}
            onChange={(event) => setFeeGranter(event.target.value)}
          >
            <option value="">This wallet</option>
            {feeGrants.map((grant) => {
              const available = availableNow(grant);
              return (
                <option key={grant.granter} value={grant.granter}>
                  {truncateAddress(grant.granter, 10, 4)} —{" "}
                  {available === undefined
                    ? "unlimited"
                    : `${formatAmount(available, 4)} ${DISPLAY_DENOM}`}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}

      <Button type="submit" loading={submitting} className={styles.submit}>
        Send
      </Button>
    </form>
  );
}
