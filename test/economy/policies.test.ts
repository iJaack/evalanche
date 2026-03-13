import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../../src/economy/policies';
import { EvalancheError, EvalancheErrorCode } from '../../src/utils/errors';
import type { PendingTransaction, SpendingPolicy } from '../../src/economy/types';

/** Helper to create a basic pending tx */
function makeTx(overrides?: Partial<PendingTransaction>): PendingTransaction {
  return {
    to: '0x1234567890abcdef1234567890abcdef12345678',
    value: '100000000000000000', // 0.1 ETH in wei
    chainId: 8453, // Base
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  describe('per-transaction limit', () => {
    it('should allow transactions under the limit', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '200000000000000000' }); // 0.2 ETH
      const result = engine.evaluate(makeTx({ value: '100000000000000000' })); // 0.1 ETH
      expect(result.allowed).toBe(true);
    });

    it('should deny transactions over the limit', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '50000000000000000' }); // 0.05 ETH
      const result = engine.evaluate(makeTx({ value: '100000000000000000' })); // 0.1 ETH
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('per_transaction_limit');
      expect(result.reason).toContain('per-tx limit');
    });

    it('should allow transactions with no value when limit is set', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '50000000000000000' });
      const result = engine.evaluate(makeTx({ value: undefined }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('chain allowlist', () => {
    it('should allow transactions on allowlisted chains', () => {
      const engine = new PolicyEngine({ allowlistedChains: [8453, 43114] });
      const result = engine.evaluate(makeTx({ chainId: 8453 }));
      expect(result.allowed).toBe(true);
    });

    it('should deny transactions on non-allowlisted chains', () => {
      const engine = new PolicyEngine({ allowlistedChains: [8453, 43114] });
      const result = engine.evaluate(makeTx({ chainId: 1 }));
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('chain_not_allowlisted');
    });

    it('should allow any chain when allowlist is empty', () => {
      const engine = new PolicyEngine({ allowlistedChains: [] });
      const result = engine.evaluate(makeTx({ chainId: 999 }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('contract allowlist', () => {
    const allowedContract = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    it('should allow transactions to allowlisted addresses', () => {
      const engine = new PolicyEngine({
        allowlistedContracts: [{ address: allowedContract }],
      });
      const result = engine.evaluate(makeTx({ to: allowedContract }));
      expect(result.allowed).toBe(true);
    });

    it('should deny transactions to non-allowlisted addresses', () => {
      const engine = new PolicyEngine({
        allowlistedContracts: [{ address: allowedContract }],
      });
      const result = engine.evaluate(makeTx({ to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }));
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('contract_not_allowlisted');
    });

    it('should be case-insensitive for address comparison', () => {
      const engine = new PolicyEngine({
        allowlistedContracts: [{ address: allowedContract.toUpperCase() }],
      });
      const result = engine.evaluate(makeTx({ to: allowedContract.toLowerCase() }));
      expect(result.allowed).toBe(true);
    });

    it('should check function selectors when specified', () => {
      const engine = new PolicyEngine({
        allowlistedContracts: [{
          address: allowedContract,
          selectors: ['0xa9059cbb'], // transfer(address,uint256)
        }],
      });

      // Allowed selector
      const allowed = engine.evaluate(makeTx({
        to: allowedContract,
        data: '0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead',
      }));
      expect(allowed.allowed).toBe(true);

      // Disallowed selector
      const denied = engine.evaluate(makeTx({
        to: allowedContract,
        data: '0x095ea7b3000000000000000000000000000000000000000000000000000000000000dead',
      }));
      expect(denied.allowed).toBe(false);
      expect(denied.violationType).toBe('contract_not_allowlisted');
    });

    it('should allow any function when selectors are not specified', () => {
      const engine = new PolicyEngine({
        allowlistedContracts: [{ address: allowedContract }],
      });
      const result = engine.evaluate(makeTx({
        to: allowedContract,
        data: '0x095ea7b3000000000000000000000000000000000000000000000000000000000000dead',
      }));
      expect(result.allowed).toBe(true);
    });
  });

  describe('hourly budget', () => {
    it('should allow spending within hourly budget', () => {
      const engine = new PolicyEngine({ maxPerHour: '500000000000000000' }); // 0.5 ETH
      engine.recordSpend({
        txHash: '0xaaa', amount: '200000000000000000', to: '0x1', chainId: 8453,
        timestamp: Date.now() - 10_000, // 10s ago
      });
      const result = engine.evaluate(makeTx({ value: '200000000000000000' })); // 0.2 + 0.2 = 0.4 < 0.5
      expect(result.allowed).toBe(true);
    });

    it('should deny spending that exceeds hourly budget', () => {
      const engine = new PolicyEngine({ maxPerHour: '300000000000000000' }); // 0.3 ETH
      engine.recordSpend({
        txHash: '0xaaa', amount: '200000000000000000', to: '0x1', chainId: 8453,
        timestamp: Date.now() - 10_000,
      });
      const result = engine.evaluate(makeTx({ value: '200000000000000000' })); // 0.2 + 0.2 = 0.4 > 0.3
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('hourly_budget');
    });

    it('should not count spends older than 1 hour', () => {
      const engine = new PolicyEngine({ maxPerHour: '300000000000000000' });
      engine.recordSpend({
        txHash: '0xold', amount: '200000000000000000', to: '0x1', chainId: 8453,
        timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
      });
      const result = engine.evaluate(makeTx({ value: '200000000000000000' }));
      expect(result.allowed).toBe(true); // Old spend is outside the window
    });
  });

  describe('daily budget', () => {
    it('should deny spending that exceeds daily budget', () => {
      const engine = new PolicyEngine({ maxPerDay: '1000000000000000000' }); // 1 ETH
      engine.recordSpend({
        txHash: '0xaaa', amount: '900000000000000000', to: '0x1', chainId: 8453,
        timestamp: Date.now() - 60_000,
      });
      const result = engine.evaluate(makeTx({ value: '200000000000000000' })); // 0.9 + 0.2 = 1.1 > 1.0
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('daily_budget');
    });
  });

  describe('enforce()', () => {
    it('should throw EvalancheError on violation', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '10' });
      expect(() => engine.enforce(makeTx({ value: '100' }))).toThrow(EvalancheError);
      try {
        engine.enforce(makeTx({ value: '100' }));
      } catch (e) {
        expect((e as EvalancheError).code).toBe(EvalancheErrorCode.POLICY_VIOLATION);
      }
    });

    it('should not throw in dryRun mode', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '10', dryRun: true });
      expect(() => engine.enforce(makeTx({ value: '100' }))).not.toThrow();
    });

    it('should not throw when transaction is allowed', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '1000000000000000000' });
      expect(() => engine.enforce(makeTx())).not.toThrow();
    });
  });

  describe('getBudgetStatus()', () => {
    it('should return correct budget status', () => {
      const engine = new PolicyEngine({
        maxPerHour: '500000000000000000',
        maxPerDay: '2000000000000000000',
      });

      engine.recordSpend({
        txHash: '0xaaa', amount: '100000000000000000', to: '0x1', chainId: 8453,
        timestamp: Date.now() - 30_000,
      });
      engine.recordSpend({
        txHash: '0xbbb', amount: '50000000000000000', to: '0x2', chainId: 8453,
        timestamp: Date.now() - 60_000,
      });

      const status = engine.getBudgetStatus();
      expect(status.spentLastHour).toBe('150000000000000000');
      expect(status.remainingHourly).toBe('350000000000000000');
      expect(status.remainingDaily).toBe('1850000000000000000');
      expect(status.txCountLastHour).toBe(2);
      expect(status.txCountLastDay).toBe(2);
      expect(status.policy).toBeDefined();
    });

    it('should return null for unlimited budgets', () => {
      const engine = new PolicyEngine({});
      const status = engine.getBudgetStatus();
      expect(status.remainingHourly).toBeNull();
      expect(status.remainingDaily).toBeNull();
    });
  });

  describe('updatePolicy()', () => {
    it('should replace the policy but keep spend history', () => {
      const engine = new PolicyEngine({ maxPerTransaction: '100' });
      engine.recordSpend({
        txHash: '0xaaa', amount: '50', to: '0x1', chainId: 8453, timestamp: Date.now(),
      });

      engine.updatePolicy({ maxPerTransaction: '200' });

      expect(engine.policy.maxPerTransaction).toBe('200');
      expect(engine.getSpendHistory()).toHaveLength(1); // History preserved
    });
  });

  describe('combined rules', () => {
    it('should enforce all rules (AND logic)', () => {
      const policy: SpendingPolicy = {
        maxPerTransaction: '1000000000000000000',
        allowlistedChains: [8453],
        allowlistedContracts: [{ address: '0x1234567890abcdef1234567890abcdef12345678' }],
      };
      const engine = new PolicyEngine(policy);

      // All rules pass
      const ok = engine.evaluate(makeTx({ chainId: 8453 }));
      expect(ok.allowed).toBe(true);

      // Chain fails
      const badChain = engine.evaluate(makeTx({ chainId: 1 }));
      expect(badChain.allowed).toBe(false);
      expect(badChain.violationType).toBe('chain_not_allowlisted');

      // Address fails
      const badAddr = engine.evaluate(makeTx({ to: '0xdead', chainId: 8453 }));
      expect(badAddr.allowed).toBe(false);
      expect(badAddr.violationType).toBe('contract_not_allowlisted');
    });
  });

  describe('no policy restrictions', () => {
    it('should allow everything when policy is empty', () => {
      const engine = new PolicyEngine({});
      const result = engine.evaluate(makeTx({ value: '99999999999999999999999', chainId: 999 }));
      expect(result.allowed).toBe(true);
    });
  });
});
