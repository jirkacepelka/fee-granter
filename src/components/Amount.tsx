import { DISPLAY_DENOM } from "@/lib/chains";
import { formatAmount } from "@/lib/format";

import styles from "./Amount.module.css";

interface AmountProps {
  /** Base units (uscrt). Omit for an unlimited allowance. */
  micro?: string;
  /** Suffix rendered muted after a slash, e.g. "day". */
  per?: string;
  size?: "lg" | "md";
}

/**
 * Figma 1:18 / 1:41 - value in white, the "/" and period label muted.
 */
export function Amount({ micro, per, size = "md" }: AmountProps) {
  const classes = [styles.amount, size === "lg" ? styles.lg : styles.md].join(" ");

  return (
    <div className={classes}>
      <span className={styles.value}>
        {micro === undefined ? "Unlimited" : `${formatAmount(micro)} ${DISPLAY_DENOM}`}
      </span>
      {per ? (
        <>
          <span className={styles.muted}>/</span>
          <span className={styles.muted}>{per}</span>
        </>
      ) : null}
    </div>
  );
}
