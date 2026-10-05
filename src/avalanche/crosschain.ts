import type { AvalancheSigner } from './signer';
import type { AvalancheProvider } from './provider';
import { XChainOperations } from './xchain';
import { PChainOperations } from './pchain';
import type { ChainAlias, TransferResult } from './types';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/**
 * Cross-chain transfer orchestrator.
 * Handles the export→wait→import two-step flow for all chain pairs.
 */
export class CrossChainTransfer {
  private static readonly IMPORT_POLL_INTERVAL_MS = 2_000;
  private static readonly IMPORT_POLL_TIMEOUT_MS = 30_000;
  private readonly signer: AvalancheSigner;
  private readonly provider: AvalancheProvider;
  private readonly xChain: XChainOperations;
  private readonly pChain: PChainOperations;

  constructor(signer: AvalancheSigner, provider: AvalancheProvider) {
    this.signer = signer;
    this.provider = provider;
    this.xChain = new XChainOperations(signer, provider);
    this.pChain = new PChainOperations(signer, provider);
  }

  /**
   * Transfer AVAX between chains.
   * Supports all 6 directions: C↔X, C↔P, X↔P.
   *
   * @param from - Source chain
   * @param to - Destination chain
   * @param amount - Amount in nAVAX (as bigint)
   * @returns Export and import transaction IDs
   */
  async transfer(
    from: ChainAlias,
    to: ChainAlias,
    amount: bigint,
  ): Promise<TransferResult> {
    if (from === to) {
      throw new EvalancheError(
        'Source and destination chains must be different',
        EvalancheErrorCode.CROSS_CHAIN_ERROR,
      );
    }

    try {
      let exportTxId: string;
      let importTxId: string;

      switch (`${from}→${to}`) {
        case 'X→P': {
          exportTxId = await this.xChain.exportTo(amount, 'P');
          await this.waitForImportAvailability('P', 'X');
          importTxId = await this.pChain.importFrom('X');
          break;
        }
        case 'X→C': {
          exportTxId = await this.xChain.exportTo(amount, 'C');
          await this.waitForImportAvailability('C', 'X');
          importTxId = await this.importToC('X');
          break;
        }
        case 'P→X': {
          exportTxId = await this.pChain.exportTo(amount, 'X');
          await this.waitForImportAvailability('X', 'P');
          importTxId = await this.xChain.importFrom('P');
          break;
        }
        case 'P→C': {
          exportTxId = await this.pChain.exportTo(amount, 'C');
          await this.waitForImportAvailability('C', 'P');
          importTxId = await this.importToC('P');
          break;
        }
        case 'C→X': {
          exportTxId = await this.exportFromC(amount, 'X');
          await this.waitForImportAvailability('X', 'C');
          importTxId = await this.xChain.importFrom('C');
          break;
        }
        case 'C→P': {
          exportTxId = await this.exportFromC(amount, 'P');
          await this.waitForImportAvailability('P', 'C');
          importTxId = await this.pChain.importFrom('C');
          break;
        }
        default:
          throw new Error(`Unsupported transfer direction: ${from}→${to}`);
      }

      return { exportTxId, importTxId };
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `Cross-chain transfer ${from}→${to} failed: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.CROSS_CHAIN_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /** Export AVAX from C-Chain (EVM export tx format) */
  private async exportFromC(
    amount: bigint,
    destination: 'X' | 'P',
  ): Promise<string> {
    return this.signer.exportC(amount, destination);
  }

  /** Import AVAX to C-Chain from another chain */
  private async importToC(sourceChain: 'X' | 'P'): Promise<string> {
    return this.signer.importC(sourceChain);
  }

  /** Poll until the exported atomic UTXOs are visible on the destination chain. */
  private async waitForImportAvailability(
    destination: ChainAlias,
    source: ChainAlias,
  ): Promise<void> {
    const deadline = Date.now() + CrossChainTransfer.IMPORT_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const address = destination === 'C'
        ? this.signer.getAddressEVM()
        : this.signer.getCurrentAddress(destination);
      if (await this.provider.getAtomicUTXOCount(destination, source, address) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, CrossChainTransfer.IMPORT_POLL_INTERVAL_MS));
    }

    throw new EvalancheError(
      `Timed out waiting for ${source}→${destination} atomic UTXOs to become available`,
      EvalancheErrorCode.CROSS_CHAIN_ERROR,
    );
  }
}
