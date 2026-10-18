/**
 * Proposer slippage for a bought token.
 *
 * Avalanche keeps the signer's built-in stable and top lists. Every other
 * chain uses only the caps the caller passes or the caps on the signer
 * chain config. A missing list there used to fall through to 300 bps, and
 * the signer then denied the swap when that token was a 50 bps stable.
 */

import { tokenClassBps, type SlippageCaps } from '../signer/server';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

export const AVALANCHE_CHAIN_ID = 43114;

export function proposerSlippageBps(input: {
  chainId: number;
  tokenOut: string;
  slippageCaps?: SlippageCaps;
  signerSlippageCaps?: SlippageCaps;
}): number {
  const avalanche = input.chainId === AVALANCHE_CHAIN_ID;
  if (!avalanche && input.slippageCaps === undefined && input.signerSlippageCaps === undefined) {
    throw new EvalancheError(
      `slippageCaps are required on chain ${input.chainId}. Off Avalanche the signer does not use the built-in stable list, so a 300 bps default can sit under a 50 bps stable cap`,
      EvalancheErrorCode.INVALID_PARAMS,
    );
  }
  const ceiling = tokenClassBps(
    input.signerSlippageCaps !== undefined ? input.signerSlippageCaps : input.slippageCaps,
    input.tokenOut,
    avalanche,
  );
  if (input.signerSlippageCaps !== undefined && input.slippageCaps !== undefined) {
    const requested = tokenClassBps(input.slippageCaps, input.tokenOut, avalanche);
    if (requested > ceiling) {
      throw new EvalancheError(
        `slippageCaps allow ${requested} bps for this token, above the signer class cap of ${ceiling} bps on chain ${input.chainId}`,
        EvalancheErrorCode.INVALID_PARAMS,
      );
    }
    return requested;
  }
  return ceiling;
}
