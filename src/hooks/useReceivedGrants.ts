"use client";

import { useCallback, useEffect, useState } from "react";

import { useSettings } from "@/hooks/useSettings";
import { resolveLcdUrl } from "@/lib/endpoint";
import {
  queryGrantsByGrantee,
  readonlyClient,
  usableGrants,
  type FeeGrant,
} from "@/lib/feegrant";

/**
 * Grants the connected wallet can spend against, i.e. where it is the grantee
 * rather than the granter.
 */
export function useReceivedGrants(grantee: string | undefined): {
  grants: FeeGrant[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const { chain, activeLcdOverride } = useSettings();
  const [grants, setGrants] = useState<FeeGrant[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!grantee) {
      setGrants([]);
      return;
    }
    setLoading(true);
    try {
      const client = readonlyClient(
        await resolveLcdUrl(chain, activeLcdOverride),
        chain.chainId,
      );
      setGrants(usableGrants(await queryGrantsByGrantee(client, grantee)));
    } catch {
      // Not being able to list them is not worth an error banner - the fee
      // simply falls back to the wallet's own balance.
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, [grantee, chain, activeLcdOverride]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { grants, loading, refresh };
}
