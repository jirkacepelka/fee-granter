use schemars::JsonSchema;
use cosmwasm_std::{Addr, Uint128};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct InstantiateMsg {}

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
    /// Outstanding obligations vs. the balance actually backing them.
    Solvency {},
    /// What this contract believes it granted to one address.
    Issued { grantee: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct SolvencyResponse {
    /// Sum of every allowance still outstanding, in uscrt.
    pub outstanding: Uint128,
    /// What the contract holds. A grant is a promise, not a reservation, so
    /// this has to be checked before issuing rather than assumed.
    pub balance: Uint128,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct IssuedResponse {
    pub grantee: Addr,
    pub amount: Uint128,
}
