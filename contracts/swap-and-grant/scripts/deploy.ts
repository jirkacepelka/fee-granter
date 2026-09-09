/**
 * Deploy swap-and-grant: upload, instantiate, and print what to put in the app.
 *
 *   GAS_VAULT=secret1... MNEMONIC="..." \
 *     node --experimental-strip-types contracts/swap-and-grant/scripts/deploy.ts
 *
 * secret-4 only in practice. ShadeSwap has no pulsar-3 deployment, so a testnet
 * executor could accept sSCRT at most — pulsar-3 is still accepted here so the
 * sSCRT path can be rehearsed if a testnet sSCRT is to hand.
 *
 *   CHAIN=secret-4 CONFIRM=secret-4 GAS_VAULT=secret1... MNEMONIC="..." \
 *     node --experimental-strip-types contracts/swap-and-grant/scripts/deploy.ts
 *
 * Optional, and the reason this script exists in this shape:
 *
 *   ROUTER=secret1...   the ShadeSwap router, to enable the stkd-SCRT path
 *   PAIR=secret1...     the sSCRT/stkd-SCRT pair; or set FACTORY to find it
 *   FACTORY=secret1...  enumerate the factory's pairs instead of naming one
 *   VERIFY=100000       buy this much credit with stkd-SCRT and check the grant
 *
 * Every code hash below is READ OFF THE CHAIN, never taken on trust. A contract
 * call is encrypted against the code hash, so a wrong one does not degrade — it
 * stops the call dead — and none of these could be confirmed from a second
 * source when this was written. The pair is checked to actually hold sSCRT and
 * stkd-SCRT rather than being believed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { SecretNetworkClient, Wallet, type TxResponse } from "secretjs";

const DENOM = "uscrt";

const CHAINS = {
  "pulsar-3": { lcd: "https://pulsar.lcd.secretnodes.com", testnet: true },
  "secret-4": { lcd: "https://lcd-secret.keplr.app", testnet: false },
} as const;

type ChainId = keyof typeof CHAINS;

/**
 * secret-4 tokens. Address and code hash agree across the Secret Foundation
 * registry and scrtlabs/wrap.scrt.network, and the stkd-SCRT address was also
 * decoded out of a real swap transaction. Both are re-checked against the chain
 * below anyway.
 */
const MAINNET_TOKENS = {
  sscrt: {
    address: "secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek",
    code_hash: "af74387e276be8874f07bec3a87023ee49b0e7ebe08178c49d0a49c3c98ed60e",
  },
  stkd: {
    address: "secret1k6u0cy4feepm6pehnz804zmwakuwdapm69tuc4",
    code_hash: "f6be719b3c6feb498d3554ca0398eb6b7e7db262acb33f84a8f12106da6bbb09",
  },
} as const;

const FEES_HEADROOM = 2_000_000n;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BUILD_HINT =
  `  cd ${ROOT}\n` +
  '  docker run --rm -v "$PWD":/contract -w /contract \\\n' +
  "    ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13\n" +
  "\n  PowerShell:\n" +
  '  $img = "ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13"\n' +
  '  docker run --rm -v "${PWD}:/contract" -w /contract $img';

function chainId(): ChainId {
  const value = process.env.CHAIN ?? "secret-4";
  if (!(value in CHAINS)) {
    throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}, got ${value}`);
  }
  return value as ChainId;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Whatever the optimizer left behind, wherever this version puts it. */
function findOptimized(): string | undefined {
  const flat = resolve(ROOT, "contract.wasm.gz");
  if (existsSync(flat)) return flat;

  const dir = resolve(ROOT, "optimized-wasm");
  if (!existsSync(dir)) return undefined;

  const names = readdirSync(dir);
  const best =
    names.find((name) => name.endsWith(".wasm.gz")) ?? names.find((name) => name.endsWith(".wasm"));
  return best ? resolve(dir, best) : undefined;
}

/**
 * Only the optimizer's output is uploadable: a host `cargo build` with Rust
 * 1.82+ emits the reference-types and multivalue proposals and the chain
 * refuses to deserialize the result. Refusing here means the error names the
 * build step rather than looking like a chain fault, and costs no gas.
 */
function wasmPath(): string {
  const optimized = findOptimized();
  if (optimized) return optimized;

  const host = resolve(ROOT, "target/wasm32-unknown-unknown/release/swap_and_grant.wasm");
  if (existsSync(host) && process.env.ALLOW_HOST_WASM === "1") {
    console.warn("  ALLOW_HOST_WASM=1: uploading a host build, which the chain will reject.");
    return host;
  }

  throw new Error(
    (existsSync(host)
      ? "only a host build exists, which the chain cannot deserialize.\nBuild with the pinned optimizer:\n"
      : "no optimizer output found. Build it first:\n") + BUILD_HINT,
  );
}

function ok(tx: TxResponse, what: string): TxResponse {
  if (tx.code !== 0) throw new Error(`${what} failed (code ${tx.code}): ${tx.rawLog}`);
  console.log(`  ${what} ok — ${tx.transactionHash}  gas used ${tx.gasUsed}/${tx.gasWanted}`);
  return tx;
}

function attribute(tx: TxResponse, key: string): string {
  const found = tx.arrayLog?.find((log) => log.key === key)?.value;
  if (!found) throw new Error(`no "${key}" in the tx log`);
  return found;
}

/** The chain's own answer, not what anyone told us the hash was. */
async function codeHashOf(client: SecretNetworkClient, address: string): Promise<string> {
  const { code_hash } = await client.query.compute.codeHashByContractAddress({
    contract_address: address,
  });
  if (!code_hash) throw new Error(`${address} returned no code hash — is it a contract?`);
  return code_hash;
}

interface PairInfo {
  get_pair_info?: {
    pair?: unknown[];
    amount_0?: string;
    amount_1?: string;
    total_liquidity?: string;
  };
}

function customTokenAddress(side: unknown): string | undefined {
  const token = side as { custom_token?: { contract_addr?: string } };
  return token?.custom_token?.contract_addr;
}

/**
 * Confirm the pair really trades sSCRT against stkd-SCRT, and report what it
 * holds.
 *
 * The reserves are printed rather than used: min_out is quoted per trade from
 * the router's own simulation in the app, because stkd-SCRT is a staking
 * derivative whose rate against SCRT is above one and rising. These numbers are
 * here so a human can see whether the pool is deep enough to bother with.
 */
async function checkPair(
  client: SecretNetworkClient,
  address: string,
  code_hash: string,
): Promise<void> {
  const info = (await client.query.compute.queryContract({
    contract_address: address,
    code_hash,
    query: { get_pair_info: {} },
  })) as PairInfo;

  const pair = info?.get_pair_info?.pair ?? [];
  const sides = pair.map(customTokenAddress).filter(Boolean) as string[];
  const wanted = [MAINNET_TOKENS.sscrt.address, MAINNET_TOKENS.stkd.address];

  const matches = wanted.every((token) => sides.includes(token));
  if (!matches) {
    throw new Error(
      `${address} is not the sSCRT/stkd-SCRT pair.\n` +
        `  it trades: ${sides.join(", ") || "(no custom tokens)"}\n` +
        `  expected:  ${wanted.join(", ")}`,
    );
  }

  console.log(`  pair holds ${info.get_pair_info?.amount_0} / ${info.get_pair_info?.amount_1}`);
  console.log(`  total liquidity ${info.get_pair_info?.total_liquidity}`);
}

interface FactoryPairs {
  list_a_m_m_pairs?: { amm_pairs?: Array<{ address: string; code_hash: string; pair: unknown[] }> };
}

/** Find the sSCRT/stkd-SCRT pair without being told which one it is. */
async function findPair(
  client: SecretNetworkClient,
  factory: string,
): Promise<{ address: string; code_hash: string }> {
  const code_hash = await codeHashOf(client, factory);
  const answer = (await client.query.compute.queryContract({
    contract_address: factory,
    code_hash,
    query: { list_a_m_m_pairs: { pagination: { start: 0, limit: 100 } } },
  })) as FactoryPairs;

  const wanted = [MAINNET_TOKENS.sscrt.address, MAINNET_TOKENS.stkd.address];
  const found = (answer?.list_a_m_m_pairs?.amm_pairs ?? []).find((entry) => {
    const sides = entry.pair.map(customTokenAddress).filter(Boolean) as string[];
    return wanted.every((token) => sides.includes(token));
  });

  if (!found) {
    // An empty list means "not in the first hundred", never "does not exist".
    throw new Error(
      `no sSCRT/stkd-SCRT pair among the factory's first 100 pairs.\n` +
        `That is not proof there is none — name it directly with PAIR=secret1...`,
    );
  }

  console.log(`  factory names the pair as ${found.address}`);
  return { address: found.address, code_hash: found.code_hash };
}

async function main() {
  const chain = chainId();
  const config = CHAINS[chain];
  const lcd = process.env.LCD_URL ?? config.lcd;

  if (!config.testnet && process.env.CONFIRM !== chain) {
    throw new Error(
      `${chain} is mainnet and this spends real SCRT.\n` +
        `Re-run with CONFIRM=${chain} if that is what you want.`,
    );
  }

  const mnemonic = required("MNEMONIC");
  const gasVault = required("GAS_VAULT");

  const wallet = new Wallet(mnemonic);
  const sender = wallet.address;
  const client = new SecretNetworkClient({
    url: lcd,
    chainId: chain,
    wallet,
    walletAddress: sender,
  });

  const path = wasmPath();
  console.log(`chain     ${chain}${config.testnet ? "" : "  (MAINNET)"}`);
  console.log(`lcd       ${lcd}`);
  console.log(`sender    ${sender}`);
  console.log(`wasm      ${path}`);

  const balance = await client.query.bank.balance({ address: sender, denom: DENOM });
  const held = BigInt(balance.balance?.amount ?? "0");
  console.log(`balance   ${held} ${DENOM}`);
  if (held < FEES_HEADROOM) {
    throw new Error(`need about ${FEES_HEADROOM} ${DENOM} for fees`);
  }

  console.log("\n1. read what already exists off the chain");
  const gasVaultHash = await codeHashOf(client, gasVault);
  console.log(`  gas vault ${gasVault}`);
  console.log(`    code hash ${gasVaultHash}`);

  // sSCRT is required: it is the redeem leg both paths end in.
  const sscrtAddress = process.env.SSCRT ?? MAINNET_TOKENS.sscrt.address;
  const sscrtHash = await codeHashOf(client, sscrtAddress);
  console.log(`  sSCRT     ${sscrtAddress}`);
  console.log(`    code hash ${sscrtHash}`);
  if (chain === "secret-4" && sscrtHash !== MAINNET_TOKENS.sscrt.code_hash) {
    console.warn(
      `    NOTE: differs from the documented hash ${MAINNET_TOKENS.sscrt.code_hash}\n` +
        `    The chain wins — but check you are pointing at the token you meant.`,
    );
  }

  // The swap path is optional. Without a router the executor still accepts
  // sSCRT, and that is a valid deployment, not a broken one.
  let router: { address: string; code_hash: string } | undefined;
  let routes: unknown[] = [];

  const routerAddress = process.env.ROUTER;
  if (routerAddress) {
    const routerHash = await codeHashOf(client, routerAddress);
    router = { address: routerAddress, code_hash: routerHash };
    console.log(`  router    ${routerAddress}`);
    console.log(`    code hash ${routerHash}`);

    const pair = process.env.PAIR
      ? { address: process.env.PAIR, code_hash: await codeHashOf(client, process.env.PAIR) }
      : await findPair(client, required("FACTORY"));

    console.log(`  pair      ${pair.address}`);
    console.log(`    code hash ${pair.code_hash}`);
    await checkPair(client, pair.address, pair.code_hash);

    const stkdAddress = process.env.STKD ?? MAINNET_TOKENS.stkd.address;
    const stkdHash = await codeHashOf(client, stkdAddress);
    console.log(`  stkd-SCRT ${stkdAddress}`);
    console.log(`    code hash ${stkdHash}`);

    routes = [
      {
        token: { address: stkdAddress, code_hash: stkdHash },
        path: [{ addr: pair.address, code_hash: pair.code_hash }],
      },
    ];
  } else {
    console.log("  router    none — this deployment will accept sSCRT only");
  }

  console.log("\n2. upload");
  const wasm = new Uint8Array(readFileSync(path));
  console.log(`  ${path} (${wasm.length} bytes)`);
  const stored = ok(
    await client.tx.compute.storeCode(
      { sender, wasm_byte_code: wasm, source: "", builder: "" },
      { gasLimit: 5_000_000 },
    ),
    "storeCode",
  );
  const codeId = Number(attribute(stored, "code_id"));
  const { code_hash: codeHash } = await client.query.compute.codeHashByCodeId({
    code_id: String(codeId),
  });
  console.log(`  code_id ${codeId}  code_hash ${codeHash}`);

  console.log("\n3. instantiate");
  // Not a secret worth protecting: it only reveals balances that are meant to
  // be zero between transactions. Random anyway, so it is not guessable.
  const viewingKey = `swap-and-grant-${randomBytes(16).toString("hex")}`;

  const created = ok(
    await client.tx.compute.instantiateContract(
      {
        sender,
        code_id: codeId,
        code_hash: codeHash,
        init_msg: {
          gas_vault: { address: gasVault, code_hash: gasVaultHash },
          sscrt: { address: sscrtAddress, code_hash: sscrtHash },
          viewing_key: viewingKey,
          admin: sender,
          router,
          routes,
        },
        label: `swap-and-grant-${Date.now()}`,
        // No migrate admin, on purpose. This contract holds nothing between
        // transactions, depends on no query allow-list, and the one thing that
        // would otherwise force a migration — the vault migrating and changing
        // its code hash — is covered by SetCodeHashes, which cannot repoint the
        // address. The in-contract admin below can still fix routes.
      },
      { gasLimit: 500_000 },
    ),
    "instantiate",
  );
  const contract = attribute(created, "contract_address");

  console.log(`\n  contract ${contract}`);
  console.log(`  admin    ${sender} — may change routes and code hashes, nothing else`);
  console.log(`  migrate  none — deployed immutable`);

  const verify = process.env.VERIFY;
  if (verify && router) {
    console.log(`\n4. verify: buy ${verify} of credit with stkd-SCRT`);
    console.log("  Nothing about this chain's behaviour is assumed — if the reply does not");
    console.log("  fire, or the vault cannot dispatch its grant, the whole transaction");
    console.log("  reverts and the stkd-SCRT comes back.");

    const stkd = (routes[0] as { token: { address: string; code_hash: string } }).token;
    const payload = Buffer.from(
      JSON.stringify({ buy_credit: { grantee: sender, min_out: "1" } }),
      "utf8",
    ).toString("base64");

    const bought = ok(
      await client.tx.compute.executeContract(
        {
          sender,
          contract_address: stkd.address,
          code_hash: stkd.code_hash,
          msg: {
            send: {
              recipient: contract,
              // Required: without it the token never calls the executor back,
              // because the executor deliberately registers no callback.
              recipient_code_hash: codeHash,
              amount: verify,
              msg: payload,
            },
          },
        },
        { gasLimit: 2_400_000 },
      ),
      "buy with stkd-SCRT",
    );

    console.log("\n5. read the grant back off the chain");
    const { allowances } = await client.query.feegrant.allowances({ grantee: sender });
    const mine = (allowances ?? []).filter((a) => a.granter === gasVault);
    if (mine.length === 0) {
      throw new Error(
        "the transaction succeeded but the vault issued no grant — that is the failure to chase",
      );
    }
    console.log(JSON.stringify(mine, null, 2));

    const balances = await client.query.compute.queryContract({
      contract_address: contract,
      code_hash: codeHash,
      query: { balances: {} },
    });
    console.log(`\n  executor balances ${JSON.stringify(balances)}`);
    console.log("  Every figure there should be zero: the executor holds nothing at rest.");

    console.log(
      `\n  GAS USED ${bought.gasUsed} — put this in src/lib/gasVault.ts as ` +
        `GAS_BUY_VIA_SWAP,\n  with headroom, and delete the note saying it is provisional.`,
    );
  } else if (verify) {
    console.log("\n4. verify skipped — no ROUTER, so there is no swap path to exercise");
  }

  const suffix = config.testnet ? "" : "_MAINNET";
  console.log("\nPut these in .env.local:");
  console.log(`  NEXT_PUBLIC_SWAP_AND_GRANT_ADDRESS${suffix}=${contract}`);
  if (router) {
    const pair = (routes[0] as { path: { addr: string; code_hash: string }[] }).path[0];
    console.log(`  NEXT_PUBLIC_SHADE_ROUTER_ADDRESS=${router.address}`);
    console.log(`  NEXT_PUBLIC_SHADE_ROUTER_CODE_HASH=${router.code_hash}`);
    console.log(`  NEXT_PUBLIC_SSCRT_STKD_PAIR_ADDRESS=${pair.addr}`);
    console.log(`  NEXT_PUBLIC_SSCRT_STKD_PAIR_CODE_HASH=${pair.code_hash}`);
  } else {
    console.log("  (no router configured, so the stkd-SCRT route is not offered)");
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
