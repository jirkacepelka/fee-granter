"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchHistory, type HistoryEntry } from "@/lib/history";

interface UseHistoryResult {
  entries: HistoryEntry[];
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
}

/**
 * Load activity for `address`. Only runs when `enabled` is true so the queries
 * fire when the wallet menu is opened rather than on every page load.
 */
export function useHistory(
  lcdUrl: string | undefined,
  address: string | undefined,
  enabled: boolean,
): UseHistoryResult {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!lcdUrl || !address) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await fetchHistory(lcdUrl, address);
      setEntries(result.entries);
      setError(result.error);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [lcdUrl, address]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { entries, loading, error, refresh };
}
