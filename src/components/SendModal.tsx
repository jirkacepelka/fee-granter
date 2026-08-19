"use client";

import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DECIMALS, DISPLAY_DENOM } from "@/lib/chains";
import { formatAmount, fromMicroUnits, isValidAddress, toMicroUnits } from "@/lib/format";

import { Button } from "./Button";
import { Modal } from "./Modal";
import styles from "./SendModal.module.css";

interface SendModalProps {
  open: boolean;
  balance?: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (to: string, amount: string, memo: string) => Promise<void>;
}

const AMOUNT_PATTERN = /^\d*(\.\d*)?$/;

/** Leave enough behind to pay the fee when sending "max". */
const FEE_HEADROOM_USCRT = 25_000n;

export function SendModal({ open, balance, submitting, onClose, onSubmit }: SendModalProps) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setTo("");
      setAmount("");
      setMemo("");
      setTouched(false);
    }
  }, [open]);

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
    await onSubmit(to.trim(), amount.trim(), memo);
  };

  return (
    <Modal
      open={open}
      title={`Send ${DISPLAY_DENOM}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="send-form" loading={submitting}>
            Send
          </Button>
        </>
      }
    >
      <form id="send-form" className={styles.form} onSubmit={handleSubmit} noValidate>
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
              <CircleAlert size={14} aria-hidden /> {errors.to}
            </span>
          ) : null}
        </label>

        <div className={styles.field}>
          <span className={styles.labelRow}>
            <span className={styles.label}>Amount</span>
            {balance !== undefined ? (
              <button type="button" className={styles.max} onClick={setMax}>
                Max: {formatAmount(balance)} {DISPLAY_DENOM}
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
              <CircleAlert size={14} aria-hidden /> {errors.amount}
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
            placeholder="Visible on-chain to everyone"
            autoComplete="off"
          />
        </label>
      </form>
    </Modal>
  );
}
