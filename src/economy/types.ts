/**
 * Shared types for the Evalanche Agent Economy Layer.
 *
 * These types are used across all economy submodules (policies, discovery,
 * negotiation, settlement, memory). They define the common vocabulary for
 * agent-to-agent economic interactions.
 */

// ---------------------------------------------------------------------------
// Spending Policies
// ---------------------------------------------------------------------------

/** A single allowlisted contract + optional function selectors */
export interface AllowlistEntry {
  /** Contract address (checksummed or lowercase hex) */
  address: string;
  /** If provided, only these function selectors (4-byte hex) are allowed.
   *  If omitted, all functions on this contract are permitted. */
  selectors?: string[];
}

/**
 * Spending policy that governs what an agent is allowed to do with its wallet.
 *
 * All fields are optional — omit a field to leave it unrestricted.
 * When multiple constraints are set, ALL must pass (logical AND).
 */
export interface SpendingPolicy {
  /** Maximum native token value (in wei) per single transaction.
   *  Applies to `value` field of any outbound tx. */
  maxPerTransaction?: string;

  /** Maximum total spend (in wei) within a rolling hour window */
  maxPerHour?: string;

  /** Maximum total spend (in wei) within a rolling 24-hour window */
  maxPerDay?: string;

  /** If set, the agent can ONLY interact with these contracts.
   *  Value transfers to EOAs are blocked unless the EOA is listed here. */
  allowlistedContracts?: AllowlistEntry[];

  /** If set, the agent can ONLY operate on these chain IDs.
   *  Transactions on unlisted chains are rejected. */
  allowlistedChains?: number[];

  /** If true, every transaction is simulated (eth_call) before sending.
   *  Reverts are caught before spending gas. Default: false. */
  simulateBeforeSend?: boolean;

  /** If true, the policy is in dry-run mode — violations are logged but not enforced.
   *  Useful for testing policies before going live. Default: false. */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Budget Tracking
// ---------------------------------------------------------------------------

/** A single recorded spend event */
export interface SpendRecord {
  /** Transaction hash */
  txHash: string;
  /** Amount spent in wei */
  amount: string;
  /** Target address (contract or EOA) */
  to: string;
  /** Chain ID where the spend occurred */
  chainId: number;
  /** Unix timestamp (ms) when the spend was recorded */
  timestamp: number;
}

/** Current budget status computed from policy + spend history */
export interface BudgetStatus {
  /** Policy currently in effect (null if no policy set) */
  policy: SpendingPolicy | null;
  /** Total spent in the current rolling hour window (wei) */
  spentLastHour: string;
  /** Total spent in the current rolling 24h window (wei) */
  spentLastDay: string;
  /** Remaining hourly budget (wei), null if no hourly limit */
  remainingHourly: string | null;
  /** Remaining daily budget (wei), null if no daily limit */
  remainingDaily: string | null;
  /** Number of transactions in the current hour */
  txCountLastHour: number;
  /** Number of transactions in the current 24h */
  txCountLastDay: number;
}

// ---------------------------------------------------------------------------
// Policy Evaluation
// ---------------------------------------------------------------------------

/** Result of evaluating a transaction against the spending policy */
export interface PolicyEvaluation {
  /** Whether the transaction is allowed */
  allowed: boolean;
  /** If denied, which rule was violated */
  reason?: string;
  /** The specific rule type that was violated */
  violationType?: PolicyViolationType;
}

/** Types of policy violations */
export type PolicyViolationType =
  | 'per_transaction_limit'
  | 'hourly_budget'
  | 'daily_budget'
  | 'contract_not_allowlisted'
  | 'chain_not_allowlisted'
  | 'simulation_reverted';

// ---------------------------------------------------------------------------
// Discovery & Services
// ---------------------------------------------------------------------------

/** A service offered by an agent, discoverable by other agents */
export interface AgentService {
  /** ERC-8004 agent ID of the service provider */
  agentId: string;
  /** Human-readable service name (e.g. "code-audit", "price-feed") */
  capability: string;
  /** Short description of what this service does */
  description: string;
  /** x402-compatible endpoint URL where the service is available */
  endpoint: string;
  /** Price per call in wei (native token of the specified chain) */
  pricePerCall: string;
  /** Chain ID where payments are accepted */
  chainId: number;
  /** Unix timestamp (ms) when this listing was registered */
  registeredAt: number;
  /** Optional tags for more granular search */
  tags?: string[];
}

/** Search query to find agents by capability, reputation, or price */
export interface DiscoveryQuery {
  /** Required capability (exact or substring match) */
  capability?: string;
  /** Minimum reputation score (0-100) */
  minReputation?: number;
  /** Maximum price per call in wei */
  maxPrice?: string;
  /** Only return services on these chain IDs */
  chainIds?: number[];
  /** Only return services with ALL of these tags */
  tags?: string[];
  /** Maximum number of results (default: 10) */
  limit?: number;
}

/** An agent's full profile: identity + registered services */
export interface AgentProfile {
  /** ERC-8004 agent ID */
  agentId: string;
  /** Owner address (from identity registry) */
  owner: string | null;
  /** Reputation score 0-100 (from reputation registry) */
  reputationScore: number | null;
  /** Trust level derived from reputation */
  trustLevel: 'high' | 'medium' | 'low' | 'unknown';
  /** Services this agent offers */
  services: AgentService[];
}

// ---------------------------------------------------------------------------
// Transaction Intent (for policy evaluation)
// ---------------------------------------------------------------------------

/**
 * A pending transaction that needs policy evaluation before execution.
 * This mirrors wallet/types.ts TransactionIntent but adds chain context.
 */
export interface PendingTransaction {
  /** Target address */
  to: string;
  /** Native token value in wei */
  value?: string;
  /** Calldata (hex) */
  data?: string;
  /** Chain ID where this transaction will execute */
  chainId: number;
  /** Optional gas limit */
  gasLimit?: bigint;
}
