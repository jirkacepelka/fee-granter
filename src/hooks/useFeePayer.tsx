"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { useReceivedGrants } from "@/hooks/useReceivedGrants";
import { useSettings } from "@/hooks/useSettings";
import { useWallet } from "@/hooks/useWallet";
import { GAS_PRICE_USCRT } from "@/lib/chains";
import { estimateFee, selectFeeGrant, type FeeGrant, type Selection } from "@/lib/feegrant-sdk";

/** Message type URLs, so a grant restricted to certain messages is respected. */
export const MSG_SEND = "/cosmos.bank.v1beta1.MsgSend";
export const MSG_GRANT_ALLOWANCE = "/cosmos.feegrant.v1beta1.MsgGrantAllowance";
export const MSG_REVOKE_ALLOWANCE = "/cosmos.feegrant.v1beta1.MsgRevokeAllowance";

interface FeePayerContextValue {
  /** Grants the connected wallet may spend against. */
  grants: FeeGrant[];
  /** Resolve who pays for a transaction with this gas limit and messages. */
  resolve: (gasLimit: number, msgTypeUrls: string[]) => Selection;
  /** Just the granter address, for passing straight into a tx option. */
  granterFor: (gasLimit: number, msgTypeUrls: string[]) => string | undefined;
  refresh: () => Promise<void>;
}

const FeePayerContext = createContext<FeePayerContextValue | undefined>(undefined);

/**
 * Applies the fee preference from Settings to every transaction the app sends,
 * rather than each screen deciding for itself.
 */
export function FeePayerProvider({ children }: { children: ReactNode }) {
  const { address } = useWallet();
  const { feeMode, feeGranter } = useSettings();
  const { grants, refresh } = useReceivedGrants(address);

  const resolve = useCallback(
    (gasLimit: number, msgTypeUrls: string[]) =>
      selectFeeGrant(grants, {
        mode: feeMode,
        granter: feeGranter || undefined,
        fee: estimateFee(gasLimit, GAS_PRICE_USCRT),
        msgTypeUrls,
      }),
    [grants, feeMode, feeGranter],
  );

  const value = useMemo<FeePayerContextValue>(
    () => ({
      grants,
      resolve,
      granterFor: (gasLimit, msgTypeUrls) => resolve(gasLimit, msgTypeUrls).granter,
      refresh,
    }),
    [grants, resolve, refresh],
  );

  return <FeePayerContext.Provider value={value}>{children}</FeePayerContext.Provider>;
}

export function useFeePayer(): FeePayerContextValue {
  const context = useContext(FeePayerContext);
  if (!context) throw new Error("useFeePayer must be used inside a FeePayerProvider");
  return context;
}
