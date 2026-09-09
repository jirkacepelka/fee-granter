use cosmwasm_std::{Binary, Uint128};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// The wire types this double shares with the executor are copied here rather
// than imported from it. Two reasons: depending on that crate would pull its
// entry points in and collide at link time, and — more usefully — a test
// double that shares production types cannot catch the executor's types
// drifting. If these fall out of step, the integration run fails, which is
// exactly what it is for.

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
pub struct ContractInfo {
    pub address: String,
    pub code_hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReceiveMsg {
    BuyCredit { grantee: String, min_out: Option<Uint128> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub struct Hop {
    pub addr: String,
    pub code_hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RouterInvokeMsg {
    SwapTokensForExact {
        path: Vec<Hop>,
        expected_return: Option<Uint128>,
        recipient: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Snip20ExecuteMsg {
    Redeem { amount: Uint128, denom: Option<String>, padding: Option<String> },
    Send {
        recipient: String,
        recipient_code_hash: Option<String>,
        amount: Uint128,
        msg: Option<Binary>,
        memo: Option<String>,
        padding: Option<String>,
    },
    SetViewingKey { key: String, padding: Option<String> },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Snip20QueryMsg {
    Balance { address: String, key: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Snip20QueryAnswer {
    Balance { amount: Uint128 },
    ViewingKeyError { msg: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
pub struct InstantiateMsg {
    /// The token this router pays out. It must already hold a balance here,
    /// and this contract needs a key on it to know how much it holds.
    pub payout_token: ContractInfo,
    pub viewing_key: String,
}

/// How the next swap should misbehave.
///
/// Every variant here is something the real ShadeSwap router could do to us —
/// the point of this contract is that they can be produced on demand, which
/// they cannot be against the real one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Behaviour {
    /// Pay out `rate_bps` basis points of what came in. 10000 is one for one;
    /// anything below the caller's bound must make the executor abort.
    Pay { rate_bps: u64 },
    /// The inner step fails and this router's own `reply_always` handler
    /// swallows the error, reporting success while delivering nothing.
    ///
    /// This is the case the whole balance-difference design exists for. The
    /// real router drives its hops with `reply_always` too, so its handler is
    /// likewise free to do this.
    SwallowFailure,
    /// The inner step fails and the error is allowed to propagate, which
    /// should take the entire transaction down.
    Fail,
    /// Call back into the executor part-way through the swap, to prove the
    /// re-entrancy lock holds.
    Reenter {
        executor: ContractInfo,
        token: ContractInfo,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecuteMsg {
    /// The SNIP-20 receiver interface, same shape the real router exposes.
    Receive {
        sender: String,
        from: String,
        amount: Uint128,
        #[serde(default)]
        memo: Option<String>,
        #[serde(default)]
        msg: Option<Binary>,
    },
    /// The inner leg. Dispatched to this same contract so the nesting the
    /// executor has to survive — a submessage whose own execution uses
    /// `reply_always` — is reproduced without a second contract.
    Hop { fail: bool },
    SetBehaviour { behaviour: Behaviour },
    SetViewingKey { key: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueryMsg {
    Behaviour {},
}
