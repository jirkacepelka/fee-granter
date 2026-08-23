//! Hand-rolled protobuf for the x/feegrant messages.
//!
//! `CosmosMsg::Stargate` carries a raw protobuf `Any`, so the contract has to
//! encode the message itself. Field numbers are from cosmos-sdk's
//! `cosmos/feegrant/v1beta1/{feegrant,tx}.proto` — they are part of the wire
//! format and must match exactly or the chain's unpacker rejects the message.

use prost::Message;

pub const MSG_GRANT_ALLOWANCE: &str = "/cosmos.feegrant.v1beta1.MsgGrantAllowance";
pub const MSG_REVOKE_ALLOWANCE: &str = "/cosmos.feegrant.v1beta1.MsgRevokeAllowance";
pub const BASIC_ALLOWANCE: &str = "/cosmos.feegrant.v1beta1.BasicAllowance";

#[derive(Clone, PartialEq, Message)]
pub struct Coin {
    #[prost(string, tag = "1")]
    pub denom: String,
    #[prost(string, tag = "2")]
    pub amount: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct Any {
    #[prost(string, tag = "1")]
    pub type_url: String,
    #[prost(bytes = "vec", tag = "2")]
    pub value: Vec<u8>,
}

/// A fixed pot with no period. x/feegrant deletes the grant once it reaches
/// zero, which is what makes the credit non-refilling.
#[derive(Clone, PartialEq, Message)]
pub struct BasicAllowance {
    #[prost(message, repeated, tag = "1")]
    pub spend_limit: Vec<Coin>,
    // tag 2 is `expiration`, left out: these grants do not expire.
}

#[derive(Clone, PartialEq, Message)]
pub struct MsgGrantAllowance {
    #[prost(string, tag = "1")]
    pub granter: String,
    #[prost(string, tag = "2")]
    pub grantee: String,
    #[prost(message, optional, tag = "3")]
    pub allowance: Option<Any>,
}

#[derive(Clone, PartialEq, Message)]
pub struct MsgRevokeAllowance {
    #[prost(string, tag = "1")]
    pub granter: String,
    #[prost(string, tag = "2")]
    pub grantee: String,
}

pub fn encode(msg: &impl Message) -> Vec<u8> {
    let mut buf = Vec::with_capacity(msg.encoded_len());
    // Only fails on an undersized buffer, which cannot happen here.
    msg.encode(&mut buf).expect("encoding into an owned Vec cannot fail");
    buf
}
