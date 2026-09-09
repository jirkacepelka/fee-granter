//! Messages, including the shapes of the three foreign contracts this one talks
//! to. Those are transcribed from their sources rather than guessed at:
//!
//! - SNIP-20 from `scrtlabs/snip20-reference-impl` (`src/msg.rs`, `src/receiver.rs`)
//! - the ShadeSwap router from `securesecrets/shadeswap`
//!   (`packages/shadeswap-shared/src/msg.rs`, module `router`)
//! - the gas vault from `contracts/gas-vault` in this repository
//!
//! A wrong field name here is not a compile error, it is a transaction that
//! fails on chain, so the tests decode every message back and check it.

use cosmwasm_std::{Binary, Uint128};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// An address together with the code hash a call to it must be encrypted
/// against. The two always travel as one value: a migration changes both at
/// once, and separate fields invite updating only one of them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ContractInfo {
    pub address: String,
    pub code_hash: String,
}

/// One leg of a ShadeSwap route: the pair contract to trade through.
///
/// Field names are the router's, from `shadeswap-shared/src/msg.rs`. `addr`,
/// not `address`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct Hop {
    pub addr: String,
    pub code_hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct RouteInput {
    /// The SNIP-20 that may be paid in.
    pub token: ContractInfo,
    /// How to get from that token to sSCRT. One hop for stkd-SCRT.
    pub path: Vec<Hop>,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct InstantiateMsg {
    /// Where credit is bought. The address is frozen for the life of the
    /// contract; only its code hash can be corrected later.
    pub gas_vault: ContractInfo,
    /// The wrapped SCRT this contract redeems. Address likewise frozen.
    pub sscrt: ContractInfo,
    /// The key this contract sets on itself so it can read its own balances.
    ///
    /// Not a secret worth protecting: it only reveals balances that are meant
    /// to be zero between transactions.
    pub viewing_key: String,
    /// Defaults to the instantiating address. May be dropped later, and there
    /// is no chain-level migrate admin to fall back on.
    pub admin: Option<String>,
    /// Absent is a valid state: the contract then accepts sSCRT only.
    pub router: Option<ContractInfo>,
    /// Doubles as the allow-list of swappable input tokens.
    pub routes: Vec<RouteInput>,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    /// The SNIP-20 receiver interface, and the only way tokens get in.
    ///
    /// Shape from `Snip20ReceiveMsg`. `memo` is skipped when absent and `msg`
    /// is optional, so both need `default` or a payload-less arrival fails to
    /// parse rather than being ignored the way it should be.
    Receive {
        sender: String,
        from: String,
        amount: Uint128,
        #[serde(default)]
        memo: Option<String>,
        #[serde(default)]
        msg: Option<Binary>,
    },
    /// Admin. Point at a redeployed ShadeSwap router.
    SetRouter { router: ContractInfo },
    /// Admin. An empty path removes the token from the allow-list.
    SetRoute { token: ContractInfo, path: Vec<Hop> },
    /// Admin. Correct a code hash after the vault or sSCRT migrates. The
    /// addresses cannot be changed, so this cannot redirect anyone's money —
    /// a wrong hash only makes calls fail.
    SetCodeHashes {
        gas_vault: Option<String>,
        sscrt: Option<String>,
    },
    /// Admin. `None` gives up the ability to configure this contract forever.
    SetAdmin { admin: Option<String> },
    /// Deliberately unpermissioned. Redeems any sSCRT left lying here and pays
    /// it into the vault as a plain transfer, not as anyone's credit — so
    /// there is nothing to gain by calling it and no key needed to do so.
    SweepToVault {},
}

/// What rides in the `msg` field of the SNIP-20 `Send` that pays for credit.
#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReceiveMsg {
    /// `min_out` is required on the swap path and rejected on the sSCRT path.
    /// There is no default: the contract has no basis for choosing one, and a
    /// silent default is the number that is eventually wrong without anyone
    /// noticing.
    BuyCredit {
        grantee: String,
        min_out: Option<Uint128>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    Config {},
    /// Which tokens this deployment accepts, and through what. The frontend
    /// reads this rather than keeping a second copy of the list that could
    /// drift from the contract's.
    Routes {},
    /// Should be zero everywhere between transactions. See the README.
    Balances {},
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct ConfigResponse {
    pub gas_vault: ContractInfo,
    pub sscrt: ContractInfo,
    pub router: Option<ContractInfo>,
    pub admin: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct RoutesResponse {
    pub routes: Vec<RouteInput>,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct TokenBalance {
    pub address: String,
    /// `None` when the balance could not be read. That is not zero and must
    /// not be displayed as zero.
    pub amount: Option<Uint128>,
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct BalancesResponse {
    pub native: Uint128,
    pub sscrt: Option<Uint128>,
    pub tokens: Vec<TokenBalance>,
}

// ---------------------------------------------------------------------------
// Foreign contracts
// ---------------------------------------------------------------------------

/// The subset of SNIP-20 this contract sends.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Snip20ExecuteMsg {
    /// Burns the wrapper and pays out native SCRT. One to one, same decimals.
    Redeem {
        amount: Uint128,
        denom: Option<String>,
        padding: Option<String>,
    },
    Send {
        recipient: String,
        recipient_code_hash: Option<String>,
        amount: Uint128,
        msg: Option<Binary>,
        memo: Option<String>,
        padding: Option<String>,
    },
    SetViewingKey {
        key: String,
        padding: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Snip20QueryMsg {
    Balance { address: String, key: String },
}

/// SNIP-20 wraps query answers in a variant, so a bad viewing key comes back as
/// a distinct answer rather than an error. Reading that as a zero balance would
/// make the swap path compute a nonsense difference, so it is matched
/// explicitly.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Snip20QueryAnswer {
    Balance { amount: Uint128 },
    ViewingKeyError { msg: String },
}

/// `contracts/gas-vault`. Pay uscrt in as funds and it grants the same amount.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GasVaultExecuteMsg {
    Grant { grantee: String },
}

/// What the ShadeSwap router expects inside a SNIP-20 `Send`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RouterInvokeMsg {
    SwapTokensForExact {
        path: Vec<Hop>,
        expected_return: Option<Uint128>,
        recipient: Option<String>,
    },
}
