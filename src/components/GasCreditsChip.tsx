"use client";

import { Fuel } from "lucide-react";

import { useFeePayer } from "@/hooks/useFeePayer";
import { useSettings } from "@/hooks/useSettings";
import { availableFee } from "@/lib/feegrant-sdk";
import { formatAmount } from "@/lib/format";

import styles from "./GasCreditsChip.module.css";

/**
 * What the connected wallet can still draw from the gas-vault contract, if one
 * is deployed on the active chain. Sums every grant issued by the vault rather
 * than assuming there is only one, though the contract only ever keeps one per
 * grantee open (it revokes and re-grants on top-up).
 */
export function GasCreditsChip() {
  const { gasVaultAddress } = useSettings();
  const { grants } = useFeePayer();

  if (!gasVaultAddress) return null;

  const vaultGrants = grants.filter((grant) => grant.granter === gasVaultAddress);
  const uncapped = vaultGrants.some((grant) => availableFee(grant) === undefined);
  const total = vaultGrants.reduce((sum, grant) => sum + (availableFee(grant) ?? 0n), 0n);

  return (
    <span className={styles.chip} title="Gas credit granted by the vault contract">
      <Fuel size={14} aria-hidden />
      {uncapped ? "Uncapped gas credits" : `${formatAmount(total.toString())} gas credits`}
    </span>
  );
}
