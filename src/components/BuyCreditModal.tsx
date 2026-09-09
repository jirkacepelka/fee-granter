"use client";

import { CircleAlert, Fuel, KeyRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { SecretNetworkClient } from "secretjs";

import { DECIMALS, DISPLAY_DENOM, type SwapTokenConfig, type TokenConfig } from "@/lib/chains";
import type { VaultStatus } from "@/lib/gasVault";
import { formatAmount, toMicroUnits, isValidAddress, truncateAddress } from "@/lib/format";
import {
  NoViewingKeyError,
  isSwapToken,
  payableTokens,
  queryBalance,
  suggestToken,
  viewingKeyFor,
} from "@/lib/snip20";
import { DEFAULT_SLIPPAGE, quoteSwap, type Quote } from "@/lib/swapQuote";

import { Button } from "./Button";
import styles from "./BuyCreditModal.module.css";
import { Modal } from "./Modal";

/** What the dashboard is asked to execute. */
export interface BuyRequest {
  grantee: string;
  amount: string;
  /** Absent means paying the vault directly in native SCRT, as before. */
  token?: TokenConfig;
  /** Only ever set for a token that has to be swapped. */
  minOut?: bigint;
}

interface BuyCreditModalProps {
  open: boolean;
  vaultAddress: string;
  /** Empty when no executor is deployed; the picker then does not appear. */
  executorAddress: string;
  chainId: string;
  client?: SecretNetworkClient;
  sscrt?: TokenConfig;
  swapTokens: SwapTokenConfig[];
  status?: VaultStatus;
  /** Native SCRT held by the connected wallet, in base units. */
  nativeBalance?: string;
  selfAddress?: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (request: BuyRequest) => Promise<void>;
}

const AMOUNT_PATTERN = /^\d*(\.\d*)?$/;
const SLIPPAGE_CHOICES = [0.005, 0.01, 0.03];

/** `undefined` is native SCRT, which needs no contract of its own. */
type Selection = TokenConfig | undefined;

function keyOf(token: Selection): string {
  return token?.address ?? "native";
}

function symbolOf(token: Selection): string {
  return token?.symbol ?? DISPLAY_DENOM;
}

export function BuyCreditModal({
  open,
  vaultAddress,
  executorAddress,
  chainId,
  client,
  sscrt,
  swapTokens,
  status,
  nativeBalance,
  selfAddress,
  submitting,
  onClose,
  onSubmit,
}: BuyCreditModalProps) {
  const [grantee, setGrantee] = useState("");
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [selected, setSelected] = useState<Selection>(undefined);
  const [slippage, setSlippage] = useState(DEFAULT_SLIPPAGE);

  // Three-valued on purpose: absent means "not read", which is not zero. A
  // wallet with no viewing key must not be told it holds nothing.
  const [balances, setBalances] = useState<Record<string, string | undefined>>({});
  const [needsKey, setNeedsKey] = useState<Record<string, boolean>>({});

  const [quote, setQuote] = useState<Quote>();
  const [quoteError, setQuoteError] = useState<string>();
  const [quoting, setQuoting] = useState(false);

  // Only offered when an executor is deployed to route them through.
  const tokens = useMemo(
    () => (executorAddress ? payableTokens(sscrt, swapTokens) : []),
    [executorAddress, sscrt, swapTokens],
  );
  const choices: Selection[] = useMemo(() => [undefined, ...tokens], [tokens]);

  useEffect(() => {
    if (open) {
      setGrantee("");
      setAmount("");
      setTouched(false);
      setSelected(undefined);
      setQuote(undefined);
      setQuoteError(undefined);
      setSlippage(DEFAULT_SLIPPAGE);
    }
  }, [open]);

  const loadBalance = useCallback(
    async (token: TokenConfig) => {
      if (!client || !selfAddress) return;
      try {
        const key = await viewingKeyFor(chainId, token.address);
        const held = await queryBalance(client, token, selfAddress, key);
        setBalances((current) => ({ ...current, [token.address]: held }));
        setNeedsKey((current) => ({ ...current, [token.address]: false }));
      } catch (caught) {
        setBalances((current) => ({ ...current, [token.address]: undefined }));
        setNeedsKey((current) => ({
          ...current,
          [token.address]: caught instanceof NoViewingKeyError,
        }));
      }
    },
    [client, selfAddress, chainId],
  );

  useEffect(() => {
    if (!open) return;
    for (const token of tokens) void loadBalance(token);
  }, [open, tokens, loadBalance]);

  const addToken = useCallback(
    async (token: TokenConfig) => {
      try {
        await suggestToken(chainId, token.address);
        await loadBalance(token);
      } catch {
        // Keplr was dismissed, or cannot add tokens. The prompt stays up.
      }
    },
    [chainId, loadBalance],
  );

  // Quote whenever the size or the route could change the answer. Only a
  // swapped token needs one; sSCRT redeems one for one.
  const swapToken = selected && isSwapToken(selected) ? selected : undefined;
  const validAmount = AMOUNT_PATTERN.test(amount.trim()) && Number(amount.trim()) > 0;

  useEffect(() => {
    if (!open || !client || !swapToken || !validAmount) {
      setQuote(undefined);
      setQuoteError(undefined);
      return;
    }

    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      void quoteSwap(client, swapToken, toMicroUnits(amount.trim(), swapToken.decimals), slippage)
        .then((next) => {
          if (cancelled) return;
          setQuote(next);
          setQuoteError(undefined);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setQuote(undefined);
          setQuoteError(caught instanceof Error ? caught.message : String(caught));
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setQuoting(false);
    };
  }, [open, client, swapToken, amount, slippage, validAmount]);

  const errors = useMemo(() => {
    const result: { grantee?: string; amount?: string } = {};

    if (!grantee.trim()) result.grantee = "Enter the address that should get the credit.";
    else if (!isValidAddress(grantee))
      result.grantee = "That is not a valid Secret Network address.";

    const value = amount.trim();
    const decimals = selected?.decimals ?? DECIMALS;
    if (!value) result.amount = "Enter how much to pay in.";
    else if (!AMOUNT_PATTERN.test(value) || Number(value) <= 0)
      result.amount = "Enter an amount greater than zero.";
    else if ((value.split(".")[1] ?? "").length > decimals)
      result.amount = `At most ${decimals} decimal places.`;

    return result;
  }, [grantee, amount, selected]);

  const blockedByQuote = Boolean(swapToken) && (quoting || !quote);
  const hasErrors = Object.keys(errors).length > 0 || Boolean(quoteError) || blockedByQuote;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0 || quoteError || blockedByQuote) return;

    await onSubmit({
      grantee: grantee.trim(),
      amount: amount.trim(),
      token: selected,
      minOut: swapToken ? quote?.minOut : undefined,
    });
  };

  const balanceOf = (token: Selection): string | undefined =>
    token ? balances[token.address] : nativeBalance;

  return (
    <Modal
      open={open}
      title="Buy gas credit"
      description="Pay the vault contract, and it grants that address the same amount as a fee allowance — payable from the contract, not from your wallet."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="success" type="submit" form="buy-credit-form" loading={submitting}>
            Buy credit
          </Button>
        </>
      }
    >
      <form id="buy-credit-form" className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.vault}>
          <Fuel size={15} aria-hidden />
          <div>
            <span className={styles.vaultLabel}>Vault {truncateAddress(vaultAddress, 12, 6)}</span>
            {status ? (
              <span className={styles.vaultMeta}>
                {formatAmount(status.balance)} {DISPLAY_DENOM} held, backing every grant it
                has issued
              </span>
            ) : null}
          </div>
        </div>

        {tokens.length > 0 ? (
          <div className={styles.field}>
            <span className={styles.label}>Pay with</span>
            <div className={styles.tokens} role="radiogroup" aria-label="Token to pay with">
              {choices.map((token) => {
                const held = balanceOf(token);
                const active = keyOf(selected) === keyOf(token);
                return (
                  <button
                    key={keyOf(token)}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? `${styles.token} ${styles.tokenActive}` : styles.token}
                    onClick={() => setSelected(token)}
                  >
                    <span className={styles.tokenSymbol}>{symbolOf(token)}</span>
                    <span className={styles.tokenBalance}>
                      {held === undefined
                        ? // Not "0": we could not read it, which is different.
                          "balance unknown"
                        : `${formatAmount(held)} held`}
                    </span>
                  </button>
                );
              })}
            </div>

            {selected && needsKey[selected.address] ? (
              <button
                type="button"
                className={styles.keyPrompt}
                onClick={() => void addToken(selected)}
              >
                <KeyRound size={14} aria-hidden />
                Add {selected.symbol} in your wallet to see your balance
              </button>
            ) : null}

            <span className={styles.hint}>
              {selected === undefined
                ? "Paid straight to the vault."
                : isSwapToken(selected)
                  ? `Swapped to sSCRT and redeemed, all in one transaction. Nothing is granted unless the whole thing succeeds.`
                  : "Redeemed one-for-one for SCRT, then paid to the vault."}
            </span>
          </div>
        ) : null}

        <label className={styles.field}>
          <span className={styles.labelRow}>
            <span className={styles.label}>Credit for</span>
            {selfAddress ? (
              <button type="button" className={styles.self} onClick={() => setGrantee(selfAddress)}>
                Use my address
              </button>
            ) : null}
          </span>
          <input
            className={styles.input}
            value={grantee}
            onChange={(event) => setGrantee(event.target.value)}
            placeholder="secret1…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={Boolean(touched && errors.grantee)}
          />
          {touched && errors.grantee ? (
            <span className={styles.error} role="alert">
              <CircleAlert size={14} aria-hidden /> {errors.grantee}
            </span>
          ) : null}
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Amount</span>
          <div className={styles.inputWithSuffix}>
            <input
              className={styles.input}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="1.0"
              inputMode="decimal"
              autoComplete="off"
              aria-label={`Amount in ${symbolOf(selected)}`}
              aria-invalid={Boolean(touched && errors.amount)}
            />
            <span className={styles.suffix}>{symbolOf(selected)}</span>
          </div>
          <span className={styles.hint}>
            {swapToken
              ? "Buying again for the same address raises its allowance to the new total."
              : "Granted one-to-one with what you pay. Buying again for the same address raises its allowance to the new total."}
          </span>
          {touched && errors.amount ? (
            <span className={styles.error} role="alert">
              <CircleAlert size={14} aria-hidden /> {errors.amount}
            </span>
          ) : null}
        </label>

        {swapToken ? (
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <span className={styles.label}>Slippage</span>
              <span className={styles.hint}>
                {quoting
                  ? "Pricing…"
                  : quote
                    ? `≈ ${formatAmount(quote.expected.toString())} ${DISPLAY_DENOM} of credit, at least ${formatAmount(quote.minOut.toString())}`
                    : "Enter an amount to price the swap."}
              </span>
            </span>
            <div className={styles.tokens} role="radiogroup" aria-label="Slippage tolerance">
              {SLIPPAGE_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={slippage === choice}
                  className={
                    slippage === choice ? `${styles.token} ${styles.tokenActive}` : styles.token
                  }
                  onClick={() => setSlippage(choice)}
                >
                  <span className={styles.tokenSymbol}>{(choice * 100).toFixed(choice < 0.01 ? 1 : 0)}%</span>
                </button>
              ))}
            </div>
            <span className={styles.hint}>
              The contract refuses the whole transaction if the swap returns less than the
              minimum, so a bad price costs you the fee and nothing else. stkd-SCRT is a
              staking derivative, so this is priced from the pool, not from parity with SCRT.
            </span>
            {quoteError ? (
              <span className={styles.error} role="alert">
                <CircleAlert size={14} aria-hidden /> {quoteError}
              </span>
            ) : null}
          </div>
        ) : null}

        {touched && hasErrors && !errors.grantee && !errors.amount && !quoteError ? (
          <span className={styles.hint}>Waiting for a price before this can be signed.</span>
        ) : null}
      </form>
    </Modal>
  );
}
