"use client";

import { Ban, Info, Plus, RefreshCw, TriangleAlert, Wallet } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { TxResponse } from "secretjs";

import { useGrants } from "@/hooks/useGrants";
import { useWallet } from "@/hooks/useWallet";
import { useSettings } from "@/hooks/useSettings";
import { DISPLAY_DENOM } from "@/lib/chains";
import { sendScrt } from "@/lib/bank";
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
import { toMicroUnits } from "@/lib/format";

import { Amount } from "./Amount";
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
  const { chain, dailyCap } = useSettings();
  const { grants, loading, error, source, refresh, retry } = useGrants(address);
  const { notifySuccess, notifyError } = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FeeGrant>();
  const [revoking, setRevoking] = useState<FeeGrant>();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const totals = useMemo(() => summarise(grants), [grants]);
  const periodLabel = formatPeriod(totals.dominantPeriod ?? 86_400);
  const usage = percentUsed(totals.periodUsed, totals.periodTotal);

  /**
   * The self-imposed ceiling, in base units. This is a guard rail in this app
   * only: x/feegrant has no account-wide budget, so it cannot be enforced
   * on-chain and a grant made elsewhere can still exceed it.
   */
  const capMicro = useMemo(() => {
    const raw = dailyCap.trim();
    if (!raw) return undefined;
    try {
      const parsed = BigInt(toMicroUnits(raw));
      return parsed > 0n ? parsed : undefined;
    } catch {
      return undefined;
    }
  }, [dailyCap]);

  const overCap = capMicro !== undefined && totals.periodTotal > capMicro;

  /** Run a transaction, surface the outcome and reload the list. */
  const runTx = useCallback(
    async (action: () => Promise<TxResponse>, successMessage: string) => {
      if (!client || !address) return false;
      setSubmitting(true);
      try {
        const tx = assertTxSuccess(await action());
        notifySuccess(successMessage, tx.transactionHash);
        await refresh();
        return true;
      } catch (caught) {
        notifyError(errorMessage(caught));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [client, address, notifySuccess, notifyError, refresh],
  );

  const handleSubmit = useCallback(
    async (input: GrantInput) => {
      if (!client || !address) return;
      const isEdit = Boolean(editing);

      const ok = await runTx(
        () =>
          isEdit
            ? updateAllowance(client, address, input)
            : grantAllowance(client, address, input),
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
    [client, address, editing, runTx, chain.chainId],
  );

  const handleRevoke = useCallback(async () => {
    if (!client || !address || !revoking) return;
    const grantee = revoking.grantee;

    const ok = await runTx(
      () => revokeAllowance(client, address, grantee),
      `Fee grant for ${truncateAddress(grantee)} revoked.`,
    );

    if (ok) {
      forgetGrantee(chain.chainId, address, grantee);
      setRevoking(undefined);
    }
  }, [client, address, revoking, runTx, chain.chainId]);

  const handleSuspendAll = useCallback(async () => {
    if (!client || !address || grants.length === 0) return;
    const grantees = grants.map((grant) => grant.grantee);

    const ok = await runTx(
      () => revokeAll(client, address, grantees),
      `${pluralize(grantees.length, "fee grant")} revoked.`,
    );

    if (ok) {
      grantees.forEach((grantee) => forgetGrantee(chain.chainId, address, grantee));
      setSuspendOpen(false);
    }
  }, [client, address, grants, runTx, chain.chainId]);

  const handleSend = useCallback(
    async (to: string, amount: string, memo: string) => {
      if (!client || !address) return;
      await runTx(
        () => sendScrt(client, address, to, amount, memo),
        `Sent ${amount} ${DISPLAY_DENOM} to ${truncateAddress(to)}.`,
      );
      await refreshBalance();
    },
    [client, address, runTx, refreshBalance],
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
              {capMicro !== undefined ? (
                <p className={overCap ? styles.cardWarning : styles.cardNote}>
                  {overCap ? <TriangleAlert size={13} aria-hidden /> : null}
                  {overCap ? "Over your " : "Your "}ceiling of{" "}
                  {formatAmount(capMicro.toString())} {DISPLAY_DENOM} / day
                  {overCap ? "" : ` · ${formatAmount((capMicro - totals.periodTotal).toString())} ${DISPLAY_DENOM} left`}
                </p>
              ) : null}
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
        capWarning={
          capMicro !== undefined && overCap
            ? `Your grants already total ${formatAmount(totals.periodTotal.toString())} ${DISPLAY_DENOM} per ${periodLabel}, over your ${formatAmount(capMicro.toString())} ${DISPLAY_DENOM} ceiling. This app cannot stop the chain from honouring them — lower or revoke a grant to get back under it.`
            : undefined
        }
        submitting={submitting}
        onClose={() => {
          setFormOpen(false);
          setEditing(undefined);
        }}
        onSubmit={handleSubmit}
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
