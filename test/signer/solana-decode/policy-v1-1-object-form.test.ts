/**
 * PR3 spec v1.1 handed-actions object form (#40 @2d7c108).
 * A) Regression pins: symbol keys, Proxy elements, index accessors, prototype iterators and null-prototype
 *    actions are rejected as SOL_DENY_ACTIONS_MISMATCH (no instructionIndex) without running user code.
 * B) Builder's conservative decision: every handed array (the outer list and each impliedCpiPrograms) must have
 *    exactly this realm's Array.prototype. Data below is otherwise identical to the decode.
 */
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import vectorsJson from '../fixtures/solana-decode/policy-vectors.json';
import { assertIntent, expectDeny, mod, parse, policyContext, requireFn } from './helpers';

const vectors: any[] = vectorsJson;
const check = requireFn(mod, 'assertSolanaActionsAllowed');
const decodeMessage = (bytes: Uint8Array) => requireFn(mod, 'decodeSolanaMessage')(parse(bytes));
async function setup(id: string) {
  const v = vectors.find(v => v.id === id);
  const bytes = Buffer.from(v.messageHex, 'hex');
  const intent = structuredClone(v.intent);
  assertIntent(intent);
  const context = await policyContext(parse(bytes).staticAccountKeys[0], v.configProfile);
  return { v, bytes, actions: decodeMessage(bytes) as any[], intent, context };
}
const MISMATCH = 'SOL_DENY_ACTIONS_MISMATCH';
/** expectDeny plus "no instructionIndex", naming what actually happened when it fails. */
function deniedNoIndex(fn: () => unknown) {
  let caught: any; let outcome = 'allowed';
  try {
    expectDeny(() => { try { return fn(); } catch (error) {
      caught = error;
      outcome = error instanceof Error ? `${error.name}${'reason' in error ? ` ${String((error as any).reason)}` : ''}: ${error.message}` : String(error);
      throw error; } }, MISMATCH);
  } catch (error) {
    if (error instanceof Error) error.message = `expected ${MISMATCH} but got ${outcome}\n${error.message}`;
    throw error;
  }
  expect(caught.instructionIndex).toBeUndefined();
}
/** A Proxy that counts every trap it runs. */
function counted<T extends object>(target: T, counter: { n: number }): T {
  const handler: ProxyHandler<T> = {};
  for (const trap of ['get', 'set', 'has', 'ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'defineProperty',
    'deleteProperty', 'isExtensible', 'preventExtensions', 'setPrototypeOf'] as const) {
    (handler as any)[trap] = (...args: unknown[]) => { counter.n++; return (Reflect as any)[trap](...args); };
  }
  return new Proxy(target, handler);
}

describe('A) v1.1 object-form regression pins: ACTIONS_MISMATCH, no index, no user code', () => {
  it('an action with an own symbol key', async () => {
    const b = await setup('approve');
    const actions = b.actions.map(a => a.instructionIndex === 2 ? { ...a, [Symbol('extra')]: 1 } : a);
    deniedNoIndex(() => check(actions, b.context, b.intent));
  });
  it('a faithful Proxy action element: denied and no trap runs', async () => {
    const b = await setup('approve');
    const counter = { n: 0 };
    const actions = b.actions.map(a => a.instructionIndex === 2 ? counted({ ...a }, counter) : a);
    deniedNoIndex(() => check(actions, b.context, b.intent));
    expect(counter.n).toBe(0);
  });
  it('an accessor on array index "0" returning the correct action: denied and the getter never runs', async () => {
    const b = await setup('approve');
    let reads = 0;
    const actions = [...b.actions];
    const first = actions[0];
    Object.defineProperty(actions, '0', { get: () => { reads++; return first; }, enumerable: true, configurable: true });
    deniedNoIndex(() => check(actions, b.context, b.intent));
    expect(reads).toBe(0);
  });
  it('an Array subclass whose prototype iterator counts calls: denied and the iterator never runs', async () => {
    const b = await setup('approve');
    let calls = 0;
    class Counted extends Array {}
    Object.defineProperty(Counted.prototype, Symbol.iterator, {
      value: function (this: unknown[]) { calls++; return Array.prototype.values.call(this); }, configurable: true, writable: true });
    const actions = new Counted();
    for (let i = 0; i < b.actions.length; i++) Array.prototype.push.call(actions, b.actions[i]);
    calls = 0;
    deniedNoIndex(() => check(actions, b.context, b.intent));
    expect(calls).toBe(0);
  });
  it('a null-prototype action', async () => {
    const b = await setup('approve');
    const actions = b.actions.map(a => a.instructionIndex === 2 ? Object.assign(Object.create(null), a) : a);
    deniedNoIndex(() => check(actions, b.context, b.intent));
  });
});

describe('B) Builder decision: handed arrays must have exactly Array.prototype', () => {
  class Sub extends Array {}
  const variants: Array<[string, (items: unknown[]) => unknown[]]> = [
    ['Array subclass', items => { const s = new Sub(); for (let i = 0; i < items.length; i++) Array.prototype.push.call(s, items[i]); return s; }],
    ['null-prototype array', items => Object.setPrototypeOf([...items], null)],
    ['Object.prototype-prototype array', items => Object.setPrototypeOf([...items], Object.prototype)],
    ['cross-realm array (vm)', items => {
      const c = vm.runInNewContext('[]') as unknown[];
      for (let i = 0; i < items.length; i++) Array.prototype.push.call(c, items[i]);
      return c;
    }],
  ];
  for (const [name, make] of variants) {
    it(`outer actions as ${name}, data identical to the decode -> ACTIONS_MISMATCH`, async () => {
      const b = await setup('approve');
      const actions = make(b.actions);
      expect(Array.isArray(actions)).toBe(true);
      expect([...Array.prototype.slice.call(actions)]).toEqual(b.actions);
      deniedNoIndex(() => check(actions, b.context, b.intent));
    });
    it(`impliedCpiPrograms as ${name}, data identical to the decode -> ACTIONS_MISMATCH`, async () => {
      const b = await setup('usdc-ata-1');
      const ata = b.actions.find(a => a.kind === 'ata.create');
      expect(ata?.impliedCpiPrograms?.length).toBeGreaterThan(0);
      const programs = make(ata.impliedCpiPrograms);
      expect(Array.isArray(programs)).toBe(true);
      expect([...Array.prototype.slice.call(programs)]).toEqual(ata.impliedCpiPrograms);
      const actions = b.actions.map(a => a === ata ? { ...a, impliedCpiPrograms: programs } : a);
      deniedNoIndex(() => check(actions, b.context, b.intent));
    });
  }
  it('positive control: fresh same-realm arrays (outer and impliedCpiPrograms) with identical data are allowed', async () => {
    const b = await setup('usdc-ata-1');
    const expected = check(b.actions, b.context, b.intent);
    const actions = b.actions.map(a => a.kind === 'ata.create' ? { ...a, impliedCpiPrograms: [...a.impliedCpiPrograms] } : { ...a });
    expect(Object.getPrototypeOf(actions)).toBe(Array.prototype);
    expect(check([...actions], b.context, b.intent)).toEqual(expected);
  });
});
