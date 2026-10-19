/**
 * Proposer fields for revoke-only and CCTP V2.
 *
 * The signer accepts one venue/action pair for each calldata shape:
 * `revoke` / `revoke`, `cctp` / `cctp-approve`, `cctp` / `cctp-burn`,
 * and `cctp` / `cctp-mint`. A V1 CTF `setApprovalForAll(false)` uses the
 * existing kill-switch pair, `polymarket` / `polymarket-kill`.
 * `tokenIn` is the token. `amountIn` is 0 for a revoke, the approve amount
 * for `cctp-approve`, and the USDC amount for a burn or a mint.
 */

import { Interface, getAddress } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import {
  CCTP_MESSAGE_TRANSMITTER_V2,
  CCTP_STANDARD_FINALITY,
  CCTP_TOKEN_MESSENGER_V2,
  takeCctp,
  type CctpConfig,
} from './cctp';
import { AVALANCHE_NATIVE_USDC } from './revoke-only';
import { PM_CTF, PM_CTF_EXCHANGE_V1, PM_NEG_RISK_EXCHANGE_V1 } from './polymarket-addresses';
import { POLYMARKET_KILL_ACTION, POLYMARKET_KILL_VENUE } from './polymarket-module';

export interface FundingIntentFields {
  venue: 'revoke' | 'cctp';
  action: 'revoke' | 'cctp-approve' | 'cctp-burn' | 'cctp-mint';
  to: string;
  data: string;
  value: '0';
  tokenIn: { address: string; symbol: string; decimals: number };
  amountIn: string;
}

export interface PolymarketKillIntentFields {
  venue: typeof POLYMARKET_KILL_VENUE;
  action: typeof POLYMARKET_KILL_ACTION;
  to: string;
  data: string;
  value: '0';
}

const ERC20 = new Interface(['function approve(address spender, uint256 amount)']);
const ERC1155 = new Interface(['function setApprovalForAll(address operator, bool approved)']);
const MESSENGER_IFACE = new Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);
const TRANSMITTER_IFACE = new Interface(['function receiveMessage(bytes message, bytes attestation)']);

function fail(message: string): never {
  throw new EvalancheError(message, EvalancheErrorCode.INVALID_PARAMS);
}

function word(address: string): string {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, '0')}`;
}

function tokenRef(address: string, symbol = 'USDC', decimals = 6): FundingIntentFields['tokenIn'] {
  return { address: getAddress(address), symbol, decimals };
}

/** `approve(spender, 0)`. amountIn is 0. tokenIn is the token. */
export function buildRevokeApproval(input: {
  token: string;
  spender: string;
  symbol?: string;
  decimals?: number;
}): FundingIntentFields {
  const token = getAddress(input.token);
  return {
    venue: 'revoke',
    action: 'revoke',
    to: token,
    data: ERC20.encodeFunctionData('approve', [getAddress(input.spender), 0n]),
    value: '0',
    tokenIn: tokenRef(token, input.symbol, input.decimals),
    amountIn: '0',
  };
}

/** `setApprovalForAll(operator, false)` on a token contract. amountIn is 0. */
export function buildRevokeOperator(input: {
  token: string;
  operator: string;
  symbol?: string;
  decimals?: number;
}): FundingIntentFields {
  const token = getAddress(input.token);
  return {
    venue: 'revoke',
    action: 'revoke',
    to: token,
    data: ERC1155.encodeFunctionData('setApprovalForAll', [getAddress(input.operator), false]),
    value: '0',
    tokenIn: tokenRef(token, input.symbol ?? 'NFT', input.decimals ?? 0),
    amountIn: '0',
  };
}

/** Exact USDC approve to TokenMessengerV2. amountIn is that amount. */
export function buildCctpApprove(amount: bigint): FundingIntentFields {
  if (typeof amount !== 'bigint' || amount <= 0n) fail('CCTP approval amount must be greater than zero');
  const token = getAddress(AVALANCHE_NATIVE_USDC);
  const data = ERC20.encodeFunctionData('approve', [CCTP_TOKEN_MESSENGER_V2, amount]);
  const decoded = takeCctp({
    chainId: 43114,
    to: token,
    data,
    value: 0n,
    config: { enabled: true, destinationDomains: [7], minFinalityThreshold: CCTP_STANDARD_FINALITY },
    wallet: '0x0000000000000000000000000000000000000001',
  });
  if (!decoded || decoded.moduleOp !== 'cctp-approve' || decoded.amount !== amount) fail('CCTP approval did not decode');
  return {
    venue: 'cctp',
    action: 'cctp-approve',
    to: token,
    data,
    value: '0',
    tokenIn: tokenRef(token),
    amountIn: amount.toString(),
  };
}

/** Avalanche `depositForBurn`. amountIn is the burn amount. tokenIn is Avalanche USDC. */
export function buildCctpBurn(input: {
  wallet: string;
  amount: bigint;
  destinationDomain?: number;
  destinationCaller?: string;
  maxFee?: bigint;
}): FundingIntentFields {
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) fail('CCTP burn amount must be greater than zero');
  const wallet = getAddress(input.wallet);
  const domain = input.destinationDomain ?? 7;
  const caller = input.destinationCaller ?? '0x0000000000000000000000000000000000000000';
  const maxFee = input.maxFee ?? 0n;
  const data = MESSENGER_IFACE.encodeFunctionData('depositForBurn', [
    input.amount,
    domain,
    word(wallet),
    getAddress(AVALANCHE_NATIVE_USDC),
    word(caller),
    maxFee,
    CCTP_STANDARD_FINALITY,
  ]);
  const config: CctpConfig = {
    enabled: true,
    destinationDomains: [domain],
    minFinalityThreshold: CCTP_STANDARD_FINALITY,
    maxFee: maxFee.toString(),
  };
  if (input.destinationCaller) config.destinationCaller = getAddress(input.destinationCaller);
  const decoded = takeCctp({
    chainId: 43114,
    to: CCTP_TOKEN_MESSENGER_V2,
    data,
    value: 0n,
    config,
    wallet,
  });
  if (!decoded || decoded.kind !== 'cctp-burn' || decoded.amount !== input.amount) fail('CCTP burn did not decode');
  return {
    venue: 'cctp',
    action: 'cctp-burn',
    to: getAddress(CCTP_TOKEN_MESSENGER_V2),
    data,
    value: '0',
    tokenIn: tokenRef(AVALANCHE_NATIVE_USDC),
    amountIn: input.amount.toString(),
  };
}

/**
 * `receiveMessage`. amountIn is the burn-body amount. tokenIn is the USDC
 * the destination chain mints.
 */
export function buildCctpMint(input: {
  message: string;
  attestation: string;
  chainId: number;
  wallet: string;
  config: CctpConfig;
}): FundingIntentFields {
  const data = TRANSMITTER_IFACE.encodeFunctionData('receiveMessage', [input.message, input.attestation]);
  const decoded = takeCctp({
    chainId: input.chainId,
    to: CCTP_MESSAGE_TRANSMITTER_V2,
    data,
    value: 0n,
    config: input.config,
    wallet: input.wallet,
  });
  if (!decoded || decoded.kind !== 'cctp-mint' || decoded.amount === undefined || !decoded.asset) {
    fail('CCTP mint did not decode');
  }
  return {
    venue: 'cctp',
    action: 'cctp-mint',
    to: getAddress(CCTP_MESSAGE_TRANSMITTER_V2),
    data,
    value: '0',
    tokenIn: tokenRef(decoded.asset),
    amountIn: decoded.amount.toString(),
  };
}

/** V1 CTF `setApprovalForAll(operator, false)`, labeled as the existing kill switch. */
export function buildPolymarketV1CtfRevoke(operator: string): PolymarketKillIntentFields {
  const who = getAddress(operator);
  if (who !== getAddress(PM_CTF_EXCHANGE_V1) && who !== getAddress(PM_NEG_RISK_EXCHANGE_V1)) {
    fail('V1 CTF revoke operator is not a V1 exchange');
  }
  return {
    venue: POLYMARKET_KILL_VENUE,
    action: POLYMARKET_KILL_ACTION,
    to: getAddress(PM_CTF),
    data: ERC1155.encodeFunctionData('setApprovalForAll', [who, false]),
    value: '0',
  };
}
