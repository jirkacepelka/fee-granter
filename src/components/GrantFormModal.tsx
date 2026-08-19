"use client";

import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DECIMALS, DISPLAY_DENOM } from "@/lib/chains";
import type { FeeGrant, GrantInput, GrantKind } from "@/lib/feegrant";
import { fromMicroUnits, isValidAddress } from "@/lib/format";

import { Button } from "./Button";
import styles from "./GrantFormModal.module.css";
import { Modal } from "./Modal";

export const PERIOD_OPTIONS = [
  { label: "hour", seconds: 3_600 },
  { label: "day", seconds: 86_400 },
  { label: "week", seconds: 604_800 },
  { label: "30 days", seconds: 2_592_000 },
];

const DEFAULT_PERIOD = 86_400;

const GRANT_KINDS: Array<{ kind: GrantKind; label: string }> = [
  { kind: "periodic", label: "Recurring" },
  { kind: "oneshot", label: "One-time" },
];

interface GrantFormModalProps {
  open: boolean;
  /** Warning shown above the buttons when the grant would breach the ceiling. */
  capWarning?: string;
  /** Present when editing; absent when creating. */
  grant?: FeeGrant;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: GrantInput) => Promise<void>;
}

interface FormState {
  grantee: string;
  kind: GrantKind;
  amount: string;
  periodSeconds: number;
  totalLimit: string;
  expiration: string;
}

const EMPTY: FormState = {
  grantee: "",
  kind: "periodic",
  amount: "",
  periodSeconds: DEFAULT_PERIOD,
  totalLimit: "",
  expiration: "",
};

function toFormState(grant: FeeGrant | undefined): FormState {
  if (!grant) return EMPTY;

  // A stored BasicAllowance is exactly what this form calls a one-time grant,
  // and its spend limit is the amount still left on it.
  const oneshot = grant.kind === "basic";

  return {
    grantee: grant.grantee,
    kind: oneshot ? "oneshot" : "periodic",
    amount: oneshot
      ? (grant.spendLimit ? fromMicroUnits(grant.spendLimit) : "")
      : (grant.periodSpendLimit ? fromMicroUnits(grant.periodSpendLimit) : ""),
    periodSeconds: grant.periodSeconds ?? DEFAULT_PERIOD,
    totalLimit: !oneshot && grant.spendLimit ? fromMicroUnits(grant.spendLimit) : "",
    expiration: grant.expiration ? grant.expiration.toISOString().slice(0, 10) : "",
  };
}

const AMOUNT_PATTERN = /^\d*(\.\d*)?$/;

function validate(form: FormState, isEdit: boolean): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};

  if (!form.grantee.trim()) {
    errors.grantee = "Enter the address that should have its fees covered.";
  } else if (!isValidAddress(form.grantee)) {
    errors.grantee = "That is not a valid Secret Network address.";
  }

  const limit = form.amount.trim();
  if (!limit) {
    errors.amount =
      form.kind === "oneshot"
        ? "Set how much this one-time grant is worth."
        : "Set how much this address may spend per period.";
  } else if (!AMOUNT_PATTERN.test(limit) || Number(limit) <= 0) {
    errors.amount = "Enter an amount greater than zero.";
  } else if ((limit.split(".")[1] ?? "").length > DECIMALS) {
    errors.amount = `At most ${DECIMALS} decimal places.`;
  }

  // A one-time grant has no period to cap, so the lifetime cap does not apply.
  const total = form.kind === "periodic" ? form.totalLimit.trim() : "";
  if (total) {
    if (!AMOUNT_PATTERN.test(total) || Number(total) <= 0) {
      errors.totalLimit = "Enter an amount greater than zero, or leave it empty.";
    } else if ((total.split(".")[1] ?? "").length > DECIMALS) {
      errors.totalLimit = `At most ${DECIMALS} decimal places.`;
    } else if (limit && Number(total) < Number(limit)) {
      errors.totalLimit = "The lifetime cap cannot be lower than the per-period limit.";
    }
  }

  if (form.expiration) {
    const date = new Date(`${form.expiration}T23:59:59Z`);
    if (Number.isNaN(date.getTime())) {
      errors.expiration = "Enter a valid date.";
    } else if (!isEdit && date.getTime() < Date.now()) {
      errors.expiration = "Pick a date in the future.";
    }
  }

  return errors;
}

export function GrantFormModal({
  open,
  grant,
  capWarning,
  submitting,
  onClose,
  onSubmit,
}: GrantFormModalProps) {
  const isEdit = Boolean(grant);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);

  // Reload the form whenever the dialog opens for a different grant.
  useEffect(() => {
    if (open) {
      setForm(toFormState(grant));
      setTouched(false);
    }
  }, [open, grant]);

  const errors = useMemo(() => validate(form, isEdit), [form, isEdit]);
  const hasErrors = Object.keys(errors).length > 0;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (hasErrors) return;

    const expiration = form.expiration
      ? new Date(`${form.expiration}T23:59:59Z`)
      : undefined;

    await onSubmit(
      form.kind === "oneshot"
        ? { grantee: form.grantee.trim(), kind: "oneshot", amount: form.amount.trim(), expiration }
        : {
            grantee: form.grantee.trim(),
            kind: "periodic",
            amount: form.amount.trim(),
            periodSeconds: form.periodSeconds,
            totalLimit: form.totalLimit.trim() || undefined,
            expiration,
          },
    );
  };

  const showError = (key: keyof FormState) => (touched ? errors[key] : undefined);

  return (
    <Modal
      open={open}
      title={isEdit ? "Edit fee grant" : "New fee grant"}
      description={
        isEdit
          ? "Editing replaces the existing grant. The change is revoked and re-granted in a single transaction."
          : "Cover another address's transaction fees on pulsar-3, up to a limit you set."
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" form="grant-form" loading={submitting}>
            {isEdit ? "Save changes" : "Create fee grant"}
          </Button>
        </>
      }
    >
      <form id="grant-form" className={styles.form} onSubmit={handleSubmit} noValidate>
        {capWarning ? (
          <p className={styles.capWarning}>
            <CircleAlert size={15} aria-hidden />
            {capWarning}
          </p>
        ) : null}

        <div className={styles.field}>
          <span className={styles.label}>Grant type</span>
          <div className={styles.segmented} role="group" aria-label="Grant type">
            {GRANT_KINDS.map((option) => (
              <button
                key={option.kind}
                type="button"
                className={`${styles.segment} ${
                  form.kind === option.kind ? styles.segmentActive : ""
                }`}
                aria-pressed={form.kind === option.kind}
                onClick={() => update("kind", option.kind)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className={styles.hint}>
            {form.kind === "oneshot"
              ? "A fixed budget that never refills. Once spent, the grant is gone."
              : "A budget that refills automatically at the start of every period."}
          </span>
        </div>

        <label className={styles.field}>
          <span className={styles.label}>Grantee address</span>
          <input
            className={styles.input}
            value={form.grantee}
            onChange={(event) => update("grantee", event.target.value)}
            placeholder="secret1…"
            spellCheck={false}
            autoComplete="off"
            readOnly={isEdit}
            aria-invalid={Boolean(showError("grantee"))}
          />
          {isEdit ? (
            <span className={styles.hint}>
              The grantee cannot be changed. Revoke this grant and create a new one instead.
            </span>
          ) : null}
          <FieldError message={showError("grantee")} />
        </label>

        <div className={styles.field}>
          <span className={styles.label}>
            {form.kind === "oneshot" ? "Amount" : "Spending limit per period"}
          </span>
          <div className={styles.split}>
            <div className={styles.inputWithSuffix}>
              <input
                className={styles.input}
                value={form.amount}
                onChange={(event) => update("amount", event.target.value)}
                placeholder={form.kind === "oneshot" ? "0.05" : "0.15"}
                inputMode="decimal"
                autoComplete="off"
                aria-label={`Amount in ${DISPLAY_DENOM}`}
                aria-invalid={Boolean(showError("amount"))}
              />
              <span className={styles.suffix}>{DISPLAY_DENOM}</span>
            </div>
            {form.kind === "periodic" ? (
              <>
                <span className={styles.per}>per</span>
                <select
                  className={styles.select}
                  value={form.periodSeconds}
                  onChange={(event) => update("periodSeconds", Number(event.target.value))}
                  aria-label="Period length"
                >
                  {PERIOD_OPTIONS.map((option) => (
                    <option key={option.seconds} value={option.seconds}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
          {form.kind === "oneshot" ? (
            <span className={styles.hint}>
              Covers fees until this much is spent, then the chain removes the grant. It never
              refills. This caps the amount, not the number of transactions — set it to about
              one transaction&apos;s fee for a genuinely single-use grant.
            </span>
          ) : null}
          <FieldError message={showError("amount")} />
        </div>

        {form.kind === "periodic" ? (
          <label className={styles.field}>
            <span className={styles.label}>
              Lifetime cap <span className={styles.optional}>optional</span>
            </span>
            <div className={styles.inputWithSuffix}>
              <input
                className={styles.input}
                value={form.totalLimit}
                onChange={(event) => update("totalLimit", event.target.value)}
                placeholder="No cap"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={Boolean(showError("totalLimit"))}
              />
              <span className={styles.suffix}>{DISPLAY_DENOM}</span>
            </div>
            <span className={styles.hint}>
              Total this address may ever spend. Leave empty for no overall limit.
            </span>
            <FieldError message={showError("totalLimit")} />
          </label>
        ) : null}

        <label className={styles.field}>
          <span className={styles.label}>
            Expires on <span className={styles.optional}>optional</span>
          </span>
          <input
            className={styles.input}
            type="date"
            value={form.expiration}
            onChange={(event) => update("expiration", event.target.value)}
            aria-invalid={Boolean(showError("expiration"))}
          />
          <FieldError message={showError("expiration")} />
        </label>
      </form>
    </Modal>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span className={styles.error} role="alert">
      <CircleAlert size={14} aria-hidden />
      {message}
    </span>
  );
}
