import {
  availableFee, checkUsable, estimateFee, parseFeeGrant, rankFeeGrants, selectFeeGrant,
  type FeeGrant,
} from "../src/lib/feegrant-sdk.ts";

let fail = 0;
const check = (name: string, a: unknown, e: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got ${JSON.stringify(a)}\n        want ${JSON.stringify(e)}`}`);
};

const scrt = (n: number) => (BigInt(n) * 1_000_000n).toString();
const g = (id: string, o: Partial<FeeGrant>): FeeGrant => ({
  granter: id, grantee: "me", kind: "periodic", ...o,
} as FeeGrant);

// The exact scenario from the spec.
const one   = g("g1", { kind: "periodic", periodCanSpend: scrt(12),  periodSeconds: 900 });
const two   = g("g2", { kind: "periodic", periodCanSpend: scrt(5),   periodSeconds: 900 });
const three = g("g3", { kind: "periodic", periodCanSpend: scrt(12),  periodSeconds: 86400 });
const four  = g("g4", { kind: "basic",    spendLimit: scrt(120) });
const five  = g("g5", { kind: "basic",    spendLimit: scrt(10) });

const shuffled = [five, three, one, four, two];
const fee = estimateFee(80_000, 0.1); // 8000 uscrt

check("ranking: recurring > larger remaining > faster period",
  rankFeeGrants(shuffled, { fee }).map((x) => x.granter),
  ["g1", "g3", "g2", "g4", "g5"]);

check("auto picks the top-ranked grant",
  selectFeeGrant(shuffled, { mode: "auto", fee }).granter, "g1");

// --- availability ---
check("periodic available = period_can_spend", availableFee(one)?.toString(), scrt(12));
check("lifetime cap caps the period",
  availableFee(g("gx", { periodCanSpend: scrt(5), spendLimit: scrt(2) }))?.toString(), scrt(2));
check("uncapped basic is unlimited", availableFee(g("gy", { kind: "basic" })), undefined);
check("unlimited outranks any number",
  rankFeeGrants([g("num", { kind:"basic", spendLimit: scrt(999) }), g("inf", { kind:"basic" })], { fee })
    .map((x) => x.granter), ["inf", "num"]);

// --- usability filters ---
const expired = g("exp", { periodCanSpend: scrt(50), expiration: new Date(Date.now() - 1000) });
check("expired is rejected", checkUsable(expired, { fee }), "expired");
check("expired is not ranked", rankFeeGrants([expired, one], { fee }).map(x=>x.granter), ["g1"]);

const tooSmall = g("small", { periodCanSpend: "100" }); // 100 uscrt < 8000 fee
check("insufficient is rejected", checkUsable(tooSmall, { fee }), "insufficient");
check("auto skips insufficient",
  selectFeeGrant([tooSmall, two], { mode: "auto", fee }).granter, "g2");
check("auto reports when nothing fits",
  selectFeeGrant([tooSmall], { mode: "auto", fee }).reason, "no-usable-grant");

const restricted = g("msg", { periodCanSpend: scrt(9), allowedMessages: ["/cosmos.gov.v1beta1.MsgVote"] });
check("message restriction is honoured",
  checkUsable(restricted, { fee, msgTypeUrls: ["/cosmos.bank.v1beta1.MsgSend"] }), "message-not-allowed");
check("message restriction satisfied",
  checkUsable(restricted, { fee, msgTypeUrls: ["/cosmos.gov.v1beta1.MsgVote"] }), undefined);

// --- modes ---
check("select uses the named granter", selectFeeGrant(shuffled, { mode: "select", granter: "g3", fee }).granter, "g3");
check("select rejects an unusable granter",
  selectFeeGrant([expired], { mode: "select", granter: "exp", fee }).rejected, "expired");
check("select with no granter", selectFeeGrant(shuffled, { mode: "select", fee }).reason, "granter-not-given");
check("off pays from the wallet", selectFeeGrant(shuffled, { mode: "off", fee }).granter, undefined);

// A grant is preferred over own funds by default: mode may be omitted, and the
// wallet's balance is never a factor.
check("mode defaults to auto", selectFeeGrant(shuffled, { fee }).granter, "g1");
check("default matches explicit auto",
  selectFeeGrant(shuffled, { fee }).granter,
  selectFeeGrant(shuffled, { mode: "auto", fee }).granter);
check("default falls back to self-paying when nothing fits",
  selectFeeGrant([tooSmall], { fee }).granter, undefined);

// --- parsing straight from LCD proto3 JSON ---
const parsed = parseFeeGrant({ granter: "gA", grantee: "me", allowance: {
  "@type": "/cosmos.feegrant.v1beta1.PeriodicAllowance",
  basic: { spend_limit: [{ denom: "uscrt", amount: scrt(100) }], expiration: "2027-01-01T00:00:00Z" },
  period: "900s",
  period_spend_limit: [{ denom: "uscrt", amount: scrt(12) }],
  period_can_spend: [{ denom: "uscrt", amount: scrt(12) }],
}});
check("parsed kind", parsed?.kind, "periodic");
check("parsed period seconds", parsed?.periodSeconds, 900);
check("parsed available", availableFee(parsed!)?.toString(), scrt(12));

const wrapped = parseFeeGrant({ granter: "gB", grantee: "me", allowance: {
  "@type": "/cosmos.feegrant.v1beta1.AllowedMsgAllowance",
  allowed_messages: ["/cosmos.bank.v1beta1.MsgSend"],
  allowance: { "@type": "/cosmos.feegrant.v1beta1.BasicAllowance", spend_limit: [{ denom: "uscrt", amount: scrt(3) }] },
}});
check("AllowedMsgAllowance unwrapped", wrapped?.kind, "basic");
check("allowed messages kept", wrapped?.allowedMessages, ["/cosmos.bank.v1beta1.MsgSend"]);

check("estimateFee rounds up", estimateFee(80_000, 0.1), "8000");
check("ranking is stable", rankFeeGrants([two, one, three], { fee }).map(x=>x.granter),
                            rankFeeGrants([three, two, one], { fee }).map(x=>x.granter));

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
