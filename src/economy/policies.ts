import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type {
  SpendingPolicy,
  SpendRecord,
  BudgetStatus,
  PolicyEvaluation,
  PendingTransaction,
} from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * PolicyEngine evaluates outbound transactions against a SpendingPolicy
 * and tracks cumulative spending over rolling time windows.
 *
 * Usage:
 * ```ts
 * const engine = new PolicyEngine({
 *   maxPerTransaction: '100000000000000000',  // 0.1 ETH
 *   maxPerDay: '1000000000000000000',         // 1 ETH
 *   allowlistedChains: [8453, 43114],         // Base + Avalanche only
 * });
 *
 * const result = engine.evaluate({ to: '0x...', value: '50000000000000000', chainId: 8453 });
 * if (!result.allowed) throw new Error(result.reason);
 *
 * // After tx confirms, record the spend:
 * engine.recordSpend({ txHash: '0x...', amount: '50000000000000000', to: '0x...', chainId: 8453, timestamp: Date.now() });
 * ```
 */
export class PolicyEngine {
  private _policy: SpendingPolicy;
  private _spendHistory: SpendRecord[] = [];

  constructor(policy: SpendingPolicy) {
    this._policy = { ...policy };
  }

  /** Get the current policy */
  get policy(): SpendingPolicy {
    return { ...this._policy };
  }

  /** Replace the current policy. Does NOT reset spend history. */
  updatePolicy(policy: SpendingPolicy): void {
    this._policy = { ...policy };
  }

  /**
   * Evaluate a pending transaction against the current policy.
   * Returns { allowed: true } if all rules pass, or { allowed: false, reason, violationType } if any rule fails.
   */
  evaluate(tx: PendingTransaction): PolicyEvaluation {
    const p = this._policy;

    // 1. Chain allowlist
    if (p.allowlistedChains && p.allowlistedChains.length > 0) {
      if (!p.allowlistedChains.includes(tx.chainId)) {
        return this._deny(
          `Chain ${tx.chainId} is not in the allowlist [${p.allowlistedChains.join(', ')}]`,
          'chain_not_allowlisted',
        );
      }
    }

    // 2. Contract/address allowlist
    if (p.allowlistedContracts && p.allowlistedContracts.length > 0) {
      const target = tx.to.toLowerCase();
      const entry = p.allowlistedContracts.find(
        (e) => e.address.toLowerCase() === target,
      );
      if (!entry) {
        return this._deny(
          `Address ${tx.to} is not in the contract allowlist`,
          'contract_not_allowlisted',
        );
      }
      // Check function selector if calldata present and selectors are restricted
      if (entry.selectors && entry.selectors.length > 0 && tx.data && tx.data.length >= 10) {
        const selector = tx.data.slice(0, 10).toLowerCase();
        const allowed = entry.selectors.map((s) => s.toLowerCase());
        if (!allowed.includes(selector)) {
          return this._deny(
            `Function selector ${selector} is not allowed on ${tx.to}. Allowed: [${allowed.join(', ')}]`,
            'contract_not_allowlisted',
          );
        }
      }
    }

    // 3. Per-transaction limit
    const txValue = BigInt(tx.value ?? '0');
    if (p.maxPerTransaction) {
      const limit = BigInt(p.maxPerTransaction);
      if (txValue > limit) {
        return this._deny(
          `Transaction value ${txValue} exceeds per-tx limit of ${limit} wei`,
          'per_transaction_limit',
        );
      }
    }

    // 4. Hourly budget
    if (p.maxPerHour) {
      const hourlySpent = this._sumSpentSince(Date.now() - ONE_HOUR_MS);
      const limit = BigInt(p.maxPerHour);
      if (hourlySpent + txValue > limit) {
        return this._deny(
          `Transaction would push hourly spend to ${hourlySpent + txValue} wei, exceeding limit of ${limit} wei`,
          'hourly_budget',
        );
      }
    }

    // 5. Daily budget
    if (p.maxPerDay) {
      const dailySpent = this._sumSpentSince(Date.now() - ONE_DAY_MS);
      const limit = BigInt(p.maxPerDay);
      if (dailySpent + txValue > limit) {
        return this._deny(
          `Transaction would push daily spend to ${dailySpent + txValue} wei, exceeding limit of ${limit} wei`,
          'daily_budget',
        );
      }
    }

    return { allowed: true };
  }

  /**
   * Evaluate and throw if the transaction violates the policy.
   * In dryRun mode, logs a warning but does not throw.
   */
  enforce(tx: PendingTransaction): void {
    const result = this.evaluate(tx);
    if (!result.allowed) {
      if (this._policy.dryRun) {
        // In dry-run mode we don't block — just return.
        // Callers can still check evaluate() for logging.
        return;
      }
      throw new EvalancheError(
        `Policy violation: ${result.reason}`,
        EvalancheErrorCode.POLICY_VIOLATION,
      );
    }
  }

  /** Record a confirmed spend. Call this AFTER a transaction is mined. */
  recordSpend(record: SpendRecord): void {
    this._spendHistory.push({ ...record });
    // Prune records older than 24h to prevent unbounded growth
    this._pruneHistory();
  }

  /** Get the current budget status */
  getBudgetStatus(): BudgetStatus {
    const now = Date.now();
    const hourlySpent = this._sumSpentSince(now - ONE_HOUR_MS);
    const dailySpent = this._sumSpentSince(now - ONE_DAY_MS);
    const hourlyCount = this._countSince(now - ONE_HOUR_MS);
    const dailyCount = this._countSince(now - ONE_DAY_MS);

    const p = this._policy;
    return {
      policy: { ...p },
      spentLastHour: hourlySpent.toString(),
      spentLastDay: dailySpent.toString(),
      remainingHourly: p.maxPerHour
        ? (BigInt(p.maxPerHour) - hourlySpent).toString()
        : null,
      remainingDaily: p.maxPerDay
        ? (BigInt(p.maxPerDay) - dailySpent).toString()
        : null,
      txCountLastHour: hourlyCount,
      txCountLastDay: dailyCount,
    };
  }

  /** Get raw spend history (most recent first) */
  getSpendHistory(): SpendRecord[] {
    return [...this._spendHistory].reverse();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _deny(reason: string, violationType: PolicyEvaluation['violationType']): PolicyEvaluation {
    return { allowed: false, reason, violationType };
  }

  private _sumSpentSince(sinceMs: number): bigint {
    let total = 0n;
    for (const record of this._spendHistory) {
      if (record.timestamp >= sinceMs) {
        total += BigInt(record.amount);
      }
    }
    return total;
  }

  private _countSince(sinceMs: number): number {
    let count = 0;
    for (const record of this._spendHistory) {
      if (record.timestamp >= sinceMs) {
        count++;
      }
    }
    return count;
  }

  /** Remove spend records older than 24 hours */
  private _pruneHistory(): void {
    const cutoff = Date.now() - ONE_DAY_MS;
    this._spendHistory = this._spendHistory.filter((r) => r.timestamp >= cutoff);
  }
}
