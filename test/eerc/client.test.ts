import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EercClient, eercCircuitsFromDir, loadEercSdk, type EercAgentLike, type EercSdk } from '../../src/eerc/client';
import { EvalancheError, EvalancheErrorCode } from '../../src/utils/errors';

const KEY = `0x${'11'.repeat(32)}` as Hex;
const ME = privateKeyToAccount(KEY).address;
const CONTRACT = '0x1000000000000000000000000000000000000001';
const REGISTRAR = '0x2000000000000000000000000000000000000002';
const TOKEN = '0x3000000000000000000000000000000000000003';
const BOB = '0x4000000000000000000000000000000000000004';
const SDK_TX = `0x${'bb'.repeat(32)}` as Hex;
const RAW_TX = `0x${'aa'.repeat(32)}` as Hex;
const CIRCUITS = eercCircuitsFromDir('/circuits');

const ABI = parseAbi([
  'function registrar() view returns (address)',
  'function isConverter() view returns (bool)',
  'function decimals() view returns (uint8)',
  'function isAuditorKeySet() view returns (bool)',
  'function auditorPublicKey() view returns (uint256 x, uint256 y)',
  'function getBalanceFromTokenAddress(address user, address tokenAddress) view returns (((uint256 x, uint256 y) c1, (uint256 x, uint256 y) c2) eGCT, uint256 nonce, (uint256[7] pct, uint256 index)[] amountPCTs, uint256[7] balancePCT, uint256 transactionIndex)',
  'function isUserRegistered(address user) view returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const ZERO7 = [0n, 0n, 0n, 0n, 0n, 0n, 0n] as const;

interface Chain {
  chainId: number;
  converter: boolean;
  registered: Set<string>;
  auditorSet: boolean;
  allowance: bigint;
  cipher: [bigint, bigint, bigint, bigint];
  reverted: Set<string>;
  sent: string[];
}

function makeChain(overrides: Partial<Chain> = {}): Chain {
  return {
    chainId: 43113,
    converter: true,
    registered: new Set([ME.toLowerCase(), BOB.toLowerCase()]),
    auditorSet: true,
    allowance: 0n,
    cipher: [1n, 2n, 3n, 4n],
    reverted: new Set(),
    sent: [],
    ...overrides,
  };
}

function read(chain: Chain, to: string, functionName: string, args: readonly unknown[]): unknown {
  switch (functionName) {
    case 'registrar': return REGISTRAR;
    case 'isConverter': return chain.converter;
    case 'decimals': return to.toLowerCase() === CONTRACT.toLowerCase() ? 2 : 18;
    case 'isAuditorKeySet': return chain.auditorSet;
    case 'auditorPublicKey': return [7n, 8n];
    case 'isUserRegistered': return chain.registered.has(String(args[0]).toLowerCase());
    case 'allowance': return chain.allowance;
    case 'getBalanceFromTokenAddress': {
      const [c1x, c1y, c2x, c2y] = chain.cipher;
      return [{ c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y } }, 0n, [{ pct: ZERO7, index: 1n }], ZERO7, 0n];
    }
    default: throw new Error(`unexpected read ${functionName}`);
  }
}

function makeAgent(chain: Chain, authorize = vi.fn(async () => undefined)): EercAgentLike & { authorize: typeof authorize } {
  const send = async (method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_chainId': return toHex(chain.chainId);
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: Hex };
        const { functionName, args } = decodeFunctionData({ abi: ABI, data });
        return encodeFunctionResult({ abi: ABI, functionName, result: read(chain, to, functionName, args ?? []) as never });
      }
      case 'eth_getTransactionCount': return '0x0';
      case 'eth_estimateGas': return '0x5208';
      case 'eth_maxPriorityFeePerGas':
      case 'eth_gasPrice': return '0x1';
      case 'eth_blockNumber': return '0x10';
      case 'eth_getBlockByNumber':
        return { number: '0x10', hash: `0x${'11'.repeat(32)}`, baseFeePerGas: '0x1', timestamp: '0x1', transactions: [] };
      case 'eth_sendRawTransaction':
        chain.sent.push(params[0] as string);
        return RAW_TX;
      case 'eth_getTransactionReceipt': {
        const hash = params[0] as string;
        return {
          transactionHash: hash, blockHash: `0x${'22'.repeat(32)}`, blockNumber: '0x10', transactionIndex: '0x0',
          status: chain.reverted.has(hash) ? '0x0' : '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
          cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', from: ME, to: CONTRACT,
          contractAddress: null, type: '0x2',
        };
      }
      default: throw new Error(`unexpected RPC ${method}`);
    }
  };
  return {
    provider: { send },
    getChainInfo: () => ({ id: chain.chainId, name: 'Avalanche Fuji' }),
    requireLocalPrivateKey: () => KEY,
    authorizeTransaction: authorize,
    authorize,
  };
}

// Stand-in calldata for each SDK write; the real SDK sends its proofs the same way, through the wallet it is given.
const SEL = {
  register: '0x11111111',
  deposit: '0x22222222',
  transfer: '0x33333333',
  withdraw: '0x44444444',
  setAuditor: '0x55555555',
} as const;

type FakeWallet = {
  account: unknown;
  chain: unknown;
  sendTransaction(tx: Record<string, unknown>): Promise<Hex>;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

function makeSdk(total = 500n) {
  let wallet: FakeWallet | undefined;
  const send = async (data: Hex, to: string = CONTRACT) => {
    await wallet!.sendTransaction({ to, data, account: wallet!.account, chain: wallet!.chain });
    return { transactionHash: SDK_TX };
  };
  const sdk = {
    generateDecryptionKey: vi.fn(async () => 'beef'),
    register: vi.fn(async () => ({ key: 'beef', ...(await send(`${SEL.register}00`, REGISTRAR)) })),
    deposit: vi.fn(async () => send(`${SEL.deposit}00`)),
    transfer: vi.fn(async () => send(`${SEL.transfer}00`)),
    withdraw: vi.fn(async () => send(`${SEL.withdraw}00`)),
    calculateTotalBalance: vi.fn(() => total),
    setContractAuditorPublicKey: vi.fn(async () => (await send(`${SEL.setAuditor}00`)).transactionHash),
  } satisfies EercSdk;
  const constructed: unknown[][] = [];
  const loader = vi.fn(async () => ({
    EERC: class {
      constructor(...args: unknown[]) {
        constructed.push(args);
        wallet = args[1] as FakeWallet;
        return sdk;
      }
    } as never,
  }));
  return { sdk, loader, constructed, wallet: () => wallet! };
}

function client(chain: Chain, sdkTotal = 500n, config: Partial<Parameters<typeof makeClient>[1]> = {}) {
  return makeClient(chain, { contract: CONTRACT, circuits: CIRCUITS, ...config }, sdkTotal);
}

function makeClient(chain: Chain, config: ConstructorParameters<typeof EercClient>[1], sdkTotal: bigint) {
  const agent = makeAgent(chain);
  const handles = makeSdk(sdkTotal);
  makeSdkHandles.last = handles;
  const { sdk, loader, constructed } = handles;
  const { wallet } = makeSdkHandles.last!;
  const eerc = new EercClient(agent, config, loader);
  created.push(eerc);
  return { eerc, agent, sdk, loader, constructed, wallet };
}

const makeSdkHandles: { last?: ReturnType<typeof makeSdk> } = {};

async function expectCode(promise: Promise<unknown>, code: EvalancheErrorCode, message?: RegExp) {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(EvalancheError);
  expect((error as EvalancheError).code).toBe(code);
  if (message) expect((error as Error).message).toMatch(message);
}

// Every client a test opens is closed afterwards, so open clients never leak between tests.
const created: EercClient[] = [];
type CurveHolder = { curve_bn128?: { terminate(): Promise<void> } | null };

afterEach(async () => {
  (globalThis as CurveHolder).curve_bn128 = null;
  await Promise.all(created.splice(0).map((eerc) => eerc.close().catch(() => undefined)));
  vi.restoreAllMocks();
});

function fakeProver() {
  const terminate = vi.fn(async () => {
    (globalThis as CurveHolder).curve_bn128 = null;
  });
  (globalThis as CurveHolder).curve_bn128 = { terminate };
  return terminate;
}

describe('EercClient close', () => {
  it('keeps the shared prover running while another client is open', async () => {
    const first = client(makeChain());
    const second = client(makeChain());
    await first.eerc.balance(TOKEN);
    await second.eerc.balance(TOKEN);
    const terminate = fakeProver();
    await first.eerc.close();
    expect(terminate).not.toHaveBeenCalled();
    await second.eerc.close();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('lets its own pending write finish before stopping the prover', async () => {
    const { eerc, sdk } = client(makeChain(), 10_000n);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sdk.transfer.mockImplementationOnce(async () => {
      await gate;
      return { transactionHash: SDK_TX };
    });
    const pending = eerc.transfer(BOB, TOKEN, '1');
    await vi.waitFor(() => expect(sdk.transfer).toHaveBeenCalled());
    const terminate = fakeProver();
    const closing = eerc.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(terminate).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toBeDefined();
    await closing;
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('reconnects when a closed client is used again', async () => {
    const { eerc, constructed } = client(makeChain(), 1234n);
    await eerc.balance(TOKEN);
    await eerc.close();
    await expect(eerc.balance(TOKEN)).resolves.toMatchObject({ amount: '12.34' });
    expect(constructed).toHaveLength(2);
  });
});

describe('EercClient setup', () => {
  it('rejects a bad contract address and missing circuit files', () => {
    const agent = makeAgent(makeChain());
    expect(() => new EercClient(agent, { contract: 'nope', circuits: CIRCUITS })).toThrow(/contract must be an EVM address/);
    expect(() => new EercClient(agent, {
      contract: CONTRACT,
      circuits: { ...CIRCUITS, withdraw: { wasm: '/w.wasm', zkey: '' } },
    })).toThrow(/circuits.withdraw needs wasm and zkey/);
    expect(() => new EercClient(agent, { contract: CONTRACT, circuits: CIRCUITS, maxAmount: '-1' })).toThrow(/maxAmount/);
  });

  it('lays out circuit paths from one folder', () => {
    expect(CIRCUITS.transfer).toEqual({ wasm: '/circuits/transfer/circuit.wasm', zkey: '/circuits/transfer/circuit.zkey' });
  });

  it('refuses chains that are not Avalanche C-Chain or Fuji, before loading the SDK', async () => {
    const { eerc, loader } = client(makeChain({ chainId: 8453 }));
    await expectCode(eerc.balance(TOKEN), EvalancheErrorCode.INVALID_CONFIG, /Avalanche chains only/);
    expect(loader).not.toHaveBeenCalled();
  });

  it('refuses a standalone-mode contract', async () => {
    const { eerc } = client(makeChain({ converter: false }));
    await expectCode(eerc.balance(TOKEN), EvalancheErrorCode.INVALID_CONFIG, /converter-mode/);
  });

  it('needs a local key', async () => {
    const chain = makeChain();
    const agent = makeAgent(chain);
    agent.requireLocalPrivateKey = () => {
      throw new EvalancheError('no key', EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED);
    };
    const { loader } = makeSdk();
    await expectCode(new EercClient(agent, { contract: CONTRACT, circuits: CIRCUITS }, loader).balance(TOKEN),
      EvalancheErrorCode.REMOTE_SIGNER_UNSUPPORTED);
  });

  it('explains how to install the SDK when it is missing', async () => {
    await expectCode(loadEercSdk(), EvalancheErrorCode.INVALID_CONFIG, /npm install @avalabs\/eerc-sdk/);
  });

  it('builds the SDK once, passes the circuits, and derives the key only when none is given', async () => {
    const { eerc, sdk, loader, constructed } = client(makeChain());
    await eerc.balance(TOKEN);
    await eerc.balance(TOKEN);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sdk.generateDecryptionKey).toHaveBeenCalledTimes(1);
    const [, , contract, registrar, isConverter, circuits, key] = constructed[0];
    expect([contract, registrar, isConverter, key]).toEqual([CONTRACT, REGISTRAR, true, undefined]);
    expect(circuits).toMatchObject({ register: CIRCUITS.register, transfer: CIRCUITS.transfer, withdraw: CIRCUITS.withdraw });

    const withKey = client(makeChain(), 500n, { decryptionKey: 'abcd' });
    await withKey.eerc.balance(TOKEN);
    expect(withKey.sdk.generateDecryptionKey).not.toHaveBeenCalled();
    expect(withKey.constructed[0][6]).toBe('abcd');
  });

  it('retries setup after a failure instead of caching it', async () => {
    const chain = makeChain({ chainId: 1 });
    const { eerc } = client(chain);
    await expectCode(eerc.balance(TOKEN), EvalancheErrorCode.INVALID_CONFIG);
    chain.chainId = 43113;
    await expect(eerc.balance(TOKEN)).resolves.toMatchObject({ amount: '5' });
  });
});

describe('EercClient reads', () => {
  it('reports registration for the agent and for other addresses', async () => {
    const chain = makeChain({ registered: new Set([BOB.toLowerCase()]) });
    const { eerc } = client(chain);
    expect(await eerc.isRegistered()).toBe(false);
    expect(await eerc.isRegistered(BOB)).toBe(true);
    await expectCode(eerc.isRegistered('0x123'), EvalancheErrorCode.INVALID_PARAMS);
  });

  it('decrypts the balance in the contract decimals', async () => {
    const { eerc, sdk } = client(makeChain(), 1234n);
    expect(await eerc.balance(TOKEN)).toEqual({ token: TOKEN, amount: '12.34', raw: '1234', decimals: 2 });
    const [eGCT, amountPCTs, balancePCT] = sdk.calculateTotalBalance.mock.calls[0] as unknown as [unknown, unknown[], bigint[]];
    expect(eGCT).toEqual({ c1: { x: 1n, y: 2n }, c2: { x: 3n, y: 4n } });
    expect(amountPCTs).toEqual([{ pct: [...ZERO7], index: 1n }]);
    expect(balancePCT).toHaveLength(7);
  });

  it('reads an untouched balance as zero without decrypting', async () => {
    const { eerc, sdk } = client(makeChain({ cipher: [0n, 0n, 0n, 0n] }));
    expect((await eerc.balance(TOKEN)).amount).toBe('0');
    expect(sdk.calculateTotalBalance).not.toHaveBeenCalled();
  });

  it('fails when the balance does not decrypt with this key', async () => {
    const { eerc } = client(makeChain(), -1n);
    await expectCode(eerc.balance(TOKEN), EvalancheErrorCode.WALLET_ERROR, /does not decrypt/);
  });
});

describe('EercClient writes', () => {
  it('registers once and skips when already registered', async () => {
    const chain = makeChain({ registered: new Set() });
    const { eerc, sdk, agent } = client(chain);
    expect(await eerc.register()).toEqual({ txHash: SDK_TX, alreadyRegistered: false });
    expect(agent.authorize).toHaveBeenCalledWith(expect.objectContaining({ to: REGISTRAR, data: `${SEL.register}00` }));
    chain.registered.add(ME.toLowerCase());
    expect(await eerc.register()).toEqual({ txHash: null, alreadyRegistered: true });
    expect(sdk.register).toHaveBeenCalledTimes(1);
  });

  it('approves the exact amount, then deposits in token units', async () => {
    const chain = makeChain();
    const { eerc, sdk, agent } = client(chain);
    const result = await eerc.deposit(TOKEN, '12.5');
    expect(chain.sent).toHaveLength(2);
    expect(result).toEqual({ txHash: SDK_TX, approveTxHash: RAW_TX, token: TOKEN, amount: '12.5' });
    expect(sdk.deposit).toHaveBeenCalledWith(12_500_000_000_000_000_000n, TOKEN, 2n);
    const [approve, deposit] = agent.authorize.mock.calls.map(([intent]) => intent as { to: string; data: string; valueWei: string });
    expect(approve.to).toBe(TOKEN);
    expect(approve.data.startsWith('0x095ea7b3')).toBe(true);
    expect(approve.valueWei).toBe('0');
    expect(deposit).toMatchObject({ to: CONTRACT, data: `${SEL.deposit}00` });
  });

  it('skips the approval when the allowance already covers the deposit', async () => {
    const chain = makeChain({ allowance: 10n ** 30n });
    const { eerc } = client(chain);
    const result = await eerc.deposit(TOKEN, '1');
    expect(chain.sent).toHaveLength(1);
    expect(result.approveTxHash).toBeUndefined();
  });

  it('refuses precision the encrypted balance cannot hold, instead of refunding dust', async () => {
    const { eerc, sdk } = client(makeChain());
    await expectCode(eerc.deposit(TOKEN, '1.005'), EvalancheErrorCode.INVALID_PARAMS, /more than 2 decimals/);
    expect(sdk.deposit).not.toHaveBeenCalled();
  });

  it('checks registration and the auditor before depositing', async () => {
    const unregistered = client(makeChain({ registered: new Set() }));
    await expectCode(unregistered.eerc.deposit(TOKEN, '1'), EvalancheErrorCode.INVALID_PARAMS, /Register/);
    const noAuditor = client(makeChain({ auditorSet: false }));
    await expectCode(noAuditor.eerc.deposit(TOKEN, '1'), EvalancheErrorCode.INVALID_CONFIG, /no auditor/);
  });

  it('sends a private transfer with the current cipher, balance, auditor key and memo', async () => {
    const { eerc, sdk, agent } = client(makeChain(), 500n);
    const result = await eerc.transfer(BOB, TOKEN, '1.25', 'invoice 7');
    expect(result).toEqual({ txHash: SDK_TX, token: TOKEN, amount: '1.25', to: BOB });
    expect(sdk.transfer).toHaveBeenCalledWith(BOB, 125n, [1n, 2n, 3n, 4n], 500n, [7n, 8n], TOKEN, 'invoice 7');
    expect(agent.authorize).toHaveBeenCalledWith(expect.objectContaining({ to: CONTRACT, data: `${SEL.transfer}00`, valueWei: '0' }));
  });

  it('refuses unregistered recipients and amounts above the private balance', async () => {
    const chain = makeChain({ registered: new Set([ME.toLowerCase()]) });
    const { eerc, sdk } = client(chain, 100n);
    await expectCode(eerc.transfer(BOB, TOKEN, '0.5'), EvalancheErrorCode.INVALID_PARAMS, /has not registered/);
    chain.registered.add(BOB.toLowerCase());
    await expectCode(eerc.transfer(BOB, TOKEN, '1.01'), EvalancheErrorCode.INSUFFICIENT_BALANCE, /less than 1.01/);
    expect(sdk.transfer).not.toHaveBeenCalled();
  });

  it('withdraws with a proof against the current balance', async () => {
    const { eerc, sdk } = client(makeChain(), 500n);
    await expect(eerc.withdraw(TOKEN, '5')).resolves.toEqual({ txHash: SDK_TX, token: TOKEN, amount: '5' });
    expect(sdk.withdraw).toHaveBeenCalledWith(500n, [1n, 2n, 3n, 4n], 500n, [7n, 8n], TOKEN);
  });

  it('enforces the per-payment cap before touching the chain', async () => {
    const { eerc, sdk, agent } = client(makeChain(), 10_000n, { maxAmount: '50' });
    await expectCode(eerc.transfer(BOB, TOKEN, '50.01'), EvalancheErrorCode.POLICY_VIOLATION, /cap of 50/);
    await expectCode(eerc.withdraw(TOKEN, '51'), EvalancheErrorCode.POLICY_VIOLATION);
    await expectCode(eerc.deposit(TOKEN, '60'), EvalancheErrorCode.POLICY_VIOLATION);
    await expect(eerc.transfer(BOB, TOKEN, '50')).resolves.toBeDefined();
    expect(sdk.transfer).toHaveBeenCalledTimes(1);
    expect(sdk.withdraw).not.toHaveBeenCalled();
    expect(agent.authorize).toHaveBeenCalledTimes(1);
  });

  it('never broadcasts a transaction the spending policy rejects', async () => {
    const chain = makeChain();
    const agent = makeAgent(chain, vi.fn(async () => {
      throw new EvalancheError('blocked', EvalancheErrorCode.POLICY_VIOLATION);
    }));
    const { loader } = makeSdk();
    const eerc = new EercClient(agent, { contract: CONTRACT, circuits: CIRCUITS }, loader);
    await expectCode(eerc.transfer(BOB, TOKEN, '1'), EvalancheErrorCode.POLICY_VIOLATION);
    expect(chain.sent).toHaveLength(0);
  });

  it('checks the real calldata, so a selector allowlist on the contract applies', async () => {
    const chain = makeChain();
    // Allow the eERC contract for transfer only, the way allowlistedContracts selectors work.
    const agent = makeAgent(chain, vi.fn(async (intent: { to: string; data?: string }) => {
      if (intent.to.toLowerCase() === CONTRACT.toLowerCase() && !intent.data?.startsWith(SEL.transfer)) {
        throw new EvalancheError(`selector ${intent.data?.slice(0, 10)} not allowed`, EvalancheErrorCode.POLICY_VIOLATION);
      }
    }));
    const { loader } = makeSdk(10_000n);
    const eerc = new EercClient(agent, { contract: CONTRACT, circuits: CIRCUITS }, loader);
    await expect(eerc.transfer(BOB, TOKEN, '1')).resolves.toBeDefined();
    await expectCode(eerc.withdraw(TOKEN, '1'), EvalancheErrorCode.POLICY_VIOLATION, /0x44444444/);
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses unsigned sends that would skip the local key and the policy', async () => {
    const { eerc, sdk, wallet } = client(makeChain());
    sdk.transfer.mockImplementationOnce(async () => {
      await wallet().request({ method: 'eth_sendTransaction', params: [{ to: CONTRACT, data: SEL.transfer }] });
      return { transactionHash: SDK_TX };
    });
    await expectCode(eerc.transfer(BOB, TOKEN, '1'), EvalancheErrorCode.POLICY_VIOLATION, /signed by the local key/);
  });

  it('reports a reverted transaction', async () => {
    const chain = makeChain();
    chain.reverted.add(SDK_TX);
    const { eerc } = client(chain);
    await expectCode(eerc.transfer(BOB, TOKEN, '1'), EvalancheErrorCode.TRANSACTION_FAILED, /reverted/);
  });

  it('runs writes one at a time, so each proof sees the balance the previous one left', async () => {
    const { eerc, sdk } = client(makeChain(), 10_000n);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    sdk.transfer.mockImplementationOnce(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      return { transactionHash: SDK_TX };
    });
    sdk.withdraw.mockImplementationOnce(async () => {
      order.push('second');
      return { transactionHash: SDK_TX };
    });
    const first = eerc.transfer(BOB, TOKEN, '1');
    const second = eerc.withdraw(TOKEN, '1');
    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('keeps the queue moving after a failed write', async () => {
    const { eerc, sdk } = client(makeChain(), 10_000n);
    sdk.transfer.mockRejectedValueOnce(new Error('InvalidProof'));
    await expect(eerc.transfer(BOB, TOKEN, '1')).rejects.toThrow('InvalidProof');
    await expect(eerc.withdraw(TOKEN, '1')).resolves.toBeDefined();
  });

  it('routes the SDK console.log output to stderr and restores console.log', async () => {
    const { eerc, sdk } = client(makeChain());
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = console.log;
    sdk.transfer.mockImplementationOnce(async () => {
      console.log('[EERC] proving');
      return { transactionHash: SDK_TX };
    });
    await eerc.transfer(BOB, TOKEN, '1');
    expect(stderr).toHaveBeenCalledWith('[EERC] proving');
    expect(console.log).toBe(original);
  });

  it('sets the auditor only to a registered address', async () => {
    const chain = makeChain({ registered: new Set([ME.toLowerCase()]) });
    const { eerc, sdk } = client(chain);
    await expectCode(eerc.setAuditor(BOB), EvalancheErrorCode.INVALID_PARAMS, /must register/);
    chain.registered.add(BOB.toLowerCase());
    await expect(eerc.setAuditor(BOB)).resolves.toEqual({ txHash: SDK_TX });
    expect(sdk.setContractAuditorPublicKey).toHaveBeenCalledWith(BOB);
  });
});
