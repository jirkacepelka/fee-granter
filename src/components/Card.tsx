import type { ReactNode } from "react";

import styles from "./Card.module.css";

interface CardProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  /** Let the card stretch to fill the row instead of hugging its content. */
  grow?: boolean;
}

export function Card({ title, action, children, grow = false }: CardProps) {
  const classes = [styles.card, grow ? styles.grow : styles.hug].join(" ");

  return (
    <section className={classes}>
      <header className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
