/**
 * Deploy gas-vault to pulsar-3 and prove it works, end to end.
 *
 * Uploads, instantiates, buys an allowance for GRANTEE, then reads that grant
 * back out of the chain — because the only convincing evidence that a contract
 * can issue a fee grant is the grant existing afterwards.
 *
 *   MNEMONIC="..." GRANTEE="secret1..." \
 *     node --experimental-strip-types contracts/gas-vault/scripts/deploy-pulsar.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SecretNetworkClient, Wallet, type TxResponse } from "secretjs";

const CHAIN_ID = "pulsar-3";
const LCD = process.env.LCD_URL ?? "https://pulsar.lcd.secretnodes.com";
const DENOM = "uscrt";

/** How much allowance to buy, in uscrt. 1 SCRT covers a lot of testnet fees. */
const AMOUNT = process.env.AMOUNT ?? "1000000";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Prefer the optimizer's output. A host `cargo build` with Rust 1.82+ emits the
 * reference-types and multivalue proposals, which the chain rejects at upload —
 * so falling back to it is only useful for catching mistakes earlier, and the
 * warning says so rather than letting the rejection look like a chain problem.
 */
function wasmPath(): { path: string; optimized: boolean } {
  const optimized = resolve(ROOT, "contract.wasm.gz");
  if (existsSync(optimized)) return { path: optimized, optimized: true };

  const host = resolve(ROOT, "target/wasm32-unknown-unknown/release/gas_vault.wasm");
  if (existsSync(host)) return { path: host, optimized: false };

  throw new Error(
    "no wasm found. Build it first:\n" +
      `  docker run --rm -v "${ROOT}":/contract -w /contract \\\n` +
      "    ghcr.io/scrtlabs/secret-contract-optimizer:1.0.13",
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
  const mnemonic = required("MNEMONIC");
  const grantee = required("GRANTEE");

  const wallet = new Wallet(mnemonic);
  const sender = wallet.address;
  const secretjs = new SecretNetworkClient({
    url: LCD,
    chainId: CHAIN_ID,
    wallet,
    walletAddress: sender,
  });

  console.log(`sender   ${sender}`);
  console.log(`grantee  ${grantee}`);

  const balance = await secretjs.query.bank.balance({ address: sender, denom: DENOM });
  console.log(`balance  ${balance.balance?.amount ?? "0"} ${DENOM}`);
  if (BigInt(balance.balance?.amount ?? "0") < 2_000_000n) {
    throw new Error("need at least ~2 SCRT — top up at https://faucet.pulsar.scrttestnet.com");
  }

  console.log("\n1. upload");
  const { path, optimized } = wasmPath();
  const wasm = new Uint8Array(readFileSync(path));
  console.log(`  ${path} (${wasm.length} bytes)`);
  if (!optimized) {
    console.warn(
      "  warning: this is a host build, which the chain will most likely reject.\n" +
        "  Build with the pinned optimizer image for a deployable artifact.",
    );
  }
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
      },
      { gasLimit: 400_000 },
    ),
    "instantiate",
  );
  const contract = attribute(created, "contract_address");
  console.log(`  contract ${contract}`);

  console.log(`\n3. buy ${AMOUNT} ${DENOM} of allowance for the grantee`);
  // The funds arrive before execute runs, so this both funds the contract and
  // pays for the grant in one transaction.
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

  const solvency = await secretjs.query.compute.queryContract({
    contract_address: contract,
    code_hash: codeHash,
    query: { solvency: {} },
  });
  console.log(`\nsolvency ${JSON.stringify(solvency)}`);

  console.log(`\nA contract issued a fee grant. Granter is the contract: ${contract}`);
  console.log(`The grantee can now spend it by setting fee.granter to that address.`);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
