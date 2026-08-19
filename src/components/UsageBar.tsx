import styles from "./UsageBar.module.css";

interface UsageBarProps {
  /** 0-100. */
  percent: number;
  label: string;
}

/**
 * Figma 1:50 - a 108x20 pill filled to `percent` with the accent colour over a
 * #121212 track. The design expressed it as a hard-stop gradient; a width-based
 * fill is the same visual and animates cleanly.
 */
export function UsageBar({ percent, label }: UsageBarProps) {
  const clamped = Math.min(100, Math.max(0, percent));

  return (
    <div className={styles.wrapper}>
      <div
        className={styles.track}
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={styles.fill} style={{ width: `${clamped}%` }} />
      </div>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
