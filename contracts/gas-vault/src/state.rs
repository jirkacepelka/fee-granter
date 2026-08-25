use cosmwasm_std::{Addr, Storage, Uint128};

pub const ISSUED_PREFIX: &[u8] = b"issued";

fn issued_key(grantee: &Addr) -> Vec<u8> {
    [ISSUED_PREFIX, grantee.as_bytes()].concat()
}

/// What this contract last set `grantee`'s allowance to.
///
/// Not what they still hold - only x/feegrant knows that, and reading it is the
/// contract's job before topping anyone up. Zero carries real weight: it means
/// this contract has never granted to them, so there is no grant to read and no
/// need to ask.
pub fn read_issued(storage: &dyn Storage, grantee: &Addr) -> Uint128 {
    storage
        .get(&issued_key(grantee))
        .and_then(|raw| parse_amount(&raw))
        .unwrap_or_default()
}

pub fn write_issued(storage: &mut dyn Storage, grantee: &Addr, amount: Uint128) {
    storage.set(&issued_key(grantee), amount.to_string().as_bytes());
}

fn parse_amount(raw: &[u8]) -> Option<Uint128> {
    std::str::from_utf8(raw).ok()?.parse::<u128>().ok().map(Uint128::new)
}
