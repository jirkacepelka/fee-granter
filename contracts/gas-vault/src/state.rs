use schemars::JsonSchema;
use cosmwasm_std::{Addr, Storage, Uint128};
use cosmwasm_storage::{singleton, singleton_read};
use serde::{Deserialize, Serialize};

pub const OUTSTANDING_KEY: &[u8] = b"outstanding";
pub const ISSUED_PREFIX: &[u8] = b"issued";

/// Total of every allowance still outstanding.
///
/// x/feegrant does not reserve funds, so the contract has to track what it has
/// promised and refuse to promise more than it holds.
#[derive(Serialize, Deserialize, Clone, Debug, Default, JsonSchema)]
pub struct Outstanding {
    pub total: Uint128,
}

pub fn outstanding(storage: &mut dyn Storage) -> cosmwasm_storage::Singleton<'_, Outstanding> {
    singleton(storage, OUTSTANDING_KEY)
}

pub fn outstanding_read(
    storage: &dyn Storage,
) -> cosmwasm_storage::ReadonlySingleton<'_, Outstanding> {
    singleton_read(storage, OUTSTANDING_KEY)
}

fn issued_key(grantee: &Addr) -> Vec<u8> {
    [ISSUED_PREFIX, grantee.as_bytes()].concat()
}

pub fn read_issued(storage: &dyn Storage, grantee: &Addr) -> Uint128 {
    storage
        .get(&issued_key(grantee))
        .and_then(|raw| serde_json_wasm_from(&raw))
        .unwrap_or_default()
}

pub fn write_issued(storage: &mut dyn Storage, grantee: &Addr, amount: Uint128) {
    storage.set(&issued_key(grantee), amount.to_string().as_bytes());
}

fn serde_json_wasm_from(raw: &[u8]) -> Option<Uint128> {
    std::str::from_utf8(raw).ok()?.parse::<u128>().ok().map(Uint128::new)
}
