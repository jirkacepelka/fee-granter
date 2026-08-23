"use client";

import { Ban, Fuel, Info, Plus, RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TxResponse } from "secretjs";

import { useGrants } from "@/hooks/useGrants";
import { useWallet } from "@/hooks/useWallet";
import {
  MSG_EXECUTE_CONTRACT,
  MSG_GRANT_ALLOWANCE,
  MSG_REVOKE_ALLOWANCE,
  MSG_SEND,
  useFeePayer,
} from "@/hooks/useFeePayer";
import { useSettings } from "@/hooks/useSettings";
import {
  DISPLAY_DENOM,
  GAS_GRANT,
  GAS_REVOKE,
  GAS_SEND,
} from "@/lib/chains";
import { GAS_BUY } from "@/lib/gasVault";
import { sendScrt } from "@/lib/bank";
import {
  buyGasCredit,
  queryVaultSolvency,
  type VaultSolvency,
} from "@/lib/gasVault";
import {
  grantAllowance,
  revokeAll,
  revokeAllowance,
  summarise,
  updateAllowance,
  type FeeGrant,
  type GrantInput,
} from "@/lib/feegrant";
import {
  formatAmount,
  formatPeriod,
  percentUsed,
  pluralize,
  truncateAddress,
} from "@/lib/format";
import { forgetGrantee, rememberGrantee } from "@/lib/registry";

import { Amount } from "./Amount";
import { BuyCreditModal } from "./BuyCreditModal";
import { Button } from "./Button";
import { Card } from "./Card";
import { ConfirmDialog } from "./ConfirmDialog";
import styles from "./Dashboard.module.css";
import { GrantFormModal } from "./GrantFormModal";
import { GrantRow } from "./GrantRow";
import { UsageBar } from "./UsageBar";
import { useToast } from "./Toast";
import { NetworkSwitcher } from "./NetworkSwitcher";
import { WalletMenu } from "./WalletMenu";

/** secretjs resolves broadcasts even when the chain rejected them. */
function assertTxSuccess(tx: TxResponse): TxResponse {
  if (tx.code !== 0) {
    throw new Error(tx.rawLog || `Transaction failed with code ${tx.code}`);
  }
  return tx;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  return String(caught);
}

export function Dashboard() {
  const { status, address, client, error: walletError, refreshBalance } = useWallet();
  const { chain, gasVaultAddress } = useSettings();
  const { granterFor, refresh: refreshFeeGrants } = useFeePayer();
  const { grants, loading, error, source, refresh, retry } = useGrants(address);
  const { notifySuccess, notifyError } = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FeeGrant>();
  const [revoking, setRevoking] = useState<FeeGrant>();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [vault, setVault] = useState<VaultSolvency>();
  const [submitting, setSubmitting] = useState(false);

  const totals = useMemo(() => summarise(grants), [grants]);
  const periodLabel = formatPeriod(totals.dominantPeriod ?? 86_400);
  const usage = percentUsed(totals.periodUsed, totals.periodTotal);


  /** Run a transaction, surface the outcome and reload the list. */
  const runTx = useCallback(
    async (action: () => Promise<TxResponse>, successMessage: string) => {
      if (!client || !address) return false;
      setSubmitting(true);
      try {
        const tx = assertTxSuccess(await action());
        notifySuccess(successMessage, tx.transactionHash);
        await Promise.all([refresh(), refreshFeeGrants()]);
        return true;
      } catch (caught) {
        notifyError(errorMessage(caught));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [client, address, notifySuccess, notifyError, refresh, refreshFeeGrants],
  );

  const handleSubmit = useCallback(
    async (input: GrantInput) => {
      if (!client || !address) return;
      const isEdit = Boolean(editing);

      const ok = await runTx(
        () =>
          isEdit
            ? updateAllowance(
                client,
                address,
                input,
                granterFor(GAS_GRANT + GAS_REVOKE, [MSG_REVOKE_ALLOWANCE, MSG_GRANT_ALLOWANCE]),
              )
            : grantAllowance(
                client,
                address,
                input,
                granterFor(GAS_GRANT, [MSG_GRANT_ALLOWANCE]),
              ),
        isEdit
          ? `Fee grant for ${truncateAddress(input.grantee)} updated.`
          : `Fee grant for ${truncateAddress(input.grantee)} created.`,
      );

      if (ok) {
        rememberGrantee(chain.chainId, address, input.grantee.trim());
        setFormOpen(false);
        setEditing(undefined);
      }
    },
    [client, address, editing, runTx, chain.chainId, granterFor],
  );

  const handleRevoke = useCallback(async () => {
    if (!client || !address || !revoking) return;
    const grantee = revoking.grantee;

    const ok = await runTx(
      () =>
        revokeAllowance(
          client,
          address,
          grantee,
          granterFor(GAS_REVOKE, [MSG_REVOKE_ALLOWANCE]),
        ),
      `Fee grant for ${truncateAddress(grantee)} revoked.`,
    );

    if (ok) {
      forgetGrantee(chain.chainId, address, grantee);
      setRevoking(undefined);
    }
  }, [client, address, revoking, runTx, chain.chainId, granterFor]);

  const handleSuspendAll = useCallback(async () => {
    if (!client || !address || grants.length === 0) return;
    const grantees = grants.map((grant) => grant.grantee);

    const ok = await runTx(
      () =>
        revokeAll(
          client,
          address,
          grantees,
          granterFor(GAS_REVOKE * grantees.length, [MSG_REVOKE_ALLOWANCE]),
        ),
      `${pluralize(grantees.length, "fee grant")} revoked.`,
    );

    if (ok) {
      grantees.forEach((grantee) => forgetGrantee(chain.chainId, address, grantee));
      setSuspendOpen(false);
    }
  }, [client, address, grants, runTx, chain.chainId, granterFor]);

  const handleSend = useCallback(
    async (to: string, amount: string, memo: string) => {
      if (!client || !address) return;
      await runTx(
        () => sendScrt(client, address, to, amount, memo, granterFor(GAS_SEND, [MSG_SEND])),
        `Sent ${amount} ${DISPLAY_DENOM} to ${truncateAddress(to)}.`,
      );
      await refreshBalance();
    },
    [client, address, runTx, refreshBalance, granterFor],
  );

  const refreshVault = useCallback(async () => {
    if (!client || !gasVaultAddress) {
      setVault(undefined);
      return;
    }
    try {
      setVault(await queryVaultSolvency(client, gasVaultAddress));
    } catch {
      // A vault we cannot read is left blank rather than shown as empty.
      setVault(undefined);
    }
  }, [client, gasVaultAddress]);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  const handleBuyCredit = useCallback(
    async (grantee: string, amount: string) => {
      if (!client || !address || !gasVaultAddress) return;

      const ok = await runTx(
        () =>
          buyGasCredit(
            client,
            gasVaultAddress,
            address,
            grantee,
            amount,
            granterFor(GAS_BUY, [MSG_EXECUTE_CONTRACT]),
          ),
        `${amount} ${DISPLAY_DENOM} of gas credit issued to ${truncateAddress(grantee)}.`,
      );

      if (ok) {
        await refreshVault();
        setBuyOpen(false);
      }
    },
    [client, address, gasVaultAddress, runTx, granterFor, refreshVault],
  );

  const openCreate = () => {
    setEditing(undefined);
    setFormOpen(true);
  };

  const openEdit = (grant: FeeGrant) => {
    setEditing(grant);
    setFormOpen(true);
  };

  if (status !== "connected" || !address) {
    return (
      <main className={styles.page}>
        <div className={styles.connectPanel}>
          <Wallet size={40} aria-hidden className={styles.connectIcon} />
          <h1 className={styles.connectTitle}>Fee grants on Secret Network</h1>
          <p className={styles.connectCopy}>
            Connect your Keplr wallet to see who you are covering transaction fees for on{" "}
            {chain.chainId}, and to create or edit grants.
          </p>
          <WalletMenu onSend={handleSend} sending={submitting} />
          {walletError ? (
            <p className={styles.connectError} role="alert">
              {walletError}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div className={styles.topBar}>
          <NetworkSwitcher />
          <WalletMenu onSend={handleSend} sending={submitting} />
        </div>

        <section className={styles.summary}>
          <h1 className={styles.greeting}>Hi, {truncateAddress(address)}</h1>

          <div className={styles.cards}>
            <Card
              title={`Current max spending`}
              grow
              action={<UsageBar percent={usage} label={`${Math.round(usage)}% used`} />}
            >
              <Amount
                micro={totals.periodTotal.toString()}
                per={periodLabel}
                size="lg"
              />
              {totals.oneshotCount > 0 ? (
                <p className={styles.cardNote}>
                  Plus {pluralize(totals.oneshotCount, "one-time grant")} worth{" "}
                  {formatAmount(totals.oneshotTotal.toString())} {DISPLAY_DENOM}, not counted
                  here — they never recur.
                </p>
              ) : null}
              <Button
                icon={<Ban size={16} aria-hidden />}
                onClick={() => setSuspendOpen(true)}
                disabled={grants.length === 0 || submitting}
              >
                Suspend all
              </Button>
            </Card>

            <Card title="Total fee granted">
              <Amount
                micro={totals.hasUncapped && totals.grantedTotal === 0n
                  ? undefined
                  : totals.grantedTotal.toString()}
                size="lg"
              />
              {totals.hasUncapped && totals.grantedTotal > 0n ? (
                <p className={styles.cardNote}>+ uncapped grants</p>
              ) : null}
            </Card>
          </div>
        </section>

        <section className={styles.listSection}>
          <div className={styles.listHeader}>
            <h2 className={styles.listTitle}>Who you fee grant too:</h2>
            <div className={styles.listActions}>
              <Button
                variant="quiet"
                onClick={() => void refresh()}
                disabled={loading || submitting}
                aria-label="Refresh grants"
                icon={
                  <RefreshCw
                    size={18}
                    aria-hidden
                    className={loading ? styles.spinning : undefined}
                  />
                }
              />
              {gasVaultAddress ? (
                <Button
                  variant="ghost"
                  icon={<Fuel size={16} aria-hidden />}
                  onClick={() => setBuyOpen(true)}
                >
                  Buy gas credit
                </Button>
              ) : null}
              <Button icon={<Plus size={16} aria-hidden />} onClick={openCreate}>
                New fee grant
              </Button>
            </div>
          </div>

          {source === "local" ? (
            <p className={styles.notice}>
              <Info size={14} aria-hidden />
              This node cannot list grants by granter, so only grants created in this browser
              are shown. The amounts themselves come from the chain.
            </p>
          ) : null}

          {error ? (
            <div className={styles.errorPanel}>
              <p>{error}</p>
              <Button variant="ghost" size="sm" onClick={() => void retry()}>
                Try again
              </Button>
            </div>
          ) : null}

          {loading && grants.length === 0 ? (
            <p className={styles.empty}>Loading fee grants…</p>
          ) : null}

          {!loading && !error && grants.length === 0 ? (
            <div className={styles.empty}>
              <p>You are not covering fees for anyone yet.</p>
              <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={openCreate}>
                Create your first fee grant
              </Button>
            </div>
          ) : null}

          {grants.length > 0 ? (
            <ul className={styles.list}>
              {grants.map((grant) => (
                <GrantRow
                  key={grant.grantee}
                  grant={grant}
                  busy={submitting}
                  onEdit={openEdit}
                  onRevoke={setRevoking}
                />
              ))}
            </ul>
          ) : null}
        </section>
      </div>

      <GrantFormModal
        open={formOpen}
        grant={editing}
        submitting={submitting}
        onClose={() => {
          setFormOpen(false);
          setEditing(undefined);
        }}
        onSubmit={handleSubmit}
      />

      <BuyCreditModal
        open={buyOpen}
        vaultAddress={gasVaultAddress}
        solvency={vault}
        selfAddress={address}
        submitting={submitting}
        onClose={() => setBuyOpen(false)}
        onSubmit={handleBuyCredit}
      />

      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revoke fee grant"
        confirmLabel="Revoke grant"
        submitting={submitting}
        onConfirm={() => void handleRevoke()}
        onClose={() => setRevoking(undefined)}
      >
        <strong>{revoking?.grantee}</strong> will stop having its transaction fees covered by
        you. You can grant again at any time.
      </ConfirmDialog>

      <ConfirmDialog
        open={suspendOpen}
        title="Suspend all fee grants"
        confirmLabel={`Revoke ${pluralize(grants.length, "grant")}`}
        submitting={submitting}
        onConfirm={() => void handleSuspendAll()}
        onClose={() => setSuspendOpen(false)}
      >
        This revokes every fee grant you have issued — {pluralize(grants.length, "grant")} in
        total, worth{" "}
        <strong>
          {formatAmount(totals.periodTotal.toString())} {DISPLAY_DENOM}
        </strong>{" "}
        per {periodLabel} — in a single transaction.
      </ConfirmDialog>
    </main>
  );
}
