//! Stored state.
//!
//! Two keys, both holding whole JSON values. Secret's CosmWasm has no storage
//! iterator, so the routes cannot be a set of prefixed keys that something
//! later walks — they live inside the config as a list. That is not a
//! compromise at this size: there are one or two of them, they are read on
//! every call anyway, and one value cannot half-update.

use cosmwasm_std::{from_slice, to_vec, Addr, StdError, StdResult, Storage, Uint128};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::msg::{ContractInfo, Hop};

pub const CONFIG_KEY: &[u8] = b"config";
pub const PENDING_KEY: &[u8] = b"pending";

/// A validated [`ContractInfo`].
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Contract {
    pub address: Addr,
    pub code_hash: String,
}

impl Contract {
    pub fn info(&self) -> ContractInfo {
        ContractInfo {
            address: self.address.to_string(),
            code_hash: self.code_hash.clone(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Route {
    pub token: Contract,
    pub path: Vec<Hop>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Config {
    /// Frozen address. Redirecting this is the only way this contract could be
    /// made to take someone's money and not deliver credit, so it is the one
    /// thing an admin cannot touch.
    pub gas_vault: Contract,
    /// Frozen address, for the same reason.
    pub sscrt: Contract,
    pub viewing_key: String,
    pub admin: Option<Addr>,
    pub router: Option<Contract>,
    /// Also the allow-list: a token with no route here cannot be paid in.
    pub routes: Vec<Route>,
}

impl Config {
    pub fn route_for(&self, token: &Addr) -> Option<&Route> {
        self.routes.iter().find(|route| &route.token.address == token)
    }
}

/// A swap between this contract's `Receive` and its `reply`.
///
/// Its presence is also the lock that stops a second purchase starting while
/// the first is mid-flight. Storage rolls back with a failed transaction, so a
/// lock can never be left set with no reply coming to clear it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Pending {
    pub grantee: Addr,
    /// This contract's sSCRT balance before the swap. The swap's output is the
    /// difference against this, never a number parsed out of the router's
    /// answer.
    pub before: Uint128,
    pub min_out: Uint128,
}

pub fn save_config(storage: &mut dyn Storage, config: &Config) -> StdResult<()> {
    storage.set(CONFIG_KEY, &to_vec(config)?);
    Ok(())
}

pub fn load_config(storage: &dyn Storage) -> StdResult<Config> {
    storage
        .get(CONFIG_KEY)
        .ok_or_else(|| StdError::generic_err("this contract has no config"))
        .and_then(|raw| from_slice(&raw))
}

pub fn save_pending(storage: &mut dyn Storage, pending: &Pending) -> StdResult<()> {
    storage.set(PENDING_KEY, &to_vec(pending)?);
    Ok(())
}

pub fn load_pending(storage: &dyn Storage) -> StdResult<Option<Pending>> {
    storage.get(PENDING_KEY).map(|raw| from_slice(&raw)).transpose()
}

pub fn clear_pending(storage: &mut dyn Storage) {
    storage.remove(PENDING_KEY);
}
