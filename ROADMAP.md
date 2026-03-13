# Evalanche v1.0.0 — The Agent Economy Layer

> **Goal:** Transform evalanche from an agent wallet SDK into an **agent economy protocol** — where AI agents discover each other, negotiate, transact, build trust, and earn revenue autonomously.
>
> **Why this matters:** In 3 years, millions of AI agents will need to pay each other for services without human intervention. The wallet infrastructure exists (v0.9.0). What's missing is the economy on top.

---

## Context for Future Agents

**Read this first.** This file is the single source of truth for what we're building and where we are. Before doing any work, read this file completely. After completing a step, tick the checkbox and add a short note with what was done, any decisions made, and files created/modified.

### What evalanche already has (v0.9.0)
- 54 MCP tools for autonomous agent wallets on 21+ EVM chains
- Non-custodial keystore (AES-128-CTR + scrypt)
- ERC-8004 on-chain identity with reputation (0-100)
- x402 payment-gated HTTP (agent pays, gets content)
- Li.Fi cross-chain bridging + DEX swaps + DeFi Composer
- Arena bonding curve token trading
- dYdX v4 perpetual futures
- Avalanche multi-VM (X-Chain, P-Chain, staking, subnets)

### What we're building on top
An **economy layer** (`src/economy/`) that connects these existing systems into a coherent agent-to-agent protocol. We are NOT rewriting anything — we're wiring together identity, reputation, and x402 into something greater.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    MCP Tools (new)                    │
│  serve_endpoint, discover_agents, negotiate_task,    │
│  settle_payment, get_budget, simulate_tx, ...        │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              src/economy/ (NEW MODULE)                │
│                                                      │
│  ┌─────────┐ ┌───────────┐ ┌──────────┐ ┌────────┐  │
│  │Policies │ │ Discovery │ │Negotiate │ │Service │  │
│  │& Budget │ │  & Search │ │& Settle  │ │(x402   │  │
│  │         │ │           │ │          │ │ server)│  │
│  └────┬────┘ └─────┬─────┘ └────┬─────┘ └───┬────┘  │
│       │            │            │            │       │
│  ┌────▼────────────▼────────────▼────────────▼────┐  │
│  │              Memory / State                     │  │
│  │  (transactions, relationships, portfolio)       │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────┘
                       │ uses
┌──────────────────────▼───────────────────────────────┐
│           Existing evalanche v0.9.0                   │
│  wallet/ identity/ reputation/ x402/ bridge/ swap/   │
└──────────────────────────────────────────────────────┘
```

---

## Design Principles

1. **Build on what exists.** ERC-8004 identity, reputation, and x402 are the foundation. Don't reinvent.
2. **Agents are both clients and servers.** Every agent can earn (serve x402 endpoints) and spend (pay other agents).
3. **Trust is earned, not assumed.** Reputation scores gate what an agent is willing to pay and who it transacts with.
4. **Guardrails are mandatory.** No agent should have unlimited spending ability. Policies are a first-class concern.
5. **Stateless is not enough.** Agents need persistent memory of transactions and relationships across sessions.
6. **Lazy and modular.** Economy features are opt-in. An agent using only wallet features should never load economy code.
7. **Test everything.** Every new module gets unit tests. We maintain the 184+ passing test standard.

---

## Phase 1: Spending Policies & Guardrails

> **Why first:** Nobody deploys an autonomous agent without limits. This is the trust layer that makes everything else usable.

- [x] **Step 1.1 — Policy types and interfaces**
  - Create `src/economy/policies.ts`
  - Define `SpendingPolicy` interface: per-tx cap, daily/hourly budget, allowlisted addresses/selectors, chain restrictions
  - Define `PolicyViolation` error type extending `EvalancheError`
  - Create `src/economy/types.ts` for shared economy types
  - _Notes: Created `src/economy/types.ts` with SpendingPolicy, AllowlistEntry, SpendRecord, BudgetStatus, PolicyEvaluation, PendingTransaction types. Added 6 new error codes to `src/utils/errors.ts` (POLICY_VIOLATION, SIMULATION_FAILED, DISCOVERY_ERROR, NEGOTIATION_ERROR, SETTLEMENT_ERROR, MEMORY_ERROR). Also fixed Windows file permission bug in `src/wallet/keystore.ts` — added cross-platform `restrictFilePermissions()` using icacls on Windows, chmod on Unix. Updated `test/wallet/keystore.test.ts` to verify Windows ACLs._

- [x] **Step 1.2 — Policy engine**
  - Implement `PolicyEngine` class in `src/economy/policies.ts`
  - Methods: `evaluate(tx) → { allowed: boolean, reason?: string }`, `getBudgetRemaining()`, `recordSpend(amount, chain)`
  - In-memory budget tracking with rolling window (hourly/daily)
  - _Notes: PolicyEngine checks rules in order: chain allowlist → contract/selector allowlist → per-tx limit → hourly budget → daily budget. All must pass (AND logic). `enforce()` throws EvalancheError, `evaluate()` returns result. dryRun mode logs but doesn't block. Rolling windows auto-prune records older than 24h. 23 tests in `test/economy/policies.test.ts`, all passing. Total suite: 207/207._

- [x] **Step 1.3 — Transaction simulation**
  - Create `src/economy/simulation.ts`
  - `simulateTransaction(provider, tx)` — dry-run via `eth_call`, return success/failure + gas estimate + decoded revert reason
  - Integrate with PolicyEngine: simulate before policy check when enabled
  - _Notes: Created `src/economy/simulation.ts` with `simulateTransaction()` using provider.call() + provider.estimateGas(). Decodes Solidity Error(string) reverts from raw 0x08c379a0 data. 8 tests in `test/economy/simulation.test.ts`._

- [x] **Step 1.4 — Wire into Evalanche agent**
  - Add optional `policy` config to `EvalancheConfig`
  - Intercept `sendTransaction`, `callContract`, `approveAndCall` to check policy before execution
  - Add `agent.getPolicy()`, `agent.getBudgetStatus()` public methods
  - _Notes: Added `policy?: SpendingPolicy` to EvalancheConfig. PolicyEngine created in constructor if policy provided. `send()` and `call()` now call `_enforcePolicy()` before execution and `_recordSpend()` after. Added `_chainId` field. Public methods: `getPolicy()`, `setPolicy()`, `getBudgetStatus()`, `simulateTransaction()`. When `simulateBeforeSend` is true, simulation runs before policy checks. Fully backward-compatible. 215/215 tests pass._

- [x] **Step 1.5 — MCP tools for policies**
  - `get_budget` — Show remaining budget and spending history
  - `set_policy` — Update spending policy (requires elevated permissions)
  - `simulate_tx` — Dry-run a transaction without executing
  - _Notes: Added 3 tool definitions + 3 handler cases to `src/mcp/server.ts`. get_budget returns BudgetStatus or "No spending policy set". set_policy accepts all SpendingPolicy fields, empty args removes policy. simulate_tx calls agent.simulateTransaction(). Total tools: 57._

- [x] **Step 1.6 — Tests for Phase 1**
  - `test/economy/policies.test.ts` — Policy evaluation, budget tracking, rolling windows
  - `test/economy/simulation.test.ts` — Simulation success/failure/revert decoding
  - Update `test/mcp/server.test.ts` — New MCP tools
  - All existing 184 tests must still pass
  - _Notes: 23 policy tests, 8 simulation tests, 5 MCP economy tests. All 220/220 pass (up from 184). Zero type errors. Phase 1 COMPLETE._

---

## Phase 2: Agent-to-Agent Discovery

> **Why second:** Before agents can transact, they need to find each other. This builds on ERC-8004 identity.

- [x] **Step 2.1 — Service registry types**
  - Create `src/economy/discovery.ts`
  - Define `AgentService` interface: `{ agentId, capabilities: string[], endpoint: string, pricePerCall, reputation, chain }`
  - Define `DiscoveryQuery`: search by capability, min reputation, chain, max price
  - _Notes: Added AgentService, DiscoveryQuery, and AgentProfile types to `src/economy/types.ts`. AgentService has agentId, capability, description, endpoint, pricePerCall, chainId, tags. DiscoveryQuery supports capability substring, minReputation, maxPrice, chainIds, tags, limit._

- [x] **Step 2.2 — Discovery client**
  - Implement `DiscoveryClient` class
  - `register(service: AgentService)` — announce capabilities (on-chain via ERC-8004 metadata extension or off-chain registry)
  - `search(query: DiscoveryQuery)` — find agents matching criteria
  - `resolve(agentId)` — full profile with reputation + services (wraps existing `IdentityResolver`)
  - Start with off-chain registry (JSON-RPC or REST), design for on-chain migration
  - _Notes: In-memory registry in `src/economy/discovery.ts`. Register/unregister services, search with AND filters (capability substring, chain, maxPrice, tags, minReputation via on-chain ERC-8004 lookup). resolve() combines identity + services. Sorted by price ascending. 21 tests._

- [x] **Step 2.3 — MCP tools for discovery**
  - `register_service` — Register agent's capabilities and pricing
  - `discover_agents` — Search for agents by capability/reputation/price
  - `resolve_agent_profile` — Get full agent profile with services
  - _Notes: 3 new MCP tools + handlers in server.ts. DiscoveryClient initialized in server constructor. register_service uses agent's ERC-8004 ID or wallet address. 4 MCP tests added. Total tools: 60._

- [x] **Step 2.4 — Tests for Phase 2**
  - `test/economy/discovery.test.ts` — Registration, search, filtering
  - _Notes: 21 discovery tests + 4 MCP tests. Full suite: 244/244. Zero type errors. Phase 2 COMPLETE._

---

## Phase 3: Revenue Mode (x402 Server)

> **Why third:** Agents need to earn, not just spend. This flips x402 from client-only to bidirectional.

- [x] **Step 3.1 — x402 server handler**
  - Create `src/economy/service.ts`
  - `AgentService` class: register HTTP handlers that are payment-gated
  - `serve(path, handler, price)` — wrap handler with 402 challenge/verification
  - Verify incoming payment proofs (signature validation, amount check)
  - _Notes: Created `AgentServiceHost` in `src/economy/service.ts`. serve() registers endpoints, handleRequest() returns 402 challenge or 200 with content. Verifies x402 proofs using ethers.verifyMessage() — checks signature, paymentAddress, chainId. Compatible with existing X402Facilitator proof format._

- [x] **Step 3.2 — Revenue tracking**
  - Track incoming payments: who paid, how much, for what
  - Expose `getRevenue()` summary
  - Integrate with PolicyEngine (spending policies should see revenue balance)
  - _Notes: ReceivedPayment records stored per request. getRevenue() returns RevenueSummary grouped by endpoint path. paymentCount getter for quick checks._

- [x] **Step 3.3 — MCP tools for service**
  - `serve_endpoint` — Register a payment-gated endpoint
  - `get_revenue` — Show earnings summary
  - `list_services` — Show active services
  - _Notes: 3 new MCP tools. serve_endpoint accepts responseTemplate for static content. AgentServiceHost initialized in server constructor with agent's address. Total tools: 63._

- [x] **Step 3.4 — Tests for Phase 3**
  - `test/economy/service.test.ts` — Endpoint registration, payment verification, revenue tracking
  - _Notes: 15 service tests (real signature creation + verification with ethers Wallet) + 3 MCP tests. Full suite: 262/262. Phase 3 COMPLETE._

---

## Phase 4: Negotiation & Settlement

> **Why fourth:** With discovery and payment in place, agents need a protocol to agree on terms and settle.

- [x] **Step 4.1 — Negotiation protocol** ✅
  - Created `src/economy/negotiation.ts`
  - `NegotiationClient` class with proposal state machine: pending → accepted/countered/rejected/expired → settled
  - `propose()` creates proposals with configurable TTL (default 1 hour), `accept()`, `counter(id, newPrice)`, `reject()`
  - `getAgreedPrice()` returns counter price if countered, original otherwise
  - Lazy expiry check on `get()` — no background timers needed
  - _Notes: 19 unit tests covering all state transitions, edge cases, unique IDs, and expiry_

- [x] **Step 4.2 — Settlement flow** ✅
  - Created `src/economy/settlement.ts`
  - `SettlementClient.settle()` — validates accepted state → sends payment via `TransactionBuilder` → submits reputation via `ReputationReporter` → marks settled
  - Payment is mandatory (failure = entire settlement fails); reputation feedback is best-effort (failure = settlement still succeeds)
  - Uses `formatEther()` to convert wei to human-readable for `TransactionBuilder.send()`
  - _Notes: 5 unit tests with mocked ethers Contract for reputation calls_

- [x] **Step 4.3 — MCP tools for negotiation** ✅
  - `negotiate_task` — Propose/accept/counter/reject via action parameter; returns proposalId, status, agreedPrice
  - `settle_payment` — Settles accepted proposal, sends payment, submits reputation (defaults to score 50 if not provided)
  - `get_agreements` — List all proposals or filter by status/agentId; can also fetch single proposal by ID
  - _Notes: Added NegotiationClient and SettlementClient fields to EvalancheMCPServer; total tools now 66_

- [x] **Step 4.4 — Tests for Phase 4** ✅
  - `test/economy/negotiation.test.ts` — 19 tests: propose, counter, accept, reject, expiry, list/filter, unique IDs
  - `test/economy/settlement.test.ts` — 5 tests: settle accepted, reject non-accepted, counter price, reputation failure tolerance
  - `test/mcp/server.test.ts` — 5 new tests: propose+accept flow, counter flow, reject, get_agreements with filters, invalid action error
  - _Notes: Total test count: 291 passing across 20 files_

---

## Phase 5: Persistent Memory

> **Why fifth:** All previous phases generate state that agents need to remember across sessions.

- [x] **Step 5.1 — Memory store** ✅
  - Created `src/economy/memory.ts`
  - `AgentMemory` class with JSON file persistence (null path = in-memory for tests)
  - Records 8 interaction types: payment_sent/received, negotiation_proposed/accepted/rejected/countered, service_called, reputation_submitted
  - `record()` auto-generates IDs, `query()` filters by type/counterparty/time/chain with limit
  - _Notes: Data persisted to disk via `writeFileSync`, auto-creates directories_

- [x] **Step 5.2 — Relationship graph** ✅
  - `getRelationship(agentId)` — aggregates total interactions, successful txs, volume, avg reputation, first/last timestamps, trust score
  - `getAllRelationships()` — all known agents sorted by trust score descending
  - `getPreferredAgents(capability)` — finds best agents for a capability from past interactions
  - Trust score formula: 40% success ratio + 30% reputation + 20% volume (log scale) - 10% rejection penalty
  - _Notes: Case-insensitive capability matching, graceful null for unknown agents_

- [x] **Step 5.3 — MCP tools for memory** ✅
  - `record_interaction` — Record any agent interaction with type, counterparty, amount, chain, metadata
  - `get_transaction_history` — Query past interactions with filters (type, counterparty, time range, chain, limit)
  - `get_relationships` — Get trust scores for all agents, a specific agent, or preferred agents by capability
  - _Notes: Total MCP tools now 69_

- [x] **Step 5.4 — Tests for Phase 5** ✅
  - `test/economy/memory.test.ts` — 26 tests: record, query filters, relationships, trust scoring, file persistence, clear
  - `test/mcp/server.test.ts` — 5 new tests: record+query flow, relationships by agent/all/capability, tool listing
  - _Notes: Total test count: 322 passing across 21 files_

---

## Phase 6: Integration & Release

- [x] **Step 6.1 — Barrel exports** ✅
  - Created `src/economy/index.ts` — exports all economy classes and types
  - Updated `src/index.ts` — added economy exports (8 classes + 14 types)
  - _Notes: All economy types accessible via `import { ... } from 'evalanche'`_

- [x] **Step 6.2 — Full integration test** ✅
  - `test/economy/e2e.test.ts` — 3 tests covering full agent lifecycle
  - Test 1: discover → negotiate → counter → accept → pay → rate → remember → preferred agents
  - Test 2: rejection flow with trust score impact
  - Test 3: multi-agent discovery with memory-informed selection
  - _Notes: Tests verify both agents' perspectives (A and B memories)_

- [x] **Step 6.3 — Update package.json to v1.0.0** ✅
  - Version bumped from 0.9.0 → 1.0.0
  - Description updated to include "agent economy layer"
  - Added keywords: agent-economy, negotiation, discovery, settlement, mcp
  - _Notes: Ready for npm publish_

- [x] **Step 6.4 — Final validation** ✅
  - `npx tsc --noEmit` — zero type errors
  - `npx vitest run` — **325 tests passing** across 22 files
  - `npm run build` — clean build (ESM + CJS + DTS in 10.6s)
  - _Notes: 69 MCP tools, 7 economy modules, 0 regressions_

---

## File Map (Expected Final State)

```
src/economy/
  ├── index.ts           — Barrel exports
  ├── types.ts           — Shared economy types
  ├── policies.ts        — SpendingPolicy + PolicyEngine
  ├── simulation.ts      — Transaction dry-run
  ├── discovery.ts       — Agent service registry + search
  ├── service.ts         — x402 server (revenue mode)
  ├── negotiation.ts     — Propose/accept/counter protocol
  ├── settlement.ts      — Pay + verify + rate (atomic)
  └── memory.ts          — Persistent state + relationship graph

test/economy/
  ├── policies.test.ts
  ├── simulation.test.ts
  ├── discovery.test.ts
  ├── service.test.ts
  ├── negotiation.test.ts
  ├── settlement.test.ts
  └── memory.test.ts
```

---

## Rules for Implementation

1. **Read this file before starting any work.** Check which step is next (first unchecked box).
2. **One step at a time.** Complete and tick before moving on.
3. **Don't break existing tests.** Run `npm run test` after each step. All 184+ tests must pass.
4. **Follow existing patterns.** Look at how `src/bridge/lifi.ts` or `src/swap/arena.ts` are structured. Match the style.
5. **Use EvalancheError.** Add new error codes to `src/utils/errors.ts` as needed (e.g., `POLICY_VIOLATION`, `DISCOVERY_ERROR`, `NEGOTIATION_ERROR`, `SETTLEMENT_ERROR`, `MEMORY_ERROR`).
6. **Lazy load the economy module.** Add `economy()` accessor to `Evalanche` class, similar to how `dydx()` works.
7. **TypeScript strict mode.** No `any` types. JSDoc on all public methods.
8. **When you tick a box, add a one-liner about what was done and list files touched.**

---

## Progress Log

| Date | Step | Agent | Summary |
|------|------|-------|---------|
| 2026-03-10 | 1.1 | Claude Opus 4.6 | Types + error codes + Windows keystore fix |
| 2026-03-10 | 1.2 | Claude Opus 4.6 | PolicyEngine with 23 tests (207 total) |
| 2026-03-10 | 1.3 | Claude Opus 4.6 | Transaction simulation with revert decoding (8 tests) |
| 2026-03-10 | 1.4 | Claude Opus 4.6 | Wired policy into agent.send()/call() + public API |
| 2026-03-10 | 1.5 | Claude Opus 4.6 | 3 MCP tools: get_budget, set_policy, simulate_tx (57 total) |
| 2026-03-10 | 1.6 | Claude Opus 4.6 | Phase 1 complete — 220/220 tests, 0 type errors |
| 2026-03-10 | 2.1-2.4 | Claude Opus 4.6 | Phase 2 complete — Discovery client + 3 MCP tools, 244/244 tests |
| 2026-03-10 | 3.1-3.4 | Claude Opus 4.6 | Phase 3 complete — Revenue mode (x402 server) + 3 MCP tools, 262/262 tests |
| 2026-03-10 | 4.1-4.4 | Claude Opus 4.6 | Phase 4 complete — Negotiation state machine + Settlement (pay+rate) + 3 MCP tools, 291/291 tests |
| 2026-03-10 | 5.1-5.4 | Claude Opus 4.6 | Phase 5 complete — AgentMemory with relationship graph + trust scores + 3 MCP tools, 322/322 tests |
| 2026-03-10 | 6.1-6.4 | Claude Opus 4.6 | **v1.0.0 COMPLETE** — Barrel exports, e2e test, version bump, final validation: 325/325 tests, 0 type errors, clean build |
