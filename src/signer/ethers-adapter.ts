/**
 * ethers Signer that delegates every signature to a SigningProvider.
 *
 * Contract calls, Li.Fi, vaults, staking, x402, and Hyperliquid all use the
 * ethers signer surface. Those calls land here and leave the process as a
 * canonical signing request. This object never holds a private key.
 */

import { AbstractSigner, getAddress, type Provider, type TransactionRequest, type TypedDataDomain, type TypedDataField } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { assertSigningResult, buildCanonicalRequest } from './remote-client';
import type { SigningContext, SigningProvider, TypedDataPayload } from './intent';

export const SIGNER_MODE = Symbol.for('evalanche.signerMode');
export type SignerMode = 'local' | 'remote' | 'readonly';

export function signerModeOf(signer: object | null | undefined): SignerMode {
  if (!signer || typeof signer !== 'object') return 'readonly';
  const tagged = (signer as Record<symbol, unknown>)[SIGNER_MODE];
  if (tagged === 'remote' || tagged === 'readonly' || tagged === 'local') return tagged;
  const privateKey = (signer as { privateKey?: unknown }).privateKey;
  if (typeof privateKey === 'string' && privateKey.length > 0) return 'local';
  return 'readonly';
}

function keylessError(mode: SignerMode, action: string): EvalancheError {
  const who = mode === 'readonly'
    ? 'An address-only wallet has no key'
    : 'A remote signer keeps the private key out of this process';
  return new EvalancheError(
    `${who}, so ${action} cannot run. Polymarket CLI (POLYMARKET_PRIVATE_KEY) and Avalanche X/P-chain signing need a local private key or mnemonic.`,
    EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED,
  );
}

class RejectingProvider implements SigningProvider {
  readonly kind = 'signing-provider' as const;
  readonly address: string;
  constructor(address: string, private readonly mode: SignerMode) {
    this.address = address;
  }

  async signTransaction(): Promise<never> {
    throw keylessError(this.mode, 'transaction signing');
  }

  async signMessage(): Promise<never> {
    throw keylessError(this.mode, 'message signing');
  }

  async signTypedData(): Promise<never> {
    throw keylessError(this.mode, 'typed-data signing');
  }
}

export class DelegatedEthersSigner extends AbstractSigner {
  readonly address: string;
  /** Present only so local-wallet unions type-check. Always unset here. */
  readonly privateKey?: undefined;
  private context: SigningContext | null = null;

  constructor(
    private readonly backend: SigningProvider,
    provider: Provider | null,
    private readonly chainId: number,
    mode: Exclude<SignerMode, 'local'>,
  ) {
    super(provider);
    this.address = getAddress(backend.address);
    Object.defineProperty(this, SIGNER_MODE, { value: mode });
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: Provider | null): DelegatedEthersSigner {
    const mode = signerModeOf(this);
    const next = new DelegatedEthersSigner(
      this.backend,
      provider,
      this.chainId,
      mode === 'readonly' ? 'readonly' : 'remote',
    );
    next.context = this.context;
    return next;
  }

  setSigningContext(context: SigningContext | null): void {
    this.context = context;
  }

  getSigningContext(): SigningContext | null {
    return this.context;
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const request = buildCanonicalRequest({
      kind: 'transaction',
      chainId: this.chainId,
      from: this.address,
      intent: describeTransaction(tx, this.address, this.chainId),
      context: this.context,
      tx,
    });
    if (request.chainId !== this.chainId) {
      throw new EvalancheError(
        `Signing request chainId ${request.chainId} does not match the wallet chain ${this.chainId}`,
        EvalancheErrorCode.INVALID_PARAMS,
      );
    }
    const result = await this.backend.signTransaction(request);
    assertSigningResult(request, result);
    return result.signedTransaction as string;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const request = buildCanonicalRequest({
      kind: 'message',
      chainId: this.chainId,
      from: this.address,
      intent: this.context?.intent?.trim() || 'Sign message',
      context: this.context,
      message,
    });
    const result = await this.backend.signMessage(request);
    assertSigningResult(request, result);
    return result.signature as string;
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const typedData: TypedDataPayload = {
      domain: domain as Record<string, unknown>,
      types,
      value,
    };
    const name = typeof domain?.name === 'string' ? domain.name : 'typed data';
    const request = buildCanonicalRequest({
      kind: 'typed-data',
      chainId: this.chainId,
      from: this.address,
      intent: this.context?.intent?.trim() || `Sign typed data ${name}`,
      context: this.context,
      typedData,
    });
    const result = await this.backend.signTypedData(request);
    assertSigningResult(request, result);
    return result.signature as string;
  }
}

function describeTransaction(tx: TransactionRequest, from: string, chainId: number): string {
  const to = tx.to ? String(tx.to) : 'contract creation';
  const value = tx.value === undefined || tx.value === null ? '0' : String(tx.value);
  return `transaction chain ${chainId} from ${from} to ${to} value ${value}`;
}

export function createDelegatedSigner(args: {
  backend: SigningProvider;
  provider: Provider | null;
  chainId: number;
  mode?: Exclude<SignerMode, 'local'>;
}): DelegatedEthersSigner {
  return new DelegatedEthersSigner(args.backend, args.provider, args.chainId, args.mode ?? 'remote');
}

export function createReadOnlySigner(address: string, provider: Provider | null, chainId: number): DelegatedEthersSigner {
  const checksum = getAddress(address);
  return new DelegatedEthersSigner(new RejectingProvider(checksum, 'readonly'), provider, chainId, 'readonly');
}
