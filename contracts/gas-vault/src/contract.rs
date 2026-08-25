use cosmwasm_std::{
    entry_point, to_binary, to_vec, Addr, Binary, ContractResult, CosmosMsg, Deps, DepsMut, Empty,
    Env, MessageInfo, QueryRequest, Response, StdError, StdResult, SystemResult, Uint128,
};
use prost::Message as _;

use crate::msg::{
    ExecuteMsg, InstantiateMsg, IssuedResponse, MigrateMsg, QueryMsg, RemainingResponse,
    StatusResponse,
};
use crate::proto;
use crate::state::{read_issued, write_issued};

pub const DENOM: &str = "uscrt";

#[entry_point]
pub fn instantiate(
    _deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: InstantiateMsg,
) -> StdResult<Response> {
    Ok(Response::new().add_attribute("action", "instantiate"))
}

/// Nothing to do: no state layout has changed. It exists because a contract
/// without this entry point can never be migrated, and this one leans on a
/// query the chain reserves the right to take off its allow-list.
#[entry_point]
pub fn migrate(_deps: DepsMut, _env: Env, _msg: MigrateMsg) -> StdResult<Response> {
    Ok(Response::new().add_attribute("action", "migrate"))
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
///
/// The contract cannot end up owing more than it holds, and it needs no ledger
/// to guarantee that. Every uscrt paid in raises its balance and the allowances
/// it has issued by the same amount, and every uscrt of granted fee that gets
/// spent lowers both by the same amount, because x/feegrant charges the fee to
/// the granter. What it does have to get right is the top-up below.
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

    let granter = env.contract.address.to_string();
    let stored = read_issued(deps.storage, &grantee);
    let held = held_by(deps.as_ref(), &granter, &grantee, stored)?;
    let total = held.checked_add(paid)?;

    let mut messages: Vec<CosmosMsg> = Vec::with_capacity(2);

    // MsgGrantAllowance is rejected when a grant already exists and there is no
    // update message, so topping up means revoking first. Both messages ride in
    // one transaction, so the grant is never left revoked. Someone holding
    // nothing has no grant to revoke: x/feegrant deletes one it has drained.
    if !held.is_zero() {
        messages.push(revoke_msg(&granter, grantee.as_str()));
    }
    messages.push(grant_msg(&granter, grantee.as_str(), total));

    write_issued(deps.storage, &grantee, total);

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "grant")
        .add_attribute("grantee", grantee.as_str())
        .add_attribute("added", paid)
        .add_attribute("total", total))
}

/// What `grantee` still has, which is the figure a top-up must build on.
///
/// Re-granting the amount this contract issued last time would re-promise fees
/// the grantee has since spent, and that is the one way it could come to owe
/// more than it holds. So the live figure is read from x/feegrant, and when it
/// cannot be read the top-up is refused rather than guessed at.
fn held_by(deps: Deps, granter: &str, grantee: &Addr, stored: Uint128) -> StdResult<Uint128> {
    if stored.is_zero() {
        // Never granted to, so there is no grant to read. Worth short-circuiting
        // rather than tidying away: it keeps the commonest case, a first-time
        // buyer, working even if the query stops being allowed from a contract.
        return Ok(Uint128::zero());
    }

    match remaining_allowance(deps, granter, grantee.as_str()) {
        Ok(held) => Ok(held),
        // Drained to nothing, or revoked. x/feegrant deletes the grant either
        // way, so this is a definite zero and not a failure to read one.
        Err(err) if is_absent(&err) => Ok(Uint128::zero()),
        Err(err) => Err(err),
    }
}

fn is_absent(err: &StdError) -> bool {
    format!("{err}").contains(proto::NOT_FOUND)
}

/// Ask x/feegrant what is left of this contract's grant to `grantee`.
///
/// Secret allows this query from a contract but not `AllowancesByGranter` -
/// only O(1) lookups are on the allow-list - so a contract can check one
/// grantee at a time and never total up its own book.
fn remaining_allowance(deps: Deps, granter: &str, grantee: &str) -> StdResult<Uint128> {
    let request = proto::QueryAllowanceRequest {
        granter: granter.to_string(),
        grantee: grantee.to_string(),
    };

    // Not `querier.query`, which would try to read the answer as JSON: a
    // Stargate query answers in protobuf. Going through the raw call also keeps
    // the chain's own error text intact, which is what `is_absent` reads.
    let call = to_vec(&QueryRequest::<Empty>::Stargate {
        path: proto::QUERY_ALLOWANCE.to_string(),
        data: Binary(proto::encode(&request)),
    })?;
    let raw = match deps.querier.raw_query(&call) {
        SystemResult::Ok(ContractResult::Ok(value)) => value,
        SystemResult::Ok(ContractResult::Err(err)) => return Err(StdError::generic_err(err)),
        SystemResult::Err(err) => {
            return Err(StdError::generic_err(format!("allowance query failed: {err}")))
        }
    };

    let any = proto::QueryAllowanceResponse::decode(raw.as_slice())
        .map_err(|err| StdError::generic_err(format!("undecodable allowance response: {err}")))?
        .allowance
        .and_then(|grant| grant.allowance)
        .ok_or_else(|| StdError::generic_err("allowance missing from the response"))?;

    if any.type_url != proto::BASIC_ALLOWANCE {
        return Err(StdError::generic_err(format!(
            "expected a BasicAllowance, got {}",
            any.type_url
        )));
    }

    proto::BasicAllowance::decode(any.value.as_slice())
        .map_err(|err| StdError::generic_err(format!("undecodable allowance: {err}")))?
        .spend_limit
        .iter()
        .filter(|coin| coin.denom == DENOM)
        .try_fold(Uint128::zero(), |sum, coin| {
            let amount = coin
                .amount
                .parse::<u128>()
                .map_err(|_| StdError::generic_err(format!("unreadable amount {}", coin.amount)))?;
            sum.checked_add(Uint128::new(amount)).map_err(StdError::from)
        })
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
        QueryMsg::Status {} => to_binary(&StatusResponse {
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
        QueryMsg::Remaining { grantee } => {
            let grantee: Addr = deps.api.addr_validate(&grantee)?;
            let stored = read_issued(deps.storage, &grantee);
            let amount = held_by(deps, &env.contract.address.to_string(), &grantee, stored).ok();
            to_binary(&RemainingResponse { grantee, amount })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_env, mock_info, MockApi, MockQuerier, MOCK_CONTRACT_ADDR};
    use cosmwasm_std::{
        coins, from_binary, from_slice, ContractResult, Empty, MemoryStorage, OwnedDeps, Querier,
        QuerierResult, SystemResult,
    };
    use prost::Message;
    use std::collections::HashMap;
    use std::marker::PhantomData;

    /// A querier that answers the feegrant allowance query the way the chain
    /// does, including the two failures the contract has to tell apart: a grant
    /// that is not there, and a query it cannot make.
    struct ChainQuerier {
        bank: MockQuerier,
        /// What x/feegrant reports as still spendable. A missing entry is a
        /// missing grant, which the chain reports as an error, not as zero.
        remaining: HashMap<String, u128>,
        /// Whether the allowance query can be made at all.
        reachable: bool,
    }

    impl Querier for ChainQuerier {
        fn raw_query(&self, bin_request: &[u8]) -> QuerierResult {
            if let Ok(QueryRequest::Stargate { path, data }) = from_slice::<QueryRequest<Empty>>(bin_request) {
                if path == proto::QUERY_ALLOWANCE {
                    return self.answer_allowance(&data);
                }
            }
            self.bank.raw_query(bin_request)
        }
    }

    impl ChainQuerier {
        fn answer_allowance(&self, data: &Binary) -> QuerierResult {
            if !self.reachable {
                return SystemResult::Ok(ContractResult::Err(format!(
                    "query path '{}' is not allowed from the contract",
                    proto::QUERY_ALLOWANCE
                )));
            }

            let request = proto::QueryAllowanceRequest::decode(data.as_slice()).unwrap();
            let held = match self.remaining.get(&request.grantee) {
                Some(held) => *held,
                // How cosmos-sdk words it, wrapped by the gRPC layer.
                None => {
                    return SystemResult::Ok(ContractResult::Err(format!(
                        "rpc error: code = Internal desc = {}",
                        proto::NOT_FOUND
                    )))
                }
            };

            let allowance = proto::BasicAllowance {
                spend_limit: vec![proto::Coin {
                    denom: DENOM.to_string(),
                    amount: held.to_string(),
                }],
            };
            let response = proto::QueryAllowanceResponse {
                allowance: Some(proto::Grant {
                    granter: MOCK_CONTRACT_ADDR.to_string(),
                    grantee: request.grantee,
                    allowance: Some(proto::Any {
                        type_url: proto::BASIC_ALLOWANCE.to_string(),
                        value: proto::encode(&allowance),
                    }),
                }),
            };
            SystemResult::Ok(ContractResult::Ok(Binary(proto::encode(&response))))
        }
    }

    type Deps = OwnedDeps<MemoryStorage, MockApi, ChainQuerier>;

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

    fn granted_amount(msg: &CosmosMsg) -> String {
        let any = decode_grant(msg).allowance.unwrap();
        assert_eq!(any.type_url, proto::BASIC_ALLOWANCE);
        let allowance = proto::BasicAllowance::decode(any.value.as_slice()).unwrap();
        assert_eq!(allowance.spend_limit.len(), 1);
        assert_eq!(allowance.spend_limit[0].denom, DENOM);
        allowance.spend_limit[0].amount.clone()
    }

    fn setup(balance: u128) -> (Deps, Env) {
        let deps = OwnedDeps {
            storage: MemoryStorage::new(),
            api: MockApi::default(),
            querier: ChainQuerier {
                bank: MockQuerier::new(&[(MOCK_CONTRACT_ADDR, &coins(balance, DENOM))]),
                remaining: HashMap::new(),
                reachable: true,
            },
            custom_query_type: PhantomData,
        };
        let env = mock_env();
        let mut deps = deps;
        instantiate(deps.as_mut(), env.clone(), mock_info("creator", &[]), InstantiateMsg {}).unwrap();
        (deps, env)
    }

    fn buy(deps: &mut Deps, env: &Env, grantee: &str, amount: u128) -> StdResult<Response> {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info("buyer", &coins(amount, DENOM)),
            ExecuteMsg::Grant { grantee: grantee.into() },
        )
    }

    #[test]
    fn grants_one_to_one_with_what_was_paid() {
        let (mut deps, env) = setup(1_000_000);
        let res = buy(&mut deps, &env, "grantee", 1_000_000).unwrap();

        assert_eq!(res.messages.len(), 1, "a first grant needs no revoke");
        let grant = decode_grant(&res.messages[0].msg);
        assert_eq!(grant.granter, env.contract.address.to_string(), "contract must be the granter");
        assert_eq!(grant.grantee, "grantee");
        assert_eq!(granted_amount(&res.messages[0].msg), "1000000", "1:1 with what was paid");
    }

    #[test]
    fn topping_up_revokes_first_and_grants_the_new_total() {
        let (mut deps, env) = setup(3_000_000);
        buy(&mut deps, &env, "grantee", 1_000_000).unwrap();
        deps.querier.remaining.insert("grantee".into(), 1_000_000);

        let res = buy(&mut deps, &env, "grantee", 2_000_000).unwrap();

        // MsgGrantAllowance fails on an existing grant, so the revoke must lead.
        assert_eq!(res.messages.len(), 2);
        match &res.messages[0].msg {
            CosmosMsg::Stargate { type_url, .. } => assert_eq!(type_url, proto::MSG_REVOKE_ALLOWANCE),
            other => panic!("expected a revoke first, got {:?}", other),
        }
        assert_eq!(granted_amount(&res.messages[1].msg), "3000000", "re-granted at the new total");
    }

    #[test]
    fn tops_up_from_what_is_left_not_from_what_was_issued() {
        // The regression this contract was rewritten for. The grantee spent
        // 600_000 of their first million; re-granting the million would promise
        // money that has already left the contract, so the top-up has to build
        // on what x/feegrant says is left.
        let (mut deps, env) = setup(1_000_000);
        buy(&mut deps, &env, "grantee", 1_000_000).unwrap();

        deps.querier.remaining.insert("grantee".into(), 400_000);
        deps.querier.bank.update_balance(MOCK_CONTRACT_ADDR, coins(1_400_000, DENOM));

        let res = buy(&mut deps, &env, "grantee", 1_000_000).unwrap();
        assert_eq!(
            granted_amount(&res.messages[1].msg),
            "1400000",
            "400_000 left plus 1_000_000 paid, matching the balance exactly"
        );
    }

    #[test]
    fn a_drained_grant_starts_over_rather_than_failing() {
        // Spent to the last uscrt, so x/feegrant has deleted the grant. Nothing
        // is owed and there is nothing to revoke.
        let (mut deps, env) = setup(1_000_000);
        buy(&mut deps, &env, "grantee", 1_000_000).unwrap();

        deps.querier.bank.update_balance(MOCK_CONTRACT_ADDR, coins(500_000, DENOM));
        let res = buy(&mut deps, &env, "grantee", 500_000).unwrap();

        assert_eq!(res.messages.len(), 1, "a vanished grant needs no revoke");
        assert_eq!(granted_amount(&res.messages[0].msg), "500000");
    }

    #[test]
    fn refuses_to_top_up_when_the_chain_cannot_be_asked() {
        let (mut deps, env) = setup(2_000_000);
        buy(&mut deps, &env, "grantee", 1_000_000).unwrap();

        deps.querier.reachable = false;
        let err = buy(&mut deps, &env, "grantee", 1_000_000).unwrap_err();
        assert!(format!("{err}").contains("not allowed from the contract"), "got {err}");
    }

    #[test]
    fn a_first_grant_needs_no_query_at_all() {
        // So the allow-list disappearing cannot stop new buyers being served.
        let (mut deps, env) = setup(1_000_000);
        deps.querier.reachable = false;

        let res = buy(&mut deps, &env, "newcomer", 1_000_000).unwrap();
        assert_eq!(granted_amount(&res.messages[0].msg), "1000000");
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
    fn status_reports_the_balance_that_backs_every_grant() {
        let (mut deps, env) = setup(5_000_000);
        buy(&mut deps, &env, "grantee", 2_000_000).unwrap();

        let res: StatusResponse =
            from_binary(&query(deps.as_ref(), env, QueryMsg::Status {}).unwrap()).unwrap();
        assert_eq!(res.balance, Uint128::new(5_000_000));
    }

    #[test]
    fn remaining_says_unknown_rather_than_zero_when_it_cannot_look() {
        let (mut deps, env) = setup(1_000_000);
        buy(&mut deps, &env, "grantee", 1_000_000).unwrap();
        deps.querier.reachable = false;

        let res: RemainingResponse = from_binary(
            &query(deps.as_ref(), env, QueryMsg::Remaining { grantee: "grantee".into() }).unwrap(),
        )
        .unwrap();
        assert_eq!(res.amount, None, "an unreadable allowance is not an empty one");
    }
}
