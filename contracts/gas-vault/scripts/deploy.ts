/**
 * Deploy gas-vault: upload and instantiate, and print the address to put in the app.
 *
 *   MNEMONIC="..." node --experimental-strip-types contracts/gas-vault/scripts/deploy.ts
 *
 * Set GRANTEE as well to also buy an allowance and read the resulting grant back
 * off the chain. That is not part of deploying — granting belongs in the app —
 * but it is the only convincing proof that this chain lets a contract issue a
 * fee grant at all, so it is worth doing once per chain.
 *
 * Defaults to pulsar-3. For mainnet, name it and confirm it:
 *
 *   CHAIN=secret-4 CONFIRM=secret-4 MNEMONIC="..." \
 *     node --experimental-strip-types contracts/gas-vault/scripts/deploy.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SecretNetworkClient, Wallet, type TxResponse } from "secretjs";

const DENOM = "uscrt";

const CHAINS = {
  "pulsar-3": {
    lcd: "https://pulsar.lcd.secretnodes.com",
    testnet: true,
    topUp: "top up at https://faucet.pulsar.scrttestnet.com",
  },
  "secret-4": {
    // The one mainnet endpoint this project has actually seen resolve. Others
    // in src/lib/chains.ts are worth trying via LCD_URL if it is down.
    lcd: "https://lcd-secret.keplr.app",
    testnet: false,
    topUp: "this is real SCRT",
  },
} as const;

type ChainId = keyof typeof CHAINS;

function chainId(): ChainId {
  const value = process.env.CHAIN ?? "pulsar-3";
  if (!(value in CHAINS)) {
    throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}, got ${value}`);
  }
  return value as ChainId;
}

/** How much allowance to buy, in uscrt. Only used when GRANTEE is set. */
const AMOUNT = process.env.AMOUNT ?? "1000000";

/** Upload, instantiate and the first grant, at 0.1 uscrt/gas plus room to spare. */
const FEES_HEADROOM = 1_500_000n;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BUILD_HINT =
  `  cd ${ROOT}\n` +
  '  docker run --rm -v "$PWD":/contract -w /contract \\\n' +
  "    ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13\n" +
  "\n  PowerShell:\n" +
  '  $img = "ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13"\n' +
  '  docker run --rm -v "${PWD}:/contract" -w /contract $img';

/** Whatever the optimizer left behind, wherever this version puts it. */
function findOptimized(): string | undefined {
  // Older images write straight to the project root.
  const flat = resolve(ROOT, "contract.wasm.gz");
  if (existsSync(flat)) return flat;

  // 1.0.13 writes into optimized-wasm/, and the file name follows the crate.
  const dir = resolve(ROOT, "optimized-wasm");
  if (!existsSync(dir)) return undefined;

  const names = readdirSync(dir);
  const best =
    names.find((name) => name.endsWith(".wasm.gz")) ?? names.find((name) => name.endsWith(".wasm"));
  return best ? resolve(dir, best) : undefined;
}

/**
 * Only the optimizer's output is uploadable.
 *
 * A host `cargo build` with Rust 1.82+ emits the reference-types and multivalue
 * proposals, and the chain refuses to deserialize the result — "Invalid table
 * reference". Uploading one can never succeed, so this refuses rather than
 * spending gas to learn that, and the error names the build step instead of
 * looking like a chain or contract fault.
 */
function wasmPath(): string {
  const optimized = findOptimized();
  if (optimized) return optimized;

  const host = resolve(ROOT, "target/wasm32-unknown-unknown/release/gas_vault.wasm");
  if (existsSync(host) && process.env.ALLOW_HOST_WASM === "1") {
    console.warn("  ALLOW_HOST_WASM=1: uploading a host build, which the chain will reject.");
    return host;
  }

  throw new Error(
    (existsSync(host)
      ? "only a host build exists, which the chain cannot deserialize.\n" +
        "Build with the pinned optimizer:\n"
      : "no optimizer output found. Build it first:\n") + BUILD_HINT,
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * secretjs resolves a broadcast even when the chain rejected it, and a submit
 * response says nothing about execution. Check the code every time.
 */
function ok(tx: TxResponse, what: string): TxResponse {
  if (tx.code !== 0) {
    throw new Error(`${what} failed (code ${tx.code}): ${tx.rawLog}`);
  }
  console.log(`  ${what} ok — ${tx.transactionHash}`);
  return tx;
}

function attribute(tx: TxResponse, key: string): string {
  const found = tx.arrayLog?.find((log) => log.key === key)?.value;
  if (!found) throw new Error(`no "${key}" in the tx log`);
  return found;
}

async function main() {
  const chain = chainId();
  const config = CHAINS[chain];
  const lcd = process.env.LCD_URL ?? config.lcd;

  // Real money, and the vault is one-way: what goes in leaves only as gas.
  // Worth a deliberate second word rather than an env var set once and forgotten.
  if (!config.testnet && process.env.CONFIRM !== chain) {
    throw new Error(
      `${chain} is mainnet and this spends real SCRT.\n` +
        `The vault has no withdrawal: every uscrt paid in leaves only as somebody's gas.\n` +
        `Re-run with CONFIRM=${chain} if that is what you want.`,
    );
  }

  const mnemonic = required("MNEMONIC");
  // Optional: deploying and granting are separate jobs, and the app does the
  // granting. Naming a grantee here only adds the one-off proof.
  const grantee = process.env.GRANTEE;

  const wallet = new Wallet(mnemonic);
  const sender = wallet.address;
  const secretjs = new SecretNetworkClient({ url: lcd, chainId: chain, wallet, walletAddress: sender });

  const path = wasmPath();

  console.log(`chain    ${chain}${config.testnet ? "" : "  (MAINNET)"}`);
  console.log(`lcd      ${lcd}`);
  console.log(`sender   ${sender}`);
  console.log(`wasm     ${path}`);
  if (grantee) {
    console.log(`grantee  ${grantee}`);
    console.log(`amount   ${AMOUNT} ${DENOM}`);
  } else {
    console.log(`grantee  none — deploying only, no allowance bought`);
  }

  const balance = await secretjs.query.bank.balance({ address: sender, denom: DENOM });
  const held = BigInt(balance.balance?.amount ?? "0");
  const needed = (grantee ? BigInt(AMOUNT) : 0n) + FEES_HEADROOM;
  console.log(`balance  ${held} ${DENOM}`);
  if (held < needed) {
    throw new Error(`need about ${needed} ${DENOM} for the amount plus fees — ${config.topUp}`);
  }

  console.log("\n1. upload");
  const wasm = new Uint8Array(readFileSync(path));
  console.log(`  ${path} (${wasm.length} bytes)`);
  const stored = ok(
    await secretjs.tx.compute.storeCode(
      { sender, wasm_byte_code: wasm, source: "", builder: "" },
      { gasLimit: 5_000_000 },
    ),
    "storeCode",
  );
  const codeId = Number(attribute(stored, "code_id"));
  const { code_hash: codeHash } = await secretjs.query.compute.codeHashByCodeId({
    code_id: String(codeId),
  });
  console.log(`  code_id ${codeId}  code_hash ${codeHash}`);

  console.log("\n2. instantiate");
  const created = ok(
    await secretjs.tx.compute.instantiateContract(
      {
        sender,
        code_id: codeId,
        code_hash: codeHash,
        init_msg: {},
        label: `gas-vault-${Date.now()}`,
        // Migratable on purpose: the contract reads x/feegrant through a query
        // allow-list the chain reserves the right to change, and an immutable
        // contract could not be repaired if it did.
        admin: sender,
      },
      { gasLimit: 400_000 },
    ),
    "instantiate",
  );
  const contract = attribute(created, "contract_address");
  console.log(`  contract ${contract}`);
  console.log(`  admin    ${sender} — can migrate this contract, so keep the key safe`);

  if (!grantee) {
    console.log(`\nDeployed: ${contract}`);
    console.log(
      `Put it in src/lib/chains.ts as the ${chain} gasVaultAddress, or set ` +
        `NEXT_PUBLIC_GAS_VAULT_ADDRESS${config.testnet ? "" : "_MAINNET"}.`,
    );
    console.log(
      "\nNothing has issued a grant yet, so this chain's stargate path is still unproven.\n" +
        "The first purchase settles it, and settles it safely: the funds move in the same\n" +
        "transaction as the grant, so a chain that cannot dispatch it returns them.",
    );
    return;
  }

  console.log(`\n3. buy ${AMOUNT} ${DENOM} of allowance for the grantee`);
  // The funds arrive before execute runs, so this both funds the contract and
  // pays for the grant in one transaction. If the chain cannot dispatch the
  // grant, the whole transaction reverts and the funds stay put.
  ok(
    await secretjs.tx.compute.executeContract(
      {
        sender,
        contract_address: contract,
        code_hash: codeHash,
        msg: { grant: { grantee } },
        sent_funds: [{ denom: DENOM, amount: AMOUNT }],
      },
      { gasLimit: 500_000 },
    ),
    "execute grant",
  );

  console.log("\n4. read the grant back off the chain");
  const { allowances } = await secretjs.query.feegrant.allowances({ grantee });
  const mine = (allowances ?? []).filter((a) => a.granter === contract);

  if (mine.length === 0) {
    throw new Error(
      "the transaction succeeded but no grant exists — the contract did not issue one",
    );
  }
  console.log(JSON.stringify(mine, null, 2));

  const status = await secretjs.query.compute.queryContract({
    contract_address: contract,
    code_hash: codeHash,
    query: { status: {} },
  });
  console.log(`\nstatus ${JSON.stringify(status)}`);

  console.log(`\nA contract issued a fee grant. Granter is the contract: ${contract}`);
  console.log(`The grantee can now spend it by setting fee.granter to that address.`);
  console.log(
    `\nPut it in src/lib/chains.ts as the ${chain} gasVaultAddress, or set ` +
      `NEXT_PUBLIC_GAS_VAULT_ADDRESS${config.testnet ? "" : "_MAINNET"}.`,
  );
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
