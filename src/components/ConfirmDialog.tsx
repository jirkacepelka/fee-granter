"use client";

import type { ReactNode } from "react";

import { Button } from "./Button";
import styles from "./ConfirmDialog.module.css";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  confirmLabel: string;
  submitting: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  submitting,
  onConfirm,
  onClose,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={submitting}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={styles.body}>{children}</div>
    </Modal>
  );
}
