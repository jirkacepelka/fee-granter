use cosmwasm_std::{
    entry_point, to_binary, Addr, Binary, CosmosMsg, Deps, DepsMut, Env, MessageInfo, Response,
    StdError, StdResult, Uint128,
};

use crate::msg::{ExecuteMsg, InstantiateMsg, IssuedResponse, QueryMsg, SolvencyResponse};
use crate::proto;
use crate::state::{outstanding, outstanding_read, read_issued, write_issued, Outstanding};

pub const DENOM: &str = "uscrt";

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> StdResult<Response> {
    outstanding(deps.storage).save(&Outstanding { total: Uint128::zero() })?;
    Ok(Response::new().add_attribute("action", "instantiate"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> StdResult<Response> {
    match msg {
        ExecuteMsg::Grant { grantee } => grant(deps, env, info, grantee),
    }
}

/// Take the SCRT sent with this message and grant `grantee` the same amount as
/// a fee allowance, payable from this contract.
fn grant(deps: DepsMut, env: Env, info: MessageInfo, grantee: String) -> StdResult<Response> {
    let grantee = deps.api.addr_validate(&grantee)?;

    let paid: Uint128 = info
        .funds
        .iter()
        .filter(|coin| coin.denom == DENOM)
        .map(|coin| coin.amount)
        .sum();

    if paid.is_zero() {
        return Err(StdError::generic_err("send SCRT with this message"));
    }

    // x/feegrant does not reserve funds - a grant is a promise, not an escrow.
    // Without this check the contract could promise more than it holds and the
    // shortfall would surface as a stranger's transaction failing.
    let balance = deps
        .querier
        .query_balance(env.contract.address.clone(), DENOM)?
        .amount;
    let committed = outstanding_read(deps.storage).load()?.total;
    let would_owe = committed.checked_add(paid)?;
    if would_owe > balance {
        return Err(StdError::generic_err(format!(
            "not solvent: would owe {} with {} on hand",
            would_owe, balance
        )));
    }

    let granter = env.contract.address.to_string();
    let previous = read_issued(deps.storage, &grantee);
    let total = previous.checked_add(paid)?;

    let mut messages: Vec<CosmosMsg> = Vec::with_capacity(2);

    // MsgGrantAllowance is rejected when a grant already exists and there is no
    // update message, so topping up means revoking first. Both messages ride in
    // one transaction, so the grant is never left revoked.
    if !previous.is_zero() {
        messages.push(revoke_msg(&granter, grantee.as_str()));
    }
    messages.push(grant_msg(&granter, grantee.as_str(), total));

    outstanding(deps.storage).save(&Outstanding { total: would_owe })?;
    write_issued(deps.storage, &grantee, total);

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "grant")
        .add_attribute("grantee", grantee.as_str())
        .add_attribute("added", paid)
        .add_attribute("total", total))
}

/// The contract is the granter, so `granter` is its own address. The compute
/// module requires every signer of a dispatched message to be the contract,
/// which is exactly what this satisfies.
fn grant_msg(granter: &str, grantee: &str, amount: Uint128) -> CosmosMsg {
    let allowance = proto::BasicAllowance {
        spend_limit: vec![proto::Coin {
            denom: DENOM.to_string(),
            amount: amount.to_string(),
        }],
    };

    let msg = proto::MsgGrantAllowance {
        granter: granter.to_string(),
        grantee: grantee.to_string(),
        allowance: Some(proto::Any {
            type_url: proto::BASIC_ALLOWANCE.to_string(),
            value: proto::encode(&allowance),
        }),
    };

    CosmosMsg::Stargate {
        type_url: proto::MSG_GRANT_ALLOWANCE.to_string(),
        value: Binary(proto::encode(&msg)),
    }
}

fn revoke_msg(granter: &str, grantee: &str) -> CosmosMsg {
    let msg = proto::MsgRevokeAllowance {
        granter: granter.to_string(),
        grantee: grantee.to_string(),
    };

    CosmosMsg::Stargate {
        type_url: proto::MSG_REVOKE_ALLOWANCE.to_string(),
        value: Binary(proto::encode(&msg)),
    }
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Solvency {} => to_binary(&SolvencyResponse {
            outstanding: outstanding_read(deps.storage).load()?.total,
            balance: deps
                .querier
                .query_balance(env.contract.address, DENOM)?
                .amount,
        }),
        QueryMsg::Issued { grantee } => {
            let grantee: Addr = deps.api.addr_validate(&grantee)?;
            let amount = read_issued(deps.storage, &grantee);
            to_binary(&IssuedResponse { grantee, amount })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{
        mock_dependencies_with_balance, mock_env, mock_info, MockApi, MockQuerier,
    };
    use cosmwasm_std::{coins, from_binary, MemoryStorage, OwnedDeps};
    use prost::Message;

    /// Pull the Stargate payload back out and decode it, so the hand-rolled
    /// protobuf is checked against the same wire format the chain will parse.
    fn decode_grant(msg: &CosmosMsg) -> proto::MsgGrantAllowance {
        match msg {
            CosmosMsg::Stargate { type_url, value } => {
                assert_eq!(type_url, proto::MSG_GRANT_ALLOWANCE);
                proto::MsgGrantAllowance::decode(value.as_slice()).unwrap()
            }
            other => panic!("expected a Stargate grant, got {:?}", other),
        }
    }

    fn setup(balance: u128) -> (OwnedDeps<MemoryStorage, MockApi, MockQuerier>, Env) {
        let mut deps = mock_dependencies_with_balance(&coins(balance, DENOM));
        let env = mock_env();
        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("creator", &[]),
            InstantiateMsg {},
        )
        .unwrap();
        (deps, env)
    }

    #[test]
    fn grants_one_to_one_with_what_was_paid() {
        let (mut deps, env) = setup(1_000_000);
        let res = execute(
            deps.as_mut(),
            env.clone(),
            mock_info("buyer", &coins(1_000_000, DENOM)),
            ExecuteMsg::Grant { grantee: "grantee".into() },
        )
        .unwrap();

        assert_eq!(res.messages.len(), 1, "a first grant needs no revoke");
        let grant = decode_grant(&res.messages[0].msg);

        assert_eq!(grant.granter, env.contract.address.to_string(), "contract must be the granter");
        assert_eq!(grant.grantee, "grantee");

        let any = grant.allowance.unwrap();
        assert_eq!(any.type_url, proto::BASIC_ALLOWANCE);
        let allowance = proto::BasicAllowance::decode(any.value.as_slice()).unwrap();
        assert_eq!(allowance.spend_limit.len(), 1);
        assert_eq!(allowance.spend_limit[0].denom, DENOM);
        assert_eq!(allowance.spend_limit[0].amount, "1000000", "1:1 with what was paid");
    }

    #[test]
    fn topping_up_revokes_first_and_grants_the_new_total() {
        let (mut deps, env) = setup(3_000_000);
        let info = mock_info("buyer", &coins(1_000_000, DENOM));
        execute(deps.as_mut(), env.clone(), info, ExecuteMsg::Grant { grantee: "grantee".into() }).unwrap();

        let res = execute(
            deps.as_mut(),
            env.clone(),
            mock_info("buyer", &coins(2_000_000, DENOM)),
            ExecuteMsg::Grant { grantee: "grantee".into() },
        )
        .unwrap();

        // MsgGrantAllowance fails on an existing grant, so the revoke must lead.
        assert_eq!(res.messages.len(), 2);
        match &res.messages[0].msg {
            CosmosMsg::Stargate { type_url, .. } => assert_eq!(type_url, proto::MSG_REVOKE_ALLOWANCE),
            other => panic!("expected a revoke first, got {:?}", other),
        }

        let any = decode_grant(&res.messages[1].msg).allowance.unwrap();
        let allowance = proto::BasicAllowance::decode(any.value.as_slice()).unwrap();
        assert_eq!(allowance.spend_limit[0].amount, "3000000", "re-granted at the new total");
    }

    #[test]
    fn refuses_to_promise_more_than_it_holds() {
        // Balance covers the first grant only; the second would over-commit.
        let (mut deps, env) = setup(1_000_000);
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info("buyer", &coins(1_000_000, DENOM)),
            ExecuteMsg::Grant { grantee: "grantee-alpha".into() },
        )
        .unwrap();

        let err = execute(
            deps.as_mut(),
            env,
            mock_info("buyer", &coins(1_000_000, DENOM)),
            ExecuteMsg::Grant { grantee: "grantee-bravo".into() },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("not solvent"), "got {err}");
    }

    #[test]
    fn rejects_a_message_with_no_funds() {
        let (mut deps, env) = setup(1_000_000);
        let err = execute(
            deps.as_mut(),
            env,
            mock_info("buyer", &[]),
            ExecuteMsg::Grant { grantee: "grantee".into() },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("send SCRT"), "got {err}");
    }

    #[test]
    fn solvency_query_reports_both_sides() {
        let (mut deps, env) = setup(5_000_000);
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info("buyer", &coins(2_000_000, DENOM)),
            ExecuteMsg::Grant { grantee: "grantee".into() },
        )
        .unwrap();

        let res: SolvencyResponse =
            from_binary(&query(deps.as_ref(), env, QueryMsg::Solvency {}).unwrap()).unwrap();
        assert_eq!(res.outstanding, Uint128::new(2_000_000));
        assert_eq!(res.balance, Uint128::new(5_000_000));
    }
}
