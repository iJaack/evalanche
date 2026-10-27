/**
 * Polymarket contracts on Polygon mainnet (chain 137).
 *
 * Addresses are the proxy addresses from Polymarket's contract registry
 * (docs.polymarket.com/resources/contracts, read 2026-10-18) plus the V1
 * exchanges. A call to any of these is denied unless the Polymarket module
 * is enabled and the call is one of the gated functions.
 *
 * TODO: a second collateral-adapter pair was reported with prefixes
 * 0xADa10087…9718 and 0xAdA20000…c6F1. The full addresses were not in the
 * Polymarket docs and were not verified by a contract read, so they are not
 * pinned. Calls to an unpinned adapter stay denied: nothing in this list
 * allowlists them, and an unknown address is not a gated function.
 */

/** CTF Exchange V1. Legacy USDC.e exchange. */
export const PM_CTF_EXCHANGE_V1 = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
/** Neg Risk CTF Exchange V1. */
export const PM_NEG_RISK_EXCHANGE_V1 = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
/** Conditional Tokens Framework. */
export const PM_CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
/** pUSD collateral token. */
export const PM_PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
/** Bridged USDC.e on Polygon. Not itself a protocol contract. */
export const PM_USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/** Standard CTF Exchange V2. Domain version "2", negRisk false. */
export const PM_CTF_EXCHANGE_V2 = '0xE111180000d2663C0091e4f400237545B87B996B';
/** Neg Risk CTF Exchange V2. Domain version "2", negRisk true. */
export const PM_NEG_RISK_EXCHANGE_V2 = '0xe2222d279d744050d28e00520010520000310F59';
/** Neg Risk Adapter. redeemPositions is the only gated call. */
export const PM_NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
/** Protocol V2 exchange. Domain version "3". Denied unless v3Exchange is set. */
export const PM_EXCHANGE_V3 = '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa';
/** PositionManager. Holds Protocol V2 ERC-1155 positions. */
export const PM_POSITION_MANAGER = '0x006F54F7f9A22e0000CC2AB60031000000ae9fEF';
/** Protocol V2 router. */
export const PM_ROUTER = '0x12121212006e4CD160D18e3f00711DA5c3372600';
/** Collateral onramp. Wrapping stays denied. */
export const PM_COLLATERAL_ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee';
/** Collateral offramp. */
export const PM_COLLATERAL_OFFRAMP = '0x2957922Eb93258b93368531d39fAcCA3B4dC5854';
/** Permissioned ramp. */
export const PM_PERMISSIONED_RAMP = '0xebC2459Ec962869ca4c0bd1E06368272732BCb08';
/** CTF collateral adapter. Split, merge, and redeem through it stay denied. */
export const PM_CTF_COLLATERAL_ADAPTER = '0xAdA100Db00Ca00073811820692005400218FcE1f';
/** Neg-risk CTF collateral adapter. */
export const PM_NEG_RISK_COLLATERAL_ADAPTER = '0xadA2005600Dec949baf300f4C6120000bDB6eAab';
export const PM_BINARY_MODULE = '0x1000008dD9001B968442c1000017eaE6E0dA00Ba';
export const PM_NEG_RISK_MODULE = '0x200000900045e3B6259600682756002200028933';
export const PM_COMBINATORIAL_MODULE = '0x30000034706C7d8e12009DAB006Be20000c031A8';
export const PM_AUTO_REDEEMER = '0xa1200000d0002264C9a1698e001292D00E1b00af';

/** Every protocol address the signer hard-denies. Order is stable for tests. */
export const POLYMARKET_DENY_CONTRACTS = [
  PM_CTF_EXCHANGE_V1,
  PM_CTF,
  PM_PUSD,
  PM_CTF_EXCHANGE_V2,
  PM_NEG_RISK_ADAPTER,
  PM_NEG_RISK_EXCHANGE_V2,
  PM_NEG_RISK_EXCHANGE_V1,
  PM_EXCHANGE_V3,
  PM_POSITION_MANAGER,
  PM_ROUTER,
  PM_COLLATERAL_ONRAMP,
  PM_COLLATERAL_OFFRAMP,
  PM_PERMISSIONED_RAMP,
  PM_CTF_COLLATERAL_ADAPTER,
  PM_NEG_RISK_COLLATERAL_ADAPTER,
  PM_BINARY_MODULE,
  PM_NEG_RISK_MODULE,
  PM_COMBINATORIAL_MODULE,
  PM_AUTO_REDEEMER,
] as const;

export const PM_ORDER_TYPE =
  'Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)';

/**
 * keccak256 of {@link PM_ORDER_TYPE}. Pinned to the V2 constant published by
 * Polymarket's go-order-utils TestOrderStructureHashV2.
 */
export const PM_ORDER_TYPEHASH = '0xbb86318a2138f5fa8ae32fbe8e659f8fcf13cc6ae4014a707893055433818589';

export const PM_ORDER_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'salt', type: 'uint256' },
  { name: 'maker', type: 'address' },
  { name: 'signer', type: 'address' },
  { name: 'tokenId', type: 'uint256' },
  { name: 'makerAmount', type: 'uint256' },
  { name: 'takerAmount', type: 'uint256' },
  { name: 'side', type: 'uint8' },
  { name: 'signatureType', type: 'uint8' },
  { name: 'timestamp', type: 'uint256' },
  { name: 'metadata', type: 'bytes32' },
  { name: 'builder', type: 'bytes32' },
];

export const PM_DOMAIN_NAME = 'Polymarket CTF Exchange';
export const PM_DOMAIN_VERSION_V2 = '2';
export const PM_DOMAIN_VERSION_V3 = '3';
export const PM_CHAIN_ID = 137;

export const PM_CLOB_AUTH_DOMAIN = 'ClobAuthDomain';
export const PM_CLOB_AUTH_VERSION = '1';
export const PM_CLOB_AUTH_MESSAGE = 'This message attests that I control the given wallet';
export const PM_CLOB_AUTH_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'address', type: 'address' },
  { name: 'timestamp', type: 'string' },
  { name: 'nonce', type: 'uint256' },
  { name: 'message', type: 'string' },
];

export const PM_ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
/** Order timestamp must sit within two minutes of the signer clock. */
export const PM_TIMESTAMP_SKEW_MS = 120_000;
