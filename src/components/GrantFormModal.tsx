"use client";

import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { DECIMALS, DISPLAY_DENOM } from "@/lib/chain";
import type { FeeGrant, GrantInput } from "@/lib/feegrant";
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

interface GrantFormModalProps {
  open: boolean;
  /** Present when editing; absent when creating. */
  grant?: FeeGrant;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (input: GrantInput) => Promise<void>;
}

interface FormState {
  grantee: string;
  periodLimit: string;
  periodSeconds: number;
  totalLimit: string;
  expiration: string;
}

const EMPTY: FormState = {
  grantee: "",
  periodLimit: "",
  periodSeconds: DEFAULT_PERIOD,
  totalLimit: "",
  expiration: "",
};

function toFormState(grant: FeeGrant | undefined): FormState {
  if (!grant) return EMPTY;
  return {
    grantee: grant.grantee,
    periodLimit: grant.periodSpendLimit ? fromMicroUnits(grant.periodSpendLimit) : "",
    periodSeconds: grant.periodSeconds ?? DEFAULT_PERIOD,
    totalLimit: grant.spendLimit ? fromMicroUnits(grant.spendLimit) : "",
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

  const limit = form.periodLimit.trim();
  if (!limit) {
    errors.periodLimit = "Set how much this address may spend per period.";
  } else if (!AMOUNT_PATTERN.test(limit) || Number(limit) <= 0) {
    errors.periodLimit = "Enter an amount greater than zero.";
  } else if ((limit.split(".")[1] ?? "").length > DECIMALS) {
    errors.periodLimit = `At most ${DECIMALS} decimal places.`;
  }

  const total = form.totalLimit.trim();
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

    await onSubmit({
      grantee: form.grantee.trim(),
      periodLimit: form.periodLimit.trim(),
      periodSeconds: form.periodSeconds,
      totalLimit: form.totalLimit.trim() || undefined,
      expiration: form.expiration ? new Date(`${form.expiration}T23:59:59Z`) : undefined,
    });
  };

  const showError = (key: keyof FormState) => (touched ? errors[key] : undefined);

  return (
    <Modal
      open={open}
      title={isEdit ? "Edit fee grant" : "New fee grant"}
      description={
        isEdit
          ? "Editing replaces the existing grant. The change is revoked and re-granted in a single transaction."
          : "Cover another address's transaction fees on pulsar-3, up to a limit you set per period."
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
          <span className={styles.label}>Spending limit per period</span>
          <div className={styles.split}>
            <div className={styles.inputWithSuffix}>
              <input
                className={styles.input}
                value={form.periodLimit}
                onChange={(event) => update("periodLimit", event.target.value)}
                placeholder="0.15"
                inputMode="decimal"
                autoComplete="off"
                aria-label={`Spending limit in ${DISPLAY_DENOM}`}
                aria-invalid={Boolean(showError("periodLimit"))}
              />
              <span className={styles.suffix}>{DISPLAY_DENOM}</span>
            </div>
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
          </div>
          <FieldError message={showError("periodLimit")} />
        </div>

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
