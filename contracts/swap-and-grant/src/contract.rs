//! swap-and-grant — buy gas credit from `contracts/gas-vault` with a SNIP-20.
//!
//! The vault takes native uscrt as `info.funds` and nothing else. Holding sSCRT
//! or stkd-SCRT therefore means unwrapping or selling first, in a separate
//! transaction. That cannot be collapsed into one signed transaction by hand:
//! `funds` and `Redeem.amount` are fixed in the signed body, so message three
//! cannot use what message two produced. Only a contract, reading the value at
//! run time in `reply`, can.
//!
//! Two ways in, sharing one tail:
//!
//! - **sSCRT** — no swap and no reply. The amount is already known from
//!   `Receive`, and redeeming is one for one.
//! - **a routed token** (stkd-SCRT) — one `reply_on_success` hop through the
//!   ShadeSwap router, then the same tail.
//!
//! The vault is not modified and not trusted with anything new; this contract
//! is just another address paying it.

use cosmwasm_std::{
    coins, entry_point, from_binary, to_binary, Addr, BankMsg, Binary, CosmosMsg, Deps, DepsMut,
    Env, MessageInfo, Reply, Response, StdError, StdResult, SubMsg, Uint128, WasmMsg,
};

use crate::msg::{
    BalancesResponse, ConfigResponse, ContractInfo, ExecuteMsg, GasVaultExecuteMsg, Hop,
    InstantiateMsg, QueryMsg, ReceiveMsg, RouteInput, RouterInvokeMsg, RoutesResponse,
    Snip20ExecuteMsg, Snip20QueryAnswer, Snip20QueryMsg, TokenBalance,
};
use crate::state::{
    clear_pending, load_config, load_pending, save_config, save_pending, Config, Contract, Pending,
    Route,
};

pub const DENOM: &str = "uscrt";

/// The only reply this contract uses. There is exactly one, and it is
/// `on_success`: see `reply` for why that matters.
pub const SWAP_REPLY: u64 = 1;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> StdResult<Response> {
    let admin = match msg.admin {
        Some(admin) => Some(deps.api.addr_validate(&admin)?),
        None => Some(info.sender),
    };

    let config = Config {
        gas_vault: validate(deps.as_ref(), &msg.gas_vault)?,
        sscrt: validate(deps.as_ref(), &msg.sscrt)?,
        viewing_key: msg.viewing_key,
        admin,
        router: msg.router.as_ref().map(|r| validate(deps.as_ref(), r)).transpose()?,
        routes: msg
            .routes
            .iter()
            .map(|route| build_route(deps.as_ref(), route))
            .collect::<StdResult<Vec<_>>>()?,
    };

    // The contract has to be able to read its own balances and cannot sign a
    // permit, so it sets a key on itself — the same thing the ShadeSwap router
    // does. One per token whose balance is ever read.
    //
    // Note what is deliberately NOT here: RegisterReceive. A SNIP-20 only
    // invokes a recipient's Receive when the Send carries a code hash or the
    // recipient has registered one (snip20-reference-impl,
    // `try_add_receiver_api_callback`). The router delivers swap output with
    // `recipient_code_hash: None`, so staying unregistered keeps that delivery
    // from re-entering this contract at all. The buyer's own Send names the
    // code hash explicitly instead.
    let mut messages = vec![set_viewing_key(&config.sscrt, &config.viewing_key)?];
    for route in &config.routes {
        messages.push(set_viewing_key(&route.token, &config.viewing_key)?);
    }

    save_config(deps.storage, &config)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "instantiate")
        .add_attribute("contract", env.contract.address))
}

#[entry_point]
pub fn execute(deps: DepsMut, env: Env, info: MessageInfo, msg: ExecuteMsg) -> StdResult<Response> {
    match msg {
        ExecuteMsg::Receive {
            amount, msg: payload, ..
        } => receive(deps, env, info, amount, payload),
        ExecuteMsg::SetRouter { router } => set_router(deps, info, router),
        ExecuteMsg::SetRoute { token, path } => set_route(deps, info, token, path),
        ExecuteMsg::SetCodeHashes { gas_vault, sscrt } => {
            set_code_hashes(deps, info, gas_vault, sscrt)
        }
        ExecuteMsg::SetAdmin { admin } => set_admin(deps, info, admin),
        ExecuteMsg::SweepToVault {} => sweep(deps, env),
    }
}

/// Tokens arriving. `info.sender` is the token contract, and it is the only
/// thing authorising anything here — `sender` and `from` in the payload are
/// the token's account of who moved what, and are not used to decide anything.
fn receive(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    amount: Uint128,
    payload: Option<Binary>,
) -> StdResult<Response> {
    let config = load_config(deps.storage)?;

    // A SNIP-20 Send with no payload. This contract never registers a receive
    // callback, so the router's delivery of swap output should not reach here
    // — but anyone may Send with an explicit code hash, and erroring would let
    // a stranger break every purchase in flight. Accept and ignore: the tokens
    // are then sweepable to the vault, and nothing has been promised.
    let Some(payload) = payload else {
        return Ok(Response::new().add_attribute("action", "ignored_empty_payload"));
    };

    let ReceiveMsg::BuyCredit { grantee, min_out } = from_binary(&payload)?;
    let grantee = deps.api.addr_validate(&grantee)?;

    if amount.is_zero() {
        return Err(StdError::generic_err("cannot buy credit with nothing"));
    }

    if info.sender == config.sscrt.address {
        buy_with_sscrt(&config, grantee, amount, min_out)
    } else if config.route_for(&info.sender).is_some() {
        buy_with_swap(deps, env, &config, info.sender, grantee, amount, min_out)
    } else {
        // Without this, anyone could deploy a worthless SNIP-20 and call
        // Receive claiming any amount. The redeem would go to the real sSCRT
        // and fail — unless stray sSCRT happened to be sitting here, which
        // they would then walk off with as credit.
        Err(StdError::generic_err(format!(
            "{} is not accepted here",
            info.sender
        )))
    }
}

/// sSCRT: redeem and grant, nothing else.
///
/// The amount is known, `Redeem` is one for one, and both messages are ordinary
/// ones — so they run in order after this call returns, the native SCRT lands
/// before the vault reaches for `funds`, and any failure takes the whole
/// transaction with it, including the buyer's original Send.
fn buy_with_sscrt(
    config: &Config,
    grantee: Addr,
    amount: Uint128,
    min_out: Option<Uint128>,
) -> StdResult<Response> {
    if min_out.is_some() {
        // Nothing here can move the price, so there is nothing to guarantee.
        // Quietly ignoring a slippage bound the caller asked for would be
        // worse than refusing it.
        return Err(StdError::generic_err(
            "min_out does not apply when paying with sSCRT",
        ));
    }

    Ok(Response::new()
        .add_messages(redeem_and_grant(config, &grantee, amount)?)
        .add_attribute("action", "buy_with_sscrt")
        .add_attribute("grantee", grantee)
        .add_attribute("amount", amount))
}

/// A routed token: swap to sSCRT, then the same tail from `reply`.
#[allow(clippy::too_many_arguments)]
fn buy_with_swap(
    deps: DepsMut,
    env: Env,
    config: &Config,
    token: Addr,
    grantee: Addr,
    amount: Uint128,
    min_out: Option<Uint128>,
) -> StdResult<Response> {
    // Foreign code runs between here and the reply. If anything re-entered
    // this path it would overwrite the `before` snapshot and the difference
    // would come out meaningless, so nesting is refused outright.
    if load_pending(deps.storage)?.is_some() {
        return Err(StdError::generic_err("a purchase is already in flight"));
    }

    let router = config
        .router
        .clone()
        .ok_or_else(|| StdError::generic_err("no router is configured, so only sSCRT is accepted"))?;

    let route = config
        .route_for(&token)
        .ok_or_else(|| StdError::generic_err("no route for that token"))?
        .clone();

    let min_out =
        min_out.ok_or_else(|| StdError::generic_err("min_out is required when swapping"))?;
    if min_out.is_zero() {
        return Err(StdError::generic_err("min_out must be greater than zero"));
    }

    let before = sscrt_balance(deps.as_ref(), &env, config)?;

    save_pending(
        deps.storage,
        &Pending {
            grantee: grantee.clone(),
            before,
            min_out,
        },
    )?;

    let swap = WasmMsg::Execute {
        contract_addr: route.token.address.to_string(),
        code_hash: route.token.code_hash.clone(),
        msg: to_binary(&Snip20ExecuteMsg::Send {
            recipient: router.address.to_string(),
            recipient_code_hash: Some(router.code_hash.clone()),
            amount,
            msg: Some(to_binary(&RouterInvokeMsg::SwapTokensForExact {
                path: route.path.clone(),
                expected_return: Some(min_out),
                recipient: Some(env.contract.address.to_string()),
            })?),
            memo: None,
            padding: None,
        })?,
        funds: vec![],
    };

    // on_success, not always: a failed swap then aborts the transaction by
    // itself and returns the buyer's tokens. `reply_always` would mean
    // catching the error and re-raising it by hand, which is more code and
    // more ways to get it wrong.
    Ok(Response::new()
        .add_submessage(SubMsg::reply_on_success(swap, SWAP_REPLY))
        .add_attribute("action", "buy_with_swap")
        .add_attribute("grantee", grantee)
        .add_attribute("offered", amount))
}

/// After the swap. The output is measured, not read from the router's answer.
///
/// The router drives its own hops with `SubMsg::reply_always`, so its handler
/// decides whether a failed hop propagates or is swallowed. A swallowed one
/// would come back here looking like success with nothing delivered. Measuring
/// this contract's own balance either side of the swap, and checking the result
/// against `min_out` again, catches that; trusting the router's `expected_return`
/// would not.
#[entry_point]
pub fn reply(deps: DepsMut, env: Env, msg: Reply) -> StdResult<Response> {
    if msg.id != SWAP_REPLY {
        return Err(StdError::generic_err(format!("unexpected reply {}", msg.id)));
    }

    let config = load_config(deps.storage)?;
    let pending = load_pending(deps.storage)?
        .ok_or_else(|| StdError::generic_err("a reply arrived with no purchase in flight"))?;

    let after = sscrt_balance(deps.as_ref(), &env, &config)?;
    let received = after.checked_sub(pending.before).map_err(|_| {
        // The balance went down across a swap that was supposed to fill it.
        // Whatever happened, it is not something to carry on from.
        StdError::generic_err("sSCRT balance fell during the swap")
    })?;

    if received < pending.min_out {
        return Err(StdError::generic_err(format!(
            "swap returned {} sSCRT, less than the {} asked for",
            received, pending.min_out
        )));
    }

    clear_pending(deps.storage);

    Ok(Response::new()
        .add_messages(redeem_and_grant(&config, &pending.grantee, received)?)
        .add_attribute("action", "swapped")
        .add_attribute("grantee", pending.grantee)
        .add_attribute("received", received))
}

/// The shared tail. Ordinary messages, never submessages: there is no reply
/// handler on them, so a failure propagates and takes the transaction down
/// rather than being observed and continued past. That is what makes "the swap
/// went through but the grant did not" unreachable.
fn redeem_and_grant(
    config: &Config,
    grantee: &Addr,
    amount: Uint128,
) -> StdResult<Vec<CosmosMsg>> {
    Ok(vec![
        WasmMsg::Execute {
            contract_addr: config.sscrt.address.to_string(),
            code_hash: config.sscrt.code_hash.clone(),
            msg: to_binary(&Snip20ExecuteMsg::Redeem {
                amount,
                denom: None,
                padding: None,
            })?,
            funds: vec![],
        }
        .into(),
        WasmMsg::Execute {
            contract_addr: config.gas_vault.address.to_string(),
            code_hash: config.gas_vault.code_hash.clone(),
            msg: to_binary(&GasVaultExecuteMsg::Grant {
                grantee: grantee.to_string(),
            })?,
            // The redeem above runs first, so this is spendable by the time
            // the vault reads it.
            funds: coins(amount.u128(), DENOM),
        }
        .into(),
    ])
}

/// Redeem stray sSCRT and pay it to the vault as a plain transfer.
///
/// Unpermissioned on purpose. Nobody gains: the money becomes backing for
/// grants the vault has already issued rather than anyone's credit, which the
/// vault documents as the safe direction. An admin-only recovery would hand the
/// admin power over tokens it otherwise has none over, to deal with dust.
fn sweep(deps: DepsMut, env: Env) -> StdResult<Response> {
    let config = load_config(deps.storage)?;

    if load_pending(deps.storage)?.is_some() {
        // Mid-swap the balance is not stray, it is the purchase.
        return Err(StdError::generic_err("a purchase is in flight"));
    }

    let balance = sscrt_balance(deps.as_ref(), &env, &config)?;
    if balance.is_zero() {
        return Err(StdError::generic_err("there is nothing to sweep"));
    }

    Ok(Response::new()
        .add_message(WasmMsg::Execute {
            contract_addr: config.sscrt.address.to_string(),
            code_hash: config.sscrt.code_hash.clone(),
            msg: to_binary(&Snip20ExecuteMsg::Redeem {
                amount: balance,
                denom: None,
                padding: None,
            })?,
            funds: vec![],
        })
        .add_message(BankMsg::Send {
            to_address: config.gas_vault.address.to_string(),
            amount: coins(balance.u128(), DENOM),
        })
        .add_attribute("action", "sweep")
        .add_attribute("amount", balance))
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

fn require_admin(config: &Config, sender: &Addr) -> StdResult<()> {
    match &config.admin {
        Some(admin) if admin == sender => Ok(()),
        _ => Err(StdError::generic_err("only the admin may do that")),
    }
}

fn set_router(deps: DepsMut, info: MessageInfo, router: ContractInfo) -> StdResult<Response> {
    let mut config = load_config(deps.storage)?;
    require_admin(&config, &info.sender)?;
    config.router = Some(validate(deps.as_ref(), &router)?);
    save_config(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "set_router"))
}

/// Adding a route also sets a viewing key on the new token, so its balance can
/// be checked — the zero-balance invariant is only worth stating if every token
/// it covers can actually be read.
fn set_route(
    deps: DepsMut,
    info: MessageInfo,
    token: ContractInfo,
    path: Vec<Hop>,
) -> StdResult<Response> {
    let mut config = load_config(deps.storage)?;
    require_admin(&config, &info.sender)?;

    let token = validate(deps.as_ref(), &token)?;
    if token.address == config.sscrt.address {
        return Err(StdError::generic_err("sSCRT is not swapped, it is redeemed"));
    }

    config.routes.retain(|route| route.token.address != token.address);

    let mut messages = Vec::new();
    if path.is_empty() {
        save_config(deps.storage, &config)?;
        return Ok(Response::new()
            .add_attribute("action", "remove_route")
            .add_attribute("token", token.address));
    }

    messages.push(set_viewing_key(&token, &config.viewing_key)?);
    let address = token.address.clone();
    config.routes.push(Route { token, path });
    save_config(deps.storage, &config)?;

    Ok(Response::new()
        .add_messages(messages)
        .add_attribute("action", "set_route")
        .add_attribute("token", address))
}

/// Only the hashes. The addresses stay as instantiated, so this cannot point
/// the contract at a different vault — a wrong hash just makes calls fail.
fn set_code_hashes(
    deps: DepsMut,
    info: MessageInfo,
    gas_vault: Option<String>,
    sscrt: Option<String>,
) -> StdResult<Response> {
    let mut config = load_config(deps.storage)?;
    require_admin(&config, &info.sender)?;

    if let Some(hash) = gas_vault {
        config.gas_vault.code_hash = hash;
    }
    if let Some(hash) = sscrt {
        config.sscrt.code_hash = hash;
    }

    save_config(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "set_code_hashes"))
}

fn set_admin(deps: DepsMut, info: MessageInfo, admin: Option<String>) -> StdResult<Response> {
    let mut config = load_config(deps.storage)?;
    require_admin(&config, &info.sender)?;

    // There is no chain-level migrate admin either, so `None` here is
    // permanent: the routes and router freeze as they are.
    config.admin = match admin {
        Some(admin) => Some(deps.api.addr_validate(&admin)?),
        None => None,
    };

    save_config(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "set_admin"))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn validate(deps: Deps, contract: &ContractInfo) -> StdResult<Contract> {
    Ok(Contract {
        address: deps.api.addr_validate(&contract.address)?,
        code_hash: contract.code_hash.clone(),
    })
}

fn build_route(deps: Deps, route: &RouteInput) -> StdResult<Route> {
    if route.path.is_empty() {
        return Err(StdError::generic_err("a route needs at least one hop"));
    }
    Ok(Route {
        token: validate(deps, &route.token)?,
        path: route.path.clone(),
    })
}

fn set_viewing_key(token: &Contract, key: &str) -> StdResult<CosmosMsg> {
    Ok(WasmMsg::Execute {
        contract_addr: token.address.to_string(),
        code_hash: token.code_hash.clone(),
        msg: to_binary(&Snip20ExecuteMsg::SetViewingKey {
            key: key.to_string(),
            padding: None,
        })?,
        funds: vec![],
    }
    .into())
}

fn sscrt_balance(deps: Deps, env: &Env, config: &Config) -> StdResult<Uint128> {
    token_balance(deps, env, config, &config.sscrt)
}

fn token_balance(deps: Deps, env: &Env, config: &Config, token: &Contract) -> StdResult<Uint128> {
    let answer: Snip20QueryAnswer = deps.querier.query_wasm_smart(
        token.code_hash.clone(),
        token.address.to_string(),
        &Snip20QueryMsg::Balance {
            address: env.contract.address.to_string(),
            key: config.viewing_key.clone(),
        },
    )?;

    match answer {
        Snip20QueryAnswer::Balance { amount } => Ok(amount),
        // A key the token rejects is not an empty wallet. Reading it as zero
        // would make the swap path grant whatever happened to be lying here.
        Snip20QueryAnswer::ViewingKeyError { msg } => Err(StdError::generic_err(format!(
            "{} rejected the viewing key: {msg}",
            token.address
        ))),
    }
}

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    let config = load_config(deps.storage)?;

    match msg {
        QueryMsg::Config {} => to_binary(&ConfigResponse {
            gas_vault: config.gas_vault.info(),
            sscrt: config.sscrt.info(),
            router: config.router.as_ref().map(Contract::info),
            admin: config.admin.as_ref().map(Addr::to_string),
        }),
        QueryMsg::Routes {} => to_binary(&RoutesResponse {
            routes: config
                .routes
                .iter()
                .map(|route| RouteInput {
                    token: route.token.info(),
                    path: route.path.clone(),
                })
                .collect(),
        }),
        QueryMsg::Balances {} => to_binary(&BalancesResponse {
            native: deps
                .querier
                .query_balance(env.contract.address.clone(), DENOM)?
                .amount,
            // `.ok()` throughout: an unreadable balance is reported as unknown
            // rather than as zero, the same distinction the vault draws in
            // `RemainingResponse`.
            sscrt: sscrt_balance(deps, &env, &config).ok(),
            tokens: config
                .routes
                .iter()
                .map(|route| TokenBalance {
                    address: route.token.address.to_string(),
                    amount: token_balance(deps, &env, &config, &route.token).ok(),
                })
                .collect(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_env, mock_info, MockApi, MockQuerier, MOCK_CONTRACT_ADDR};
    use cosmwasm_std::{
        coins, from_slice, ContractResult, Empty, MemoryStorage, OwnedDeps, Querier, QuerierResult,
        QueryRequest, SystemResult, WasmQuery,
    };
    use std::collections::HashMap;
    use std::marker::PhantomData;

    const SSCRT: &str = "sscrt";
    const SSCRT_HASH: &str = "aaaa";
    const STKD: &str = "stkd";
    const STKD_HASH: &str = "bbbb";
    const VAULT: &str = "vault";
    const VAULT_HASH: &str = "cccc";
    const ROUTER: &str = "router";
    const ROUTER_HASH: &str = "dddd";
    const PAIR: &str = "pair";
    const PAIR_HASH: &str = "eeee";
    const KEY: &str = "viewing-key";

    /// Answers SNIP-20 balance queries the way a token does, including the one
    /// failure the contract must not read as an empty wallet: a rejected key.
    struct TokenQuerier {
        bank: MockQuerier,
        balances: HashMap<String, u128>,
        key_ok: bool,
    }

    impl Querier for TokenQuerier {
        fn raw_query(&self, bin_request: &[u8]) -> QuerierResult {
            if let Ok(QueryRequest::Wasm(WasmQuery::Smart { contract_addr, msg, .. })) =
                from_slice::<QueryRequest<Empty>>(bin_request)
            {
                if from_slice::<Snip20QueryMsg>(&msg).is_ok() {
                    let answer = if self.key_ok {
                        Snip20QueryAnswer::Balance {
                            amount: Uint128::new(
                                self.balances.get(&contract_addr).copied().unwrap_or_default(),
                            ),
                        }
                    } else {
                        Snip20QueryAnswer::ViewingKeyError {
                            msg: "wrong viewing key".into(),
                        }
                    };
                    return SystemResult::Ok(ContractResult::Ok(to_binary(&answer).unwrap()));
                }
            }
            self.bank.raw_query(bin_request)
        }
    }

    type Deps = OwnedDeps<MemoryStorage, MockApi, TokenQuerier>;

    fn info(address: &str, code_hash: &str) -> ContractInfo {
        ContractInfo {
            address: address.into(),
            code_hash: code_hash.into(),
        }
    }

    fn hop() -> Hop {
        Hop {
            addr: PAIR.into(),
            code_hash: PAIR_HASH.into(),
        }
    }

    fn setup(with_router: bool) -> (Deps, Env) {
        let mut deps = OwnedDeps {
            storage: MemoryStorage::new(),
            api: MockApi::default(),
            querier: TokenQuerier {
                bank: MockQuerier::new(&[(MOCK_CONTRACT_ADDR, &[])]),
                balances: HashMap::new(),
                key_ok: true,
            },
            custom_query_type: PhantomData,
        };
        let env = mock_env();

        instantiate(
            deps.as_mut(),
            env.clone(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                gas_vault: info(VAULT, VAULT_HASH),
                sscrt: info(SSCRT, SSCRT_HASH),
                viewing_key: KEY.into(),
                admin: None,
                router: with_router.then(|| info(ROUTER, ROUTER_HASH)),
                routes: if with_router {
                    vec![RouteInput {
                        token: info(STKD, STKD_HASH),
                        path: vec![hop()],
                    }]
                } else {
                    vec![]
                },
            },
        )
        .unwrap();

        (deps, env)
    }

    fn set_balance(deps: &mut Deps, token: &str, amount: u128) {
        deps.querier.balances.insert(token.into(), amount);
    }

    fn buy(deps: &mut Deps, env: &Env, token: &str, amount: u128, msg: Option<ReceiveMsg>) -> StdResult<Response> {
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info(token, &[]),
            ExecuteMsg::Receive {
                sender: "buyer".into(),
                from: "buyer".into(),
                amount: Uint128::new(amount),
                memo: None,
                msg: msg.map(|m| to_binary(&m).unwrap()),
            },
        )
    }

    fn credit(grantee: &str, min_out: Option<u128>) -> ReceiveMsg {
        ReceiveMsg::BuyCredit {
            grantee: grantee.into(),
            min_out: min_out.map(Uint128::new),
        }
    }

    /// Pull a WasmMsg::Execute apart and decode its payload, so the wire shape
    /// is checked rather than assumed.
    fn as_execute(msg: &CosmosMsg) -> (&String, &String, &Binary, &Vec<cosmwasm_std::Coin>) {
        match msg {
            CosmosMsg::Wasm(WasmMsg::Execute {
                contract_addr,
                code_hash,
                msg,
                funds,
            }) => (contract_addr, code_hash, msg, funds),
            other => panic!("expected a contract call, got {other:?}"),
        }
    }

    fn snip20_of(msg: &CosmosMsg) -> Snip20ExecuteMsg {
        let (_, _, payload, _) = as_execute(msg);
        from_binary(payload).unwrap()
    }

    // -- the sSCRT path ---------------------------------------------------

    #[test]
    fn sscrt_redeems_and_grants_one_to_one() {
        let (mut deps, env) = setup(false);
        let res = buy(&mut deps, &env, SSCRT, 1_000_000, Some(credit("grantee", None))).unwrap();

        assert!(res.messages.iter().all(|m| m.reply_on == cosmwasm_std::ReplyOn::Never),
            "the direct path needs no reply");
        assert_eq!(res.messages.len(), 2);

        match snip20_of(&res.messages[0].msg) {
            Snip20ExecuteMsg::Redeem { amount, .. } => {
                assert_eq!(amount, Uint128::new(1_000_000), "redeem exactly what arrived")
            }
            other => panic!("expected a redeem, got {other:?}"),
        }

        let (addr, hash, payload, funds) = as_execute(&res.messages[1].msg);
        assert_eq!(addr, VAULT);
        assert_eq!(hash, VAULT_HASH, "calls are encrypted against the code hash");
        assert_eq!(funds, &coins(1_000_000, DENOM), "the grant is paid for in native SCRT");
        match from_binary::<GasVaultExecuteMsg>(payload).unwrap() {
            GasVaultExecuteMsg::Grant { grantee } => assert_eq!(grantee, "grantee"),
        }
    }

    #[test]
    fn sscrt_refuses_a_slippage_bound_it_cannot_honour() {
        let (mut deps, env) = setup(false);
        let err = buy(&mut deps, &env, SSCRT, 1_000, Some(credit("grantee", Some(999)))).unwrap_err();
        assert!(format!("{err}").contains("does not apply"), "got {err}");
    }

    #[test]
    fn an_unlisted_token_is_refused() {
        // Without this anyone could deploy a worthless SNIP-20 and claim any
        // amount, and walk off with stray sSCRT as credit.
        let (mut deps, env) = setup(true);
        let err = buy(&mut deps, &env, "impostor", 1_000_000, Some(credit("thief", Some(1)))).unwrap_err();
        assert!(format!("{err}").contains("not accepted"), "got {err}");
    }

    #[test]
    fn zero_buys_nothing() {
        let (mut deps, env) = setup(false);
        let err = buy(&mut deps, &env, SSCRT, 0, Some(credit("grantee", None))).unwrap_err();
        assert!(format!("{err}").contains("nothing"), "got {err}");
    }

    #[test]
    fn a_payload_less_arrival_is_ignored_rather_than_failing() {
        // The router delivers swap output with a plain Send. This contract
        // never registers a receive callback so that should not land here at
        // all, but erroring would let a stranger break purchases in flight.
        let (mut deps, env) = setup(true);
        let res = buy(&mut deps, &env, SSCRT, 500, None).unwrap();
        assert!(res.messages.is_empty(), "nothing was promised, so nothing is done");
    }

    // -- the swap path ----------------------------------------------------

    #[test]
    fn swapping_sends_the_token_to_the_router_with_the_route_and_bound() {
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 0);

        let res = buy(&mut deps, &env, STKD, 2_000_000, Some(credit("grantee", Some(1_800_000)))).unwrap();

        assert_eq!(res.messages.len(), 1);
        assert_eq!(res.messages[0].id, SWAP_REPLY);
        assert_eq!(
            res.messages[0].reply_on,
            cosmwasm_std::ReplyOn::Success,
            "a failed swap must abort the transaction by itself"
        );

        let (addr, hash, _, _) = as_execute(&res.messages[0].msg);
        assert_eq!(addr, STKD, "the token moves itself; the router is the recipient");
        assert_eq!(hash, STKD_HASH);

        match snip20_of(&res.messages[0].msg) {
            Snip20ExecuteMsg::Send { recipient, recipient_code_hash, amount, msg, .. } => {
                assert_eq!(recipient, ROUTER);
                assert_eq!(recipient_code_hash, Some(ROUTER_HASH.into()));
                assert_eq!(amount, Uint128::new(2_000_000));
                match from_binary::<RouterInvokeMsg>(&msg.unwrap()).unwrap() {
                    RouterInvokeMsg::SwapTokensForExact { path, expected_return, recipient } => {
                        assert_eq!(path, vec![hop()]);
                        assert_eq!(expected_return, Some(Uint128::new(1_800_000)));
                        assert_eq!(
                            recipient,
                            Some(MOCK_CONTRACT_ADDR.to_string()),
                            "the output comes back here to be measured"
                        );
                    }
                }
            }
            other => panic!("expected a send, got {other:?}"),
        }
    }

    #[test]
    fn swapping_requires_a_bound() {
        let (mut deps, env) = setup(true);
        let err = buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", None))).unwrap_err();
        assert!(format!("{err}").contains("min_out is required"), "got {err}");

        let err = buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", Some(0)))).unwrap_err();
        assert!(format!("{err}").contains("greater than zero"), "got {err}");
    }

    #[test]
    fn a_second_purchase_cannot_start_while_one_is_in_flight() {
        // Foreign code runs between Receive and reply. A nested call would
        // overwrite the balance snapshot and make the difference meaningless.
        let (mut deps, env) = setup(true);
        buy(&mut deps, &env, STKD, 1_000, Some(credit("first", Some(1)))).unwrap();

        let err = buy(&mut deps, &env, STKD, 1_000, Some(credit("second", Some(1)))).unwrap_err();
        assert!(format!("{err}").contains("already in flight"), "got {err}");
    }

    #[test]
    fn without_a_router_only_sscrt_is_taken() {
        let (mut deps, env) = setup(false);
        // The token is not routed either, so it never reaches the router check.
        let err = buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", Some(1)))).unwrap_err();
        assert!(format!("{err}").contains("not accepted"), "got {err}");
    }

    // -- the reply --------------------------------------------------------

    fn reply_ok(deps: &mut Deps, env: &Env) -> StdResult<Response> {
        reply(
            deps.as_mut(),
            env.clone(),
            Reply {
                id: SWAP_REPLY,
                result: cosmwasm_std::SubMsgResult::Ok(cosmwasm_std::SubMsgResponse {
                    events: vec![],
                    data: None,
                }),
            },
        )
    }

    #[test]
    fn the_grant_is_the_measured_difference_not_the_routers_word() {
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 0);
        buy(&mut deps, &env, STKD, 2_000_000, Some(credit("grantee", Some(1_800_000)))).unwrap();

        set_balance(&mut deps, SSCRT, 1_900_000);
        let res = reply_ok(&mut deps, &env).unwrap();

        assert_eq!(res.messages.len(), 2);
        match snip20_of(&res.messages[0].msg) {
            Snip20ExecuteMsg::Redeem { amount, .. } => assert_eq!(amount, Uint128::new(1_900_000)),
            other => panic!("expected a redeem, got {other:?}"),
        }
        let (_, _, _, funds) = as_execute(&res.messages[1].msg);
        assert_eq!(funds, &coins(1_900_000, DENOM));

        assert!(
            load_pending(deps.as_ref().storage).unwrap().is_none(),
            "the lock is released once the purchase completes"
        );
    }

    #[test]
    fn a_balance_that_was_already_here_is_not_counted_as_swap_output() {
        // Somebody transferred sSCRT to this contract at some point. It is in
        // both readings, so it cancels; granting it would be granting money
        // the swap did not produce.
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 750_000);
        buy(&mut deps, &env, STKD, 2_000_000, Some(credit("grantee", Some(1_800_000)))).unwrap();

        set_balance(&mut deps, SSCRT, 750_000 + 1_900_000);
        let res = reply_ok(&mut deps, &env).unwrap();

        let (_, _, _, funds) = as_execute(&res.messages[1].msg);
        assert_eq!(funds, &coins(1_900_000, DENOM), "only what the swap brought in");
    }

    #[test]
    fn under_delivery_takes_the_whole_transaction_down() {
        // The router drives its hops with reply_always, so it could in
        // principle report success having delivered less, or nothing.
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 0);
        buy(&mut deps, &env, STKD, 2_000_000, Some(credit("grantee", Some(1_800_000)))).unwrap();

        set_balance(&mut deps, SSCRT, 1_700_000);
        let err = reply_ok(&mut deps, &env).unwrap_err();
        assert!(format!("{err}").contains("less than the"), "got {err}");
    }

    #[test]
    fn a_swallowed_failure_that_delivers_nothing_is_caught() {
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 0);
        buy(&mut deps, &env, STKD, 2_000_000, Some(credit("grantee", Some(1_800_000)))).unwrap();

        // Balance unchanged: the router said success and sent nothing.
        let err = reply_ok(&mut deps, &env).unwrap_err();
        assert!(format!("{err}").contains("less than the"), "got {err}");
    }

    #[test]
    fn a_falling_balance_is_an_error_not_a_zero() {
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 500_000);
        buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", Some(1)))).unwrap();

        set_balance(&mut deps, SSCRT, 400_000);
        let err = reply_ok(&mut deps, &env).unwrap_err();
        assert!(format!("{err}").contains("fell during the swap"), "got {err}");
    }

    #[test]
    fn a_rejected_viewing_key_is_never_read_as_zero() {
        let (mut deps, env) = setup(true);
        deps.querier.key_ok = false;

        let err = buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", Some(1)))).unwrap_err();
        assert!(format!("{err}").contains("rejected the viewing key"), "got {err}");
    }

    #[test]
    fn a_reply_with_nothing_in_flight_is_refused() {
        let (mut deps, env) = setup(true);
        let err = reply_ok(&mut deps, &env).unwrap_err();
        assert!(format!("{err}").contains("no purchase in flight"), "got {err}");
    }

    #[test]
    fn an_unknown_reply_id_is_refused() {
        let (mut deps, env) = setup(true);
        let err = reply(
            deps.as_mut(),
            env,
            Reply {
                id: 99,
                result: cosmwasm_std::SubMsgResult::Ok(cosmwasm_std::SubMsgResponse {
                    events: vec![],
                    data: None,
                }),
            },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("unexpected reply"), "got {err}");
    }

    // -- instantiate and admin --------------------------------------------

    #[test]
    fn instantiate_keys_itself_into_every_token_it_must_read() {
        let (_deps, _env) = setup(true);
        let mut deps = OwnedDeps {
            storage: MemoryStorage::new(),
            api: MockApi::default(),
            querier: TokenQuerier {
                bank: MockQuerier::new(&[(MOCK_CONTRACT_ADDR, &[])]),
                balances: HashMap::new(),
                key_ok: true,
            },
            custom_query_type: PhantomData,
        };
        let res = instantiate(
            deps.as_mut(),
            mock_env(),
            mock_info("deployer", &[]),
            InstantiateMsg {
                gas_vault: info(VAULT, VAULT_HASH),
                sscrt: info(SSCRT, SSCRT_HASH),
                viewing_key: KEY.into(),
                admin: None,
                router: Some(info(ROUTER, ROUTER_HASH)),
                routes: vec![RouteInput { token: info(STKD, STKD_HASH), path: vec![hop()] }],
            },
        )
        .unwrap();

        assert_eq!(res.messages.len(), 2, "sSCRT and the one routed token");
        for msg in &res.messages {
            match snip20_of(&msg.msg) {
                Snip20ExecuteMsg::SetViewingKey { key, .. } => assert_eq!(key, KEY),
                other => panic!("expected a viewing key, got {other:?}"),
            }
        }
        // And nothing else: registering a receive callback would let the
        // router's delivery re-enter this contract.
        assert_eq!(res.messages.len(), 2);
    }

    #[test]
    fn only_the_admin_configures_anything() {
        let (mut deps, _env) = setup(true);
        let stranger = mock_info("stranger", &[]);

        for msg in [
            ExecuteMsg::SetRouter { router: info("elsewhere", "ffff") },
            ExecuteMsg::SetRoute { token: info("other", "ffff"), path: vec![hop()] },
            ExecuteMsg::SetCodeHashes { gas_vault: Some("ffff".into()), sscrt: None },
            ExecuteMsg::SetAdmin { admin: None },
        ] {
            let err = execute(deps.as_mut(), mock_env(), stranger.clone(), msg).unwrap_err();
            assert!(format!("{err}").contains("only the admin"), "got {err}");
        }
    }

    #[test]
    fn a_code_hash_can_be_corrected_but_never_the_address() {
        // The vault is migratable, and migrating changes its code hash. This
        // is the narrow power that covers that without letting anyone point
        // the contract at a different vault.
        let (mut deps, env) = setup(true);
        execute(
            deps.as_mut(),
            env.clone(),
            mock_info("deployer", &[]),
            ExecuteMsg::SetCodeHashes { gas_vault: Some("9999".into()), sscrt: None },
        )
        .unwrap();

        let config = load_config(deps.as_ref().storage).unwrap();
        assert_eq!(config.gas_vault.code_hash, "9999");
        assert_eq!(config.gas_vault.address, VAULT, "the address is not settable");

        let res = buy(&mut deps, &env, SSCRT, 1_000, Some(credit("grantee", None))).unwrap();
        let (addr, hash, _, _) = as_execute(&res.messages[1].msg);
        assert_eq!(addr, VAULT);
        assert_eq!(hash, "9999", "the corrected hash is what gets used");
    }

    #[test]
    fn dropping_the_admin_is_permanent() {
        let (mut deps, env) = setup(true);
        execute(deps.as_mut(), env.clone(), mock_info("deployer", &[]), ExecuteMsg::SetAdmin { admin: None }).unwrap();

        let err = execute(
            deps.as_mut(),
            env,
            mock_info("deployer", &[]),
            ExecuteMsg::SetRouter { router: info("elsewhere", "ffff") },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("only the admin"), "got {err}");
    }

    #[test]
    fn a_route_can_be_added_and_removed() {
        let (mut deps, env) = setup(true);
        let admin = mock_info("deployer", &[]);

        execute(
            deps.as_mut(),
            env.clone(),
            admin.clone(),
            ExecuteMsg::SetRoute { token: info(STKD, STKD_HASH), path: vec![] },
        )
        .unwrap();

        let err = buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", Some(1)))).unwrap_err();
        assert!(format!("{err}").contains("not accepted"), "an empty path delists the token");
    }

    #[test]
    fn sscrt_cannot_be_given_a_swap_route() {
        let (mut deps, env) = setup(true);
        let err = execute(
            deps.as_mut(),
            env,
            mock_info("deployer", &[]),
            ExecuteMsg::SetRoute { token: info(SSCRT, SSCRT_HASH), path: vec![hop()] },
        )
        .unwrap_err();
        assert!(format!("{err}").contains("redeemed"), "got {err}");
    }

    // -- sweeping ---------------------------------------------------------

    #[test]
    fn stray_tokens_go_to_the_vault_as_backing_not_as_credit() {
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 12_345);

        let res = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::SweepToVault {}).unwrap();

        assert_eq!(res.messages.len(), 2);
        match snip20_of(&res.messages[0].msg) {
            Snip20ExecuteMsg::Redeem { amount, .. } => assert_eq!(amount, Uint128::new(12_345)),
            other => panic!("expected a redeem, got {other:?}"),
        }
        match &res.messages[1].msg {
            CosmosMsg::Bank(BankMsg::Send { to_address, amount }) => {
                assert_eq!(to_address, VAULT);
                assert_eq!(amount, &coins(12_345, DENOM), "paid in, not granted to anyone");
            }
            other => panic!("expected a bank send, got {other:?}"),
        }
    }

    #[test]
    fn sweeping_cannot_run_off_with_a_purchase_in_flight() {
        let (mut deps, env) = setup(true);
        set_balance(&mut deps, SSCRT, 100);
        buy(&mut deps, &env, STKD, 1_000, Some(credit("grantee", Some(1)))).unwrap();

        let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::SweepToVault {}).unwrap_err();
        assert!(format!("{err}").contains("in flight"), "got {err}");
    }

    #[test]
    fn there_is_nothing_to_sweep_when_the_contract_is_empty() {
        let (mut deps, env) = setup(true);
        let err = execute(deps.as_mut(), env, mock_info("anyone", &[]), ExecuteMsg::SweepToVault {}).unwrap_err();
        assert!(format!("{err}").contains("nothing to sweep"), "got {err}");
    }

    // -- queries ----------------------------------------------------------

    #[test]
    fn balances_report_unknown_rather_than_zero_when_they_cannot_be_read() {
        let (mut deps, env) = setup(true);
        deps.querier.key_ok = false;

        let res: BalancesResponse =
            from_binary(&query(deps.as_ref(), env, QueryMsg::Balances {}).unwrap()).unwrap();
        assert_eq!(res.sscrt, None, "an unreadable balance is not an empty one");
        assert_eq!(res.tokens.len(), 1);
        assert_eq!(res.tokens[0].amount, None);
    }

    #[test]
    fn routes_are_readable_so_the_frontend_needs_no_second_copy() {
        let (deps, env) = setup(true);
        let res: RoutesResponse =
            from_binary(&query(deps.as_ref(), env, QueryMsg::Routes {}).unwrap()).unwrap();
        assert_eq!(res.routes.len(), 1);
        assert_eq!(res.routes[0].token.address, STKD);
        assert_eq!(res.routes[0].path, vec![hop()]);
    }
}
