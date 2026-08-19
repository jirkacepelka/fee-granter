"use client";

import { CheckCircle2, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { explorerTxUrl } from "@/lib/chain";

import styles from "./Toast.module.css";

type ToastTone = "success" | "error";

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  txHash?: string;
}

interface ToastContextValue {
  notifySuccess: (message: string, txHash?: string) => void;
  notifyError: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string, txHash?: string) => {
      const id = nextId++;
      setToasts((current) => [...current, { id, tone, message, txHash }]);
      // Errors stay longer - they usually need reading.
      window.setTimeout(() => dismiss(id), tone === "error" ? 9000 : 6000);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      notifySuccess: (message, txHash) => push("success", message, txHash),
      notifyError: (message) => push("error", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.stack} role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`${styles.toast} ${
              toast.tone === "success" ? styles.success : styles.error
            }`}
          >
            {toast.tone === "success" ? (
              <CheckCircle2 size={18} aria-hidden />
            ) : (
              <TriangleAlert size={18} aria-hidden />
            )}
            <div className={styles.content}>
              <p className={styles.message}>{toast.message}</p>
              {toast.txHash ? (
                <a
                  className={styles.link}
                  href={explorerTxUrl(toast.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  View transaction
                </a>
              ) : null}
            </div>
            <button
              className={styles.dismiss}
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside a ToastProvider");
  return context;
}
