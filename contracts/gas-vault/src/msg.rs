use schemars::JsonSchema;
use cosmwasm_std::{Addr, Uint128};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct InstantiateMsg {}

/// Deliberately empty. A migration approves *which code runs*; parameters here
/// would hand whoever relays it choices that approval never covered.
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct MigrateMsg {}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    /// Pay SCRT in and have the contract grant that address an allowance 1:1.
    /// Send the funds with the message; `grantee` may be any address.
    Grant { grantee: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    /// What the contract holds, which is also what it owes. See `StatusResponse`.
    Status {},
    /// What x/feegrant says this address still has, read live from the chain.
    Remaining { grantee: String },
    /// What the contract last set this address's allowance to. Historical: they
    /// have spent some of it if they have used it. `Remaining` is the live figure.
    Issued { grantee: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct StatusResponse {
    /// What the contract holds, in uscrt.
    ///
    /// This is also the sum of every allowance still outstanding, and not by
    /// coincidence: a grant adds the same amount to both, and spending a granted
    /// fee takes the same amount off both, because x/feegrant charges the fee to
    /// the granter - this contract. The two figures cannot drift, so the
    /// contract cannot promise more than it holds. Anyone sending SCRT here
    /// without buying credit only moves it in the safe direction.
    pub balance: Uint128,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct IssuedResponse {
    pub grantee: Addr,
    pub amount: Uint128,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct RemainingResponse {
    pub grantee: Addr,
    /// `None` when x/feegrant could not be asked. That is not the same as zero
    /// and must not be shown as it.
    pub amount: Option<Uint128>,
}
