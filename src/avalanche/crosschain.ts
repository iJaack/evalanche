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
          await this.waitForConfirmation();
          importTxId = await this.pChain.importFrom('X');
          break;
        }
        case 'X→C': {
          exportTxId = await this.xChain.exportTo(amount, 'C');
          await this.waitForConfirmation();
          importTxId = await this.importToC('X');
          break;
        }
        case 'P→X': {
          exportTxId = await this.pChain.exportTo(amount, 'X');
          await this.waitForConfirmation();
          importTxId = await this.xChain.importFrom('P');
          break;
        }
        case 'P→C': {
          exportTxId = await this.pChain.exportTo(amount, 'C');
          await this.waitForConfirmation();
          importTxId = await this.importToC('P');
          break;
        }
        case 'C→X': {
          exportTxId = await this.exportFromC(amount, 'X');
          await this.waitForConfirmation();
          importTxId = await this.xChain.importFrom('C');
          break;
        }
        case 'C→P': {
          exportTxId = await this.exportFromC(amount, 'P');
          await this.waitForConfirmation();
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
    const nonce = BigInt(await this.signer.getNonce());
    const feeData = await this.provider.evmRpc.getFeeData();
    const baseFee = feeData.gasPrice ?? BigInt(25_000_000_000);
    const unsignedTx = this.signer.exportC(amount, destination, nonce, baseFee);
    const signedUnsignedTx = await this.signer.signTx({ tx: unsignedTx });
    const signedTx = signedUnsignedTx.getSignedTx();
    const api = this.provider.getApiC();
    const response = await api.issueSignedTx(signedTx);
    return response.txID;
  }

  /** Import AVAX to C-Chain from another chain */
  private async importToC(sourceChain: 'X' | 'P'): Promise<string> {
    const atomicUtxos = await this.signer.getAtomicUTXOs('C', sourceChain);
    if (atomicUtxos.getUTXOs().length === 0) {
      throw new Error('No atomic UTXOs available for C-Chain import');
    }
    const feeData = await this.provider.evmRpc.getFeeData();
    const baseFee = feeData.gasPrice ?? BigInt(25_000_000_000);
    const unsignedTx = this.signer.importC(atomicUtxos, sourceChain, baseFee);
    const signedUnsignedTx = await this.signer.signTx({ tx: unsignedTx });
    const signedTx = signedUnsignedTx.getSignedTx();
    const api = this.provider.getApiC();
    const response = await api.issueSignedTx(signedTx);
    return response.txID;
  }

  /** Wait for cross-chain confirmation (atomic UTXOs typically available in 1-3s) */
  private async waitForConfirmation(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
