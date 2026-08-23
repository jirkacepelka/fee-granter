"use client";

import { CircleAlert, Fuel } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DECIMALS, DISPLAY_DENOM } from "@/lib/chains";
import type { VaultSolvency } from "@/lib/gasVault";
import { formatAmount, isValidAddress, truncateAddress } from "@/lib/format";

import { Button } from "./Button";
import styles from "./BuyCreditModal.module.css";
import { Modal } from "./Modal";

interface BuyCreditModalProps {
  open: boolean;
  vaultAddress: string;
  solvency?: VaultSolvency;
  /** Pre-fills the grantee, so "top up my own wallet" is one click. */
  selfAddress?: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (grantee: string, amount: string) => Promise<void>;
}

const AMOUNT_PATTERN = /^\d*(\.\d*)?$/;

export function BuyCreditModal({
  open,
  vaultAddress,
  solvency,
  selfAddress,
  submitting,
  onClose,
  onSubmit,
}: BuyCreditModalProps) {
  const [grantee, setGrantee] = useState("");
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setGrantee("");
      setAmount("");
      setTouched(false);
    }
  }, [open]);

  const errors = useMemo(() => {
    const result: { grantee?: string; amount?: string } = {};

    if (!grantee.trim()) result.grantee = "Enter the address that should get the credit.";
    else if (!isValidAddress(grantee))
      result.grantee = "That is not a valid Secret Network address.";

    const value = amount.trim();
    if (!value) result.amount = "Enter how much credit to buy.";
    else if (!AMOUNT_PATTERN.test(value) || Number(value) <= 0)
      result.amount = "Enter an amount greater than zero.";
    else if ((value.split(".")[1] ?? "").length > DECIMALS)
      result.amount = `At most ${DECIMALS} decimal places.`;

    return result;
  }, [grantee, amount]);

  const hasErrors = Object.keys(errors).length > 0;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    await onSubmit(grantee.trim(), amount.trim());
  };

  return (
    <Modal
      open={open}
      title="Buy gas credit"
      description="Pay the vault contract, and it grants that address the same amount as a fee allowance — payable from the contract, not from your wallet."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="buy-credit-form" loading={submitting}>
            Buy credit
          </Button>
        </>
      }
    >
      <form id="buy-credit-form" className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.vault}>
          <Fuel size={15} aria-hidden />
          <div>
            <span className={styles.vaultLabel}>Vault {truncateAddress(vaultAddress, 12, 6)}</span>
            {solvency ? (
              <span className={styles.vaultMeta}>
                {formatAmount(solvency.outstanding)} {DISPLAY_DENOM} outstanding ·{" "}
                {formatAmount(solvency.balance)} {DISPLAY_DENOM} held
              </span>
            ) : null}
          </div>
        </div>

        <label className={styles.field}>
          <span className={styles.labelRow}>
            <span className={styles.label}>Credit for</span>
            {selfAddress ? (
              <button type="button" className={styles.self} onClick={() => setGrantee(selfAddress)}>
                Use my address
              </button>
            ) : null}
          </span>
          <input
            className={styles.input}
            value={grantee}
            onChange={(event) => setGrantee(event.target.value)}
            placeholder="secret1…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(touched && errors.grantee)}
          />
          {touched && errors.grantee ? (
            <span className={styles.error} role="alert">
              <CircleAlert size={14} aria-hidden /> {errors.grantee}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Amount</span>
          <div className={styles.inputWithSuffix}>
            <input
              className={styles.input}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="1.0"
              inputMode="decimal"
              autoComplete="off"
              aria-label={`Amount in ${DISPLAY_DENOM}`}
              aria-invalid={Boolean(touched && errors.amount)}
            />
            <span className={styles.suffix}>{DISPLAY_DENOM}</span>
          </div>
          <span className={styles.hint}>
            Granted one-to-one with what you pay. Buying again for the same address raises its
            allowance to the new total.
          </span>
          {touched && errors.amount ? (
            <span className={styles.error} role="alert">
              <CircleAlert size={14} aria-hidden /> {errors.amount}
            </span>
          ) : null}
        </label>
      </form>
    </Modal>
  );
}
