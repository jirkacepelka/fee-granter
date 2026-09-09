//! A stand-in for the ShadeSwap router, for tests only. Never deploy this
//! anywhere that matters — it hands out whatever it is holding to whoever asks.
//!
//! It exists because the executor's design rests on one claim that no unit test
//! can check and no mainnet transaction should be the first to find out:
//!
//! > a `reply` still runs after a submessage whose own execution used
//! > `SubMsg::reply_always`
//!
//! The real router does exactly that — `contracts/router/src/operations.rs`
//! drives its hops with `SubMsg::reply_always` and carries state between them
//! in `CurrentSwapInfo`. So this contract reproduces that shape rather than
//! simply transferring tokens: it takes the SNIP-20 `Receive`, dispatches a
//! `reply_always` submessage of its own, and only pays out from its own reply.
//! The inner hop is sent to this same contract, which keeps the nesting
//! faithful without needing a separate pair.
//!
//! On top of that it can produce, on demand, the three things the real router
//! might do that the executor must survive: pay out less than promised, report
//! success having delivered nothing, and call back into the executor mid-swap.

use cosmwasm_std::{
    entry_point, from_binary, from_slice, to_binary, to_vec, Binary, Deps, DepsMut, Env,
    MessageInfo, Reply, Response, StdError, StdResult, SubMsg, SubMsgResult, Uint128, WasmMsg,
};

use crate::msg::{
    Behaviour, ContractInfo, ExecuteMsg, InstantiateMsg, QueryMsg, ReceiveMsg, RouterInvokeMsg,
    Snip20ExecuteMsg, Snip20QueryAnswer, Snip20QueryMsg,
};

const STATE_KEY: &[u8] = b"state";
const FLIGHT_KEY: &[u8] = b"flight";
const HOP_REPLY: u64 = 7;

#[derive(serde::Serialize, serde::Deserialize)]
struct State {
    payout_token: ContractInfo,
    viewing_key: String,
    behaviour: Behaviour,
}

/// The router's own version of `CurrentSwapInfo`.
#[derive(serde::Serialize, serde::Deserialize)]
struct Flight {
    recipient: String,
    amount_in: Uint128,
}

fn load_state(deps: Deps) -> StdResult<State> {
    deps.storage
        .get(STATE_KEY)
        .ok_or_else(|| StdError::generic_err("not instantiated"))
        .and_then(|raw| from_slice(&raw))
}

fn save_state(deps: DepsMut, state: &State) -> StdResult<()> {
    deps.storage.set(STATE_KEY, &to_vec(state)?);
    Ok(())
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> StdResult<Response> {
    let key = msg.viewing_key.clone();
    let token = msg.payout_token.clone();

    save_state(
        deps,
        &State {
            payout_token: msg.payout_token,
            viewing_key: msg.viewing_key,
            behaviour: Behaviour::Pay { rate_bps: 10_000 },
        },
    )?;

    Ok(Response::new().add_message(WasmMsg::Execute {
        contract_addr: token.address,
        code_hash: token.code_hash,
        msg: to_binary(&Snip20ExecuteMsg::SetViewingKey { key, padding: None })?,
        funds: vec![],
    }))
}

#[entry_point]
pub fn execute(deps: DepsMut, env: Env, _info: MessageInfo, msg: ExecuteMsg) -> StdResult<Response> {
    match msg {
        ExecuteMsg::Receive { amount, msg, .. } => receive(deps, env, amount, msg),
        ExecuteMsg::Hop { fail } => {
            if fail {
                Err(StdError::generic_err("the pool blew up"))
            } else {
                Ok(Response::new().add_attribute("action", "hop"))
            }
        }
        ExecuteMsg::SetBehaviour { behaviour } => {
            let mut state = load_state(deps.as_ref())?;
            state.behaviour = behaviour;
            save_state(deps, &state)?;
            Ok(Response::new())
        }
        ExecuteMsg::SetViewingKey { key } => {
            let state = load_state(deps.as_ref())?;
            Ok(Response::new().add_message(WasmMsg::Execute {
                contract_addr: state.payout_token.address.clone(),
                code_hash: state.payout_token.code_hash.clone(),
                msg: to_binary(&Snip20ExecuteMsg::SetViewingKey { key, padding: None })?,
                funds: vec![],
            }))
        }
    }
}

/// Tokens arrived with a swap request. Stash the request and go through a
/// `reply_always` submessage, the way the real router does, rather than paying
/// out from here.
fn receive(deps: DepsMut, env: Env, amount: Uint128, msg: Option<Binary>) -> StdResult<Response> {
    let state = load_state(deps.as_ref())?;

    let payload = msg.ok_or_else(|| StdError::generic_err("no swap request"))?;
    let RouterInvokeMsg::SwapTokensForExact { recipient, .. } = from_binary(&payload)?;
    let recipient = recipient.ok_or_else(|| StdError::generic_err("no recipient"))?;

    deps.storage.set(
        FLIGHT_KEY,
        &to_vec(&Flight {
            recipient,
            amount_in: amount,
        })?,
    );

    let mut response = Response::new();

    // Re-entrancy is produced before the hop, so the executor sees it while
    // its own `Pending` is set.
    if let Behaviour::Reenter { executor, token } = &state.behaviour {
        response = response.add_message(WasmMsg::Execute {
            contract_addr: token.address.clone(),
            code_hash: token.code_hash.clone(),
            msg: to_binary(&Snip20ExecuteMsg::Send {
                recipient: executor.address.clone(),
                recipient_code_hash: Some(executor.code_hash.clone()),
                amount: Uint128::one(),
                msg: Some(to_binary(&ReceiveMsg::BuyCredit {
                    grantee: "interloper".into(),
                    min_out: Some(Uint128::one()),
                })?),
                memo: None,
                padding: None,
            })?,
            funds: vec![],
        });
    }

    let fail = matches!(
        state.behaviour,
        Behaviour::Fail | Behaviour::SwallowFailure
    );

    Ok(response.add_submessage(SubMsg::reply_always(
        WasmMsg::Execute {
            contract_addr: env.contract.address.to_string(),
            code_hash: env.contract.code_hash.clone(),
            msg: to_binary(&ExecuteMsg::Hop { fail })?,
            funds: vec![],
        },
        HOP_REPLY,
    )))
}

/// The router's own reply. `reply_always`, so it gets to decide what a failed
/// hop means — which is precisely why the executor cannot take this contract's
/// word for what it delivered.
#[entry_point]
pub fn reply(deps: DepsMut, env: Env, msg: Reply) -> StdResult<Response> {
    if msg.id != HOP_REPLY {
        return Err(StdError::generic_err("unexpected reply"));
    }

    let state = load_state(deps.as_ref())?;
    let flight: Flight = deps
        .storage
        .get(FLIGHT_KEY)
        .ok_or_else(|| StdError::generic_err("no trade in progress"))
        .and_then(|raw| from_slice(&raw))?;
    deps.storage.remove(FLIGHT_KEY);

    if let SubMsgResult::Err(err) = &msg.result {
        return match state.behaviour {
            // Report success anyway, delivering nothing. The executor should
            // still catch this, because it measures its own balance instead of
            // believing us.
            Behaviour::SwallowFailure => Ok(Response::new()
                .add_attribute("action", "swallowed")
                .add_attribute("swallowed", err.clone())),
            _ => Err(StdError::generic_err(format!("hop failed: {err}"))),
        };
    }

    let rate = match state.behaviour {
        Behaviour::Pay { rate_bps } => rate_bps,
        _ => 10_000,
    };

    let payout = flight.amount_in.multiply_ratio(rate, 10_000u64);

    // How much this contract actually has to give. Paying out more than it
    // holds would just fail in the token, which is not the failure under test.
    let held: Uint128 = match deps.querier.query_wasm_smart::<Snip20QueryAnswer>(
        state.payout_token.code_hash.clone(),
        state.payout_token.address.clone(),
        &Snip20QueryMsg::Balance {
            address: env.contract.address.to_string(),
            key: state.viewing_key.clone(),
        },
    )? {
        Snip20QueryAnswer::Balance { amount } => amount,
        Snip20QueryAnswer::ViewingKeyError { msg } => {
            return Err(StdError::generic_err(format!("mock router key: {msg}")))
        }
    };

    let payout = payout.min(held);
    if payout.is_zero() {
        return Ok(Response::new().add_attribute("action", "nothing_to_pay"));
    }

    // Plain Send with no code hash, exactly as `create_send_msg` builds it in
    // the real router. An executor that has not registered a receive callback
    // therefore does not get invoked by this.
    Ok(Response::new()
        .add_message(WasmMsg::Execute {
            contract_addr: state.payout_token.address.clone(),
            code_hash: state.payout_token.code_hash.clone(),
            msg: to_binary(&Snip20ExecuteMsg::Send {
                recipient: flight.recipient,
                recipient_code_hash: None,
                amount: payout,
                msg: None,
                memo: None,
                padding: None,
            })?,
            funds: vec![],
        })
        .add_attribute("action", "paid")
        .add_attribute("amount", payout))
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Behaviour {} => to_binary(&load_state(deps)?.behaviour),
    }
}
