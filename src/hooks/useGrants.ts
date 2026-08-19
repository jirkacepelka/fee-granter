"use client";

import { useCallback, useEffect, useState } from "react";

import { useSettings } from "@/hooks/useSettings";
import {
  describeNetworkError,
  resetResolvedEndpoints,
  resolveLcdUrl,
} from "@/lib/endpoint";
import {
  GranterQueryUnsupported,
  queryGrant,
  queryGrantsByGranter,
  readonlyClient,
  type FeeGrant,
} from "@/lib/feegrant";
import { listKnownGrantees, syncKnownGrantees } from "@/lib/registry";

/**
 * How the grant list was obtained.
 * - `chain`: enumerated straight from the node via AllowancesByGranter.
 * - `local`: the node lacks that endpoint, so locally remembered grantees were
 *   verified one by one. Grants made from another browser will not appear.
 */
export type GrantSource = "chain" | "local";

interface UseGrantsResult {
  grants: FeeGrant[];
  loading: boolean;
  error?: string;
  source: GrantSource;
  refresh: () => Promise<void>;
  /** Re-probe the endpoint list before reloading. Use after a network error. */
  retry: () => Promise<void>;
}

export function useGrants(granter: string | undefined): UseGrantsResult {
  const { chain, activeLcdOverride } = useSettings();

  const [grants, setGrants] = useState<FeeGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [source, setSource] = useState<GrantSource>("chain");

  const refresh = useCallback(async () => {
    if (!granter) {
      setGrants([]);
      return;
    }

    setLoading(true);
    setError(undefined);

    let client;
    try {
      client = readonlyClient(await resolveLcdUrl(chain, activeLcdOverride), chain.chainId);
    } catch (caught) {
      setError(describeNetworkError(caught));
      setLoading(false);
      return;
    }

    try {
      const fromChain = await queryGrantsByGranter(client, granter);
      setGrants(fromChain);
      setSource("chain");
      syncKnownGrantees(
        chain.chainId,
        granter,
        fromChain.map((grant) => grant.grantee),
      );
    } catch (caught) {
      if (!(caught instanceof GranterQueryUnsupported)) {
        setError(describeNetworkError(caught));
        setLoading(false);
        return;
      }

      // Fall back to checking each grantee we have a local record of.
      try {
        const known = listKnownGrantees(chain.chainId, granter);
        const results = await Promise.all(
          known.map((grantee) => queryGrant(client, granter, grantee)),
        );
        setGrants(results.filter((grant): grant is FeeGrant => grant !== undefined));
        setSource("local");
      } catch (fallbackError) {
        setError(describeNetworkError(fallbackError));
      }
    } finally {
      setLoading(false);
    }
  }, [granter, chain, activeLcdOverride]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const retry = useCallback(async () => {
    resetResolvedEndpoints();
    await refresh();
  }, [refresh]);

  return { grants, loading, error, source, refresh, retry };
}
