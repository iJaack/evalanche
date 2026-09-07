import { createRequire } from 'node:module';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** Keep Core/Ledger out of ordinary EVM startup even in the unsplit bundle. */
export function loadAvalancheSdk(): typeof import('@avalabs/core-wallets-sdk').Avalanche {
  try {
    return createRequire(typeof __filename === 'string' ? __filename : import.meta.url)('@avalabs/core-wallets-sdk').Avalanche;
  } catch (error) {
    throw new EvalancheError(
      'Failed to load Avalanche Core SDK. Check the documented dependency overrides before using X/P-chain operations.',
      EvalancheErrorCode.INVALID_CONFIG,
      error instanceof Error ? error : undefined,
    );
  }
}
