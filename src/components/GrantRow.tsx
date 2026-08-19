"use client";

import { CalendarClock, Check, Copy, Infinity as InfinityIcon, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { DISPLAY_DENOM } from "@/lib/chain";
import type { FeeGrant } from "@/lib/feegrant";
import { formatAmount, formatDate, formatPeriod, truncateAddress } from "@/lib/format";

import { Amount } from "./Amount";
import { Button } from "./Button";
import styles from "./GrantRow.module.css";

interface GrantRowProps {
  grant: FeeGrant;
  busy?: boolean;
  onEdit: (grant: FeeGrant) => void;
  onRevoke: (grant: FeeGrant) => void;
}

/** Build the muted meta line: remaining budget, lifetime cap and expiry. */
function metaParts(grant: FeeGrant): string[] {
  const parts: string[] = [];

  if (grant.kind === "periodic" && grant.periodCanSpend !== undefined) {
    parts.push(
      `${formatAmount(grant.periodCanSpend)} ${DISPLAY_DENOM} left this ${formatPeriod(
        grant.periodSeconds,
      )}`,
    );
  }

  parts.push(
    grant.spendLimit === undefined
      ? "No lifetime cap"
      : `${formatAmount(grant.spendLimit)} ${DISPLAY_DENOM} lifetime cap`,
  );

  const expiry = formatDate(grant.expiration);
  if (expiry) parts.push(`Expires ${expiry}`);

  if (grant.allowedMessages?.length) {
    parts.push(`${grant.allowedMessages.length} allowed message type(s)`);
  }

  return parts;
}

export function GrantRow({ grant, busy = false, onEdit, onRevoke }: GrantRowProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(grant.grantee);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard permissions can block this; the full address is in the title.
    }
  };

  const expired = grant.expiration ? grant.expiration.getTime() < Date.now() : false;

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <button
          className={styles.address}
          onClick={() => void copy()}
          title={grant.grantee}
          aria-label={copied ? "Address copied" : `Copy address ${grant.grantee}`}
        >
          <span>{truncateAddress(grant.grantee)}</span>
          {copied ? (
            <Check size={14} aria-hidden />
          ) : (
            <Copy size={14} className={styles.copyIcon} aria-hidden />
          )}
        </button>
        <p className={styles.meta}>
          {expired ? (
            <span className={styles.expired}>
              <CalendarClock size={13} aria-hidden /> Expired
            </span>
          ) : null}
          {metaParts(grant).join(" · ")}
        </p>
      </div>

      <div className={styles.trailing}>
        {grant.kind === "periodic" ? (
          <Amount micro={grant.periodSpendLimit} per={formatPeriod(grant.periodSeconds)} />
        ) : (
          <div className={styles.basic}>
            {grant.spendLimit === undefined ? (
              <InfinityIcon size={20} aria-label="Unlimited" />
            ) : null}
            <Amount micro={grant.spendLimit} />
          </div>
        )}

        <div className={styles.actions}>
          <Button
            variant="quiet"
            onClick={() => onEdit(grant)}
            disabled={busy}
            aria-label={`Edit fee grant for ${grant.grantee}`}
            icon={<Pencil size={16} aria-hidden />}
          />
          <Button
            variant="quiet"
            onClick={() => onRevoke(grant)}
            disabled={busy}
            aria-label={`Revoke fee grant for ${grant.grantee}`}
            icon={<Trash2 size={16} aria-hidden />}
          />
        </div>
      </div>
    </li>
  );
}
