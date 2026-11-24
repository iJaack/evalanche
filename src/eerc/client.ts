/**
 * Private payments with eERC (Encrypted ERC by Ava Labs / AvaCloud).
 *
 * Balances and transfer amounts are encrypted on chain. Sender and recipient
 * stay public, and the contract's auditor can decrypt every transfer.
 * Converter mode only: an existing ERC-20 is deposited into an encrypted
 * balance, sent privately, and withdrawn back. Deposit and withdraw amounts
 * are public; only the transfers between encrypted balances are hidden.
 *
 * The prover is the optional peer dependency `@avalabs/eerc-sdk`, loaded on
 * first use. eERC ships under Ava Labs' Ecosystem License, which covers
 * Avalanche chains only, so this client refuses every other chain.
 */

import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  parseTransaction,
  parseUnits,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';

/** Chains eERC is licensed for: Avalanche C-Chain and Fuji. */
export const EERC_CHAIN_IDS: readonly number[] = [43114, 43113];

export interface EercCircuitFiles {
  /** Path or URL of the circuit's wasm witness generator. */
  wasm: string;
  /** Path or URL of the circuit's proving key. */
  zkey: string;
}

export interface EercCircuits {
  register: EercCircuitFiles;
  transfer: EercCircuitFiles;
  withdraw: EercCircuitFiles;
}

export interface EercConfig {
  /** EncryptedERC contract address, deployed in converter mode. */
  contract: string;
  /** Proving artifacts that match the contract's verifiers. */
  circuits: EercCircuits;
  /** Hex decryption key. When omitted it is derived from a wallet signature, the way the SDK does it. */
  decryptionKey?: string;
  /** Largest amount one deposit, transfer or withdraw may move, as a decimal string in token units. */
  maxAmount?: string;
}

export interface EercBalance {
  token: string;
  /** Decrypted balance in token units. */
  amount: string;
  /** Decrypted balance in eERC base units. */
  raw: string;
  /** Decimals of the encrypted balance (the contract's own, not the token's). */
  decimals: number;
}

export interface EercTxResult {
  txHash: string;
  token?: string;
  amount?: string;
  to?: string;
  approveTxHash?: string;
}

/** The parts of an Evalanche agent this client uses. */
export interface EercAgentLike {
  readonly provider: { send(method: string, params: unknown[]): Promise<unknown> };
  getChainInfo(): { id: number; name: string };
  requireLocalPrivateKey(capability: string): string;
  authorizeTransaction(intent: { to: string; valueWei?: string; data?: string; gasLimit?: bigint }): Promise<void>;
}

type Point = { x: bigint; y: bigint };
type Egct = { c1: Point; c2: Point };
type TxHash = { transactionHash: Hex };

/** The subset of the SDK's `EERC` class used here. */
export interface EercSdk {
  generateDecryptionKey(): Promise<string>;
  register(): Promise<{ key: string; transactionHash: string }>;
  deposit(amount: bigint, tokenAddress: string, eercDecimals: bigint, message?: string): Promise<TxHash>;
  transfer(
    to: string, amount: bigint, encryptedBalance: bigint[], decryptedBalance: bigint,
    auditorPublicKey: bigint[], tokenAddress?: string, message?: string,
  ): Promise<TxHash>;
  withdraw(
    amount: bigint, encryptedBalance: bigint[], decryptedBalance: bigint,
    auditorPublicKey: bigint[], tokenAddress: string, message?: string,
  ): Promise<TxHash>;
  calculateTotalBalance(eGCT: Egct, amountPCTs: { pct: bigint[]; index: bigint }[], balancePCT: bigint[]): bigint;
  setContractAuditorPublicKey(address: Hex): Promise<unknown>;
}

export type EercSdkConstructor = new (
  client: unknown, wallet: unknown, contract: Hex, registrar: Hex,
  isConverter: boolean, circuits: Record<string, EercCircuitFiles>, decryptionKey?: string,
) => EercSdk;

export type EercSdkLoader = () => Promise<{ EERC: EercSdkConstructor }>;

const EERC_ABI = parseAbi([
  'function registrar() view returns (address)',
  'function isConverter() view returns (bool)',
  'function decimals() view returns (uint8)',
  'function isAuditorKeySet() view returns (bool)',
  'function auditorPublicKey() view returns (uint256 x, uint256 y)',
  'function getBalanceFromTokenAddress(address user, address tokenAddress) view returns (((uint256 x, uint256 y) c1, (uint256 x, uint256 y) c2) eGCT, uint256 nonce, (uint256[7] pct, uint256 index)[] amountPCTs, uint256[7] balancePCT, uint256 transactionIndex)',
]);
const REGISTRAR_ABI = parseAbi(['function isUserRegistered(address user) view returns (bool)']);
const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

let sdkModule: Promise<{ EERC: EercSdkConstructor }> | undefined;

/** Load `@avalabs/eerc-sdk` once. Its npm `main` names a file it does not ship, so the ESM entry is tried first. */
export function loadEercSdk(): Promise<{ EERC: EercSdkConstructor }> {
  sdkModule ??= (async () => {
    for (const specifier of ['@avalabs/eerc-sdk/dist/index.js', '@avalabs/eerc-sdk']) {
      try {
        const mod = (await import(specifier)) as { EERC?: EercSdkConstructor };
        if (typeof mod.EERC === 'function') return { EERC: mod.EERC };
      } catch {
        // try the next entry
      }
    }
    sdkModule = undefined;
    throw new EvalancheError(
      'Private eERC payments need the optional package @avalabs/eerc-sdk (npm install @avalabs/eerc-sdk)',
      EvalancheErrorCode.INVALID_CONFIG,
    );
  })();
  return sdkModule;
}

/** Circuit paths for a folder laid out as `<dir>/{register,transfer,withdraw}/circuit.{wasm,zkey}`. */
export function eercCircuitsFromDir(dir: string): EercCircuits {
  const files = (name: string): EercCircuitFiles => ({
    wasm: join(dir, name, 'circuit.wasm'),
    zkey: join(dir, name, 'circuit.zkey'),
  });
  return { register: files('register'), transfer: files('transfer'), withdraw: files('withdraw') };
}

/** Clients that may still prove with the process-wide prover workers. */
const openClients = new Set<EercClient>();

let quietDepth = 0;
let savedLog: typeof console.log | undefined;

/** The SDK logs progress with console.log. Send it to stderr so stdout stays clean for MCP stdio. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  if (quietDepth++ === 0) {
    savedLog = console.log;
    console.log = (...args: unknown[]) => console.error(...args);
  }
  try {
    return await fn();
  } finally {
    if (--quietDepth === 0 && savedLog) console.log = savedLog;
  }
}

function checkAddress(value: string, field: string): Hex {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new EvalancheError(`${field} must be an EVM address`, EvalancheErrorCode.INVALID_PARAMS);
  }
  return getAddress(value);
}

function checkAmount(value: string, field: string): void {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || /^0+(\.0+)?$/.test(value)) {
    throw new EvalancheError(`${field} must be a positive decimal string`, EvalancheErrorCode.INVALID_PARAMS);
  }
}

/** Convert a decimal string to base units, refusing precision the encrypted balance cannot hold. */
function toUnits(value: string, decimals: number, precision: number): bigint {
  checkAmount(value, 'amount');
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > precision) {
    throw new EvalancheError(
      `amount ${value} has more than ${precision} decimals, the precision of this eERC balance`,
      EvalancheErrorCode.INVALID_PARAMS,
    );
  }
  return parseUnits(value, decimals);
}

interface Session {
  sdk: EercSdk;
  read: ReturnType<typeof createPublicClient>;
  write: ReturnType<typeof createWalletClient>;
  address: Hex;
  registrar: Hex;
  decimals: number;
}

/**
 * Private payments through one eERC converter contract.
 * Writes run one at a time: a spend proof is bound to the current encrypted
 * balance, so a second proof built before the first lands would revert.
 */
export class EercClient {
  readonly contract: Hex;
  private readonly agent: EercAgentLike;
  private readonly config: EercConfig;
  private readonly loadSdk: EercSdkLoader;
  private session?: Promise<Session>;
  private queue: Promise<unknown> = Promise.resolve();
  private refusal: unknown;

  constructor(agent: EercAgentLike, config: EercConfig, loadSdk: EercSdkLoader = loadEercSdk) {
    this.contract = checkAddress(config?.contract, 'contract');
    for (const name of ['register', 'transfer', 'withdraw'] as const) {
      const files = config.circuits?.[name];
      if (!files || typeof files.wasm !== 'string' || typeof files.zkey !== 'string' || !files.wasm || !files.zkey) {
        throw new EvalancheError(`circuits.${name} needs wasm and zkey paths`, EvalancheErrorCode.INVALID_CONFIG);
      }
    }
    if (config.maxAmount !== undefined) checkAmount(config.maxAmount, 'maxAmount');
    this.agent = agent;
    this.config = config;
    this.loadSdk = loadSdk;
  }

  /** Whether an address has registered its encryption key. Defaults to this agent. */
  async isRegistered(address?: string): Promise<boolean> {
    const s = await this.connect();
    const user = address === undefined ? s.address : checkAddress(address, 'address');
    return s.read.readContract({ address: s.registrar, abi: REGISTRAR_ABI, functionName: 'isUserRegistered', args: [user] });
  }

  /** Register this agent's encryption key. Needed once, before sending or receiving. */
  async register(): Promise<{ txHash: string | null; alreadyRegistered: boolean }> {
    return this.exclusive(async (s) => {
      if (await this.isRegistered()) return { txHash: null, alreadyRegistered: true };
      const { transactionHash } = await quiet(() => s.sdk.register());
      await this.confirm(s, transactionHash as Hex);
      return { txHash: transactionHash, alreadyRegistered: false };
    });
  }

  /** Decrypt this agent's private balance of a token. */
  async balance(token: string): Promise<EercBalance> {
    const s = await this.connect();
    const tokenAddress = checkAddress(token, 'token');
    const { total } = await this.readBalance(s, tokenAddress);
    return { token: tokenAddress, amount: formatUnits(total, s.decimals), raw: total.toString(), decimals: s.decimals };
  }

  /** Move public tokens into this agent's private balance. The amount is visible on chain. */
  async deposit(token: string, amount: string): Promise<EercTxResult> {
    const tokenAddress = checkAddress(token, 'token');
    checkAmount(amount, 'amount');
    return this.exclusive(async (s) => {
      this.checkCap(amount);
      await this.ready(s);
      const tokenDecimals = Number(await s.read.readContract({ address: tokenAddress, abi: ERC20_ABI, functionName: 'decimals' }));
      const units = toUnits(amount, tokenDecimals, Math.min(tokenDecimals, s.decimals));
      const allowance = await s.read.readContract({
        address: tokenAddress, abi: ERC20_ABI, functionName: 'allowance', args: [s.address, this.contract],
      });
      let approveTxHash: Hex | undefined;
      if (allowance < units) {
        approveTxHash = await s.write.writeContract({
          address: tokenAddress, abi: ERC20_ABI, functionName: 'approve', args: [this.contract, units],
          account: s.write.account!, chain: s.write.chain,
        });
        await this.confirm(s, approveTxHash);
      }
      const { transactionHash } = await quiet(() => s.sdk.deposit(units, tokenAddress, BigInt(s.decimals)));
      await this.confirm(s, transactionHash);
      return { txHash: transactionHash, approveTxHash, token: tokenAddress, amount };
    });
  }

  /** Send a private amount to a registered address. Sender and recipient are public, the amount is not. */
  async transfer(to: string, token: string, amount: string, memo?: string): Promise<EercTxResult> {
    const recipient = checkAddress(to, 'to');
    const tokenAddress = checkAddress(token, 'token');
    checkAmount(amount, 'amount');
    return this.exclusive(async (s) => {
      this.checkCap(amount);
      await this.ready(s);
      const units = toUnits(amount, s.decimals, s.decimals);
      if (!(await this.isRegistered(recipient))) {
        throw new EvalancheError(`${recipient} has not registered for private payments`, EvalancheErrorCode.INVALID_PARAMS);
      }
      const { total, cipher } = await this.spendable(s, tokenAddress, units, amount);
      const auditor = await this.auditorKey(s);
      const { transactionHash } = await quiet(() =>
        s.sdk.transfer(recipient, units, cipher, total, auditor, tokenAddress, memo));
      await this.confirm(s, transactionHash);
      return { txHash: transactionHash, token: tokenAddress, amount, to: recipient };
    });
  }

  /** Move tokens from the private balance back to this agent's public balance. The amount is visible on chain. */
  async withdraw(token: string, amount: string): Promise<EercTxResult> {
    const tokenAddress = checkAddress(token, 'token');
    checkAmount(amount, 'amount');
    return this.exclusive(async (s) => {
      this.checkCap(amount);
      await this.ready(s);
      const units = toUnits(amount, s.decimals, s.decimals);
      const { total, cipher } = await this.spendable(s, tokenAddress, units, amount);
      const auditor = await this.auditorKey(s);
      const { transactionHash } = await quiet(() =>
        s.sdk.withdraw(units, cipher, total, auditor, tokenAddress));
      await this.confirm(s, transactionHash);
      return { txHash: transactionHash, token: tokenAddress, amount };
    });
  }

  /** Point the contract's auditor at a registered address. Only the contract owner can do this. */
  async setAuditor(address: string): Promise<{ txHash: string }> {
    const auditor = checkAddress(address, 'address');
    return this.exclusive(async (s) => {
      if (!(await this.isRegistered(auditor))) {
        throw new EvalancheError(`${auditor} must register before it can be the auditor`, EvalancheErrorCode.INVALID_PARAMS);
      }
      const sent = await quiet(() => s.sdk.setContractAuditorPublicKey(auditor));
      const hash = (typeof sent === 'string' ? sent : (sent as TxHash)?.transactionHash) as Hex;
      await this.confirm(s, hash);
      return { txHash: hash };
    });
  }

  /**
   * Close this client so a script can exit. snarkjs keeps one set of prover worker threads per
   * process (`globalThis.curve_bn128`), shared by every client, so they stop only when the last open
   * client closes, after its pending write. Using the client again reconnects it.
   */
  async close(): Promise<void> {
    await this.queue;
    openClients.delete(this);
    this.session = undefined;
    if (openClients.size > 0) return;
    const curve = (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128;
    if (curve) await curve.terminate();
  }

  private connect(): Promise<Session> {
    this.session ??= this.open().catch((error: unknown) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }

  private async open(): Promise<Session> {
    const { id, name } = this.agent.getChainInfo();
    if (!EERC_CHAIN_IDS.includes(id)) {
      throw new EvalancheError(
        `eERC is licensed for Avalanche chains only; chain ${id} is not Avalanche C-Chain or Fuji`,
        EvalancheErrorCode.INVALID_CONFIG,
      );
    }
    const account = privateKeyToAccount(this.agent.requireLocalPrivateKey('Private eERC payments') as Hex);
    const chain = defineChain({
      id, name, nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }, rpcUrls: { default: { http: [] } },
    });
    // Every transaction the client or the SDK broadcasts passes the agent's spending policy with
    // its real, signed calldata, so contract and selector allowlists and simulateBeforeSend apply.
    // A rejected transaction is never sent.
    const transport = custom({
      request: async ({ method, params }) => {
        const args = (params as unknown[] | undefined) ?? [];
        if (method === 'eth_sendRawTransaction') await this.authorizeBroadcast(args[0] as Hex);
        if (method === 'eth_sendTransaction') {
          throw this.refuse(new EvalancheError(
            'eERC transactions must be signed by the local key', EvalancheErrorCode.POLICY_VIOLATION,
          ));
        }
        return this.agent.provider.send(method, args);
      },
    });
    const read = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    const write = createWalletClient({ account, chain, transport });
    const [registrar, isConverter, decimals] = await Promise.all([
      read.readContract({ address: this.contract, abi: EERC_ABI, functionName: 'registrar' }),
      read.readContract({ address: this.contract, abi: EERC_ABI, functionName: 'isConverter' }),
      read.readContract({ address: this.contract, abi: EERC_ABI, functionName: 'decimals' }),
    ]);
    if (!isConverter) {
      throw new EvalancheError('Only converter-mode eERC contracts are supported', EvalancheErrorCode.INVALID_CONFIG);
    }
    const { EERC } = await this.loadSdk();
    const { register, transfer, withdraw } = this.config.circuits;
    // Mint and burn are standalone-mode circuits and are never proved here.
    const sdk = new EERC(read, write, this.contract, registrar, true,
      { register, transfer, withdraw, mint: register, burn: withdraw }, this.config.decryptionKey);
    if (!this.config.decryptionKey) await quiet(() => sdk.generateDecryptionKey());
    openClients.add(this);
    return { sdk, read, write, address: account.address, registrar, decimals: Number(decimals) };
  }

  private async authorizeBroadcast(raw: Hex): Promise<void> {
    const tx = parseTransaction(raw);
    if (!tx.to) {
      throw this.refuse(new EvalancheError('eERC transactions never deploy contracts', EvalancheErrorCode.POLICY_VIOLATION));
    }
    try {
      await this.agent.authorizeTransaction({
        to: tx.to,
        valueWei: (tx.value ?? 0n).toString(),
        data: tx.data ?? '0x',
        gasLimit: tx.gas,
      });
    } catch (error) {
      throw this.refuse(error);
    }
  }

  /** Remember why a broadcast was refused: viem and the SDK wrap transport errors in generic RPC errors. */
  private refuse(error: unknown): unknown {
    this.refusal = error;
    return error;
  }

  private exclusive<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    // Writes run one at a time, so the refusal recorded during a write belongs to that write.
    const run = this.queue.then(async () => {
      this.refusal = undefined;
      try {
        return await fn(await this.connect());
      } catch (error) {
        throw this.refusal ?? error;
      } finally {
        this.refusal = undefined;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkCap(amount: string): void {
    const cap = this.config.maxAmount;
    if (cap !== undefined && parseUnits(amount, 36) > parseUnits(cap, 36)) {
      throw new EvalancheError(`amount ${amount} exceeds the eERC cap of ${cap}`, EvalancheErrorCode.POLICY_VIOLATION);
    }
  }

  /** Fail early, with a clear message, on the two states the contract would revert on. */
  private async ready(s: Session): Promise<void> {
    if (!(await this.isRegistered())) {
      throw new EvalancheError('Register for private payments first', EvalancheErrorCode.INVALID_PARAMS);
    }
    const auditorSet = await s.read.readContract({ address: this.contract, abi: EERC_ABI, functionName: 'isAuditorKeySet' });
    if (!auditorSet) {
      throw new EvalancheError('This eERC contract has no auditor yet, so it accepts no payments', EvalancheErrorCode.INVALID_CONFIG);
    }
  }

  private async readBalance(s: Session, token: Hex): Promise<{ total: bigint; cipher: bigint[] }> {
    const [eGCT, , amountPCTs, balancePCT] = await s.read.readContract({
      address: this.contract, abi: EERC_ABI, functionName: 'getBalanceFromTokenAddress', args: [s.address, token],
    });
    const cipher = [eGCT.c1.x, eGCT.c1.y, eGCT.c2.x, eGCT.c2.y];
    if (cipher.every((value) => value === 0n)) return { total: 0n, cipher };
    const total = s.sdk.calculateTotalBalance(
      eGCT,
      amountPCTs.map((entry) => ({ pct: [...entry.pct], index: entry.index })),
      [...balancePCT],
    );
    if (total < 0n) {
      throw new EvalancheError('The private balance does not decrypt with this key', EvalancheErrorCode.WALLET_ERROR);
    }
    return { total, cipher };
  }

  private async spendable(s: Session, token: Hex, units: bigint, amount: string): Promise<{ total: bigint; cipher: bigint[] }> {
    const balance = await this.readBalance(s, token);
    if (units > balance.total) {
      throw new EvalancheError(
        `Private balance ${formatUnits(balance.total, s.decimals)} is less than ${amount}`,
        EvalancheErrorCode.INSUFFICIENT_BALANCE,
      );
    }
    return balance;
  }

  private async auditorKey(s: Session): Promise<bigint[]> {
    const [x, y] = await s.read.readContract({ address: this.contract, abi: EERC_ABI, functionName: 'auditorPublicKey' });
    return [x, y];
  }

  private async confirm(s: Session, hash: Hex): Promise<void> {
    const receipt = await s.read.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new EvalancheError(`eERC transaction ${hash} reverted`, EvalancheErrorCode.TRANSACTION_FAILED);
    }
  }
}
