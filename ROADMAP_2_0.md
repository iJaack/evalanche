# Evalanche 2.0 — Open Agent Interoperability Stack

> **Goal:** Evolve evalanche from an agent wallet + economy SDK into a full **open agent interoperability stack** — where AI agents can discover each other via ERC-8004, interact via the A2A protocol, communicate over XMTP, and settle payments and trust on-chain.
>
> **Why this matters:** The foundation exists. Evalanche 1.x built identity, wallet primitives, and an economy layer. What's missing is the open-protocol glue that lets arbitrary agents from different teams, frameworks, and networks actually work together — without pre-existing trust or custom integrations.

---

## Context for Future Agents

**Read this first.** This file is the single source of truth for evalanche 2.0. Before doing any work, read this file completely. After completing a step, tick the checkbox and add a short note with what was done, decisions made, and files created/modified.

### What evalanche 1.x already has
- 69 MCP tools for autonomous agent wallets on 21+ EVM chains
- ERC-8004 on-chain identity + reputation (identity registry, reputation registry, validation registry)
- Economy layer: policies, discovery (in-memory), negotiation, settlement, escrow, service hosting, memory/trust graph
- x402 payment-gated HTTP (both client and server mode)
- Li.Fi cross-chain bridging + DEX swaps
- dYdX v4 perpetual futures
- Avalanche multi-VM, staking, subnets

### What evalanche 2.0 builds on top
**Three new layers** that connect evalanche to the emerging open agent ecosystem:

1. **`src/interop/`** — identity resolution, A2A protocol support, signed manifests, canonical receipts
2. **`src/transport/`** — XMTP messaging adapter for wallet-bound async agent communication
3. **Composition** — wiring ERC-8004 + A2A + XMTP + x402/escrow into a coherent end-to-end protocol

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                     MCP Tools (new in 2.0)                   │
│  resolve_agent, fetch_agent_card, a2a_submit_task,           │
│  xmtp_send_agent_message, verify_service_manifest, ...       │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                     src/interop/                             │
│                                                              │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │
│  │ identity │ │   a2a    │ │ manifests │ │   receipts    │  │
│  │ resolver │ │  client  │ │  (signed) │ │  (portable)   │  │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └───────┬───────┘  │
│       └────────────┴─────────────┴───────────────┘          │
└──────────────────────────┬───────────────────────────────────┘
                           │ uses
┌──────────────────────────▼───────────────────────────────────┐
│                   src/transport/                             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  XMTPAdapter — wallet-bound agent messaging          │    │
│  │  DM / group channels, structured message envelopes  │    │
│  │  negotiation, async task updates, receipts           │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────────────┘
                           │ uses
┌──────────────────────────▼───────────────────────────────────┐
│               Evalanche 1.x (unchanged)                      │
│  economy/ identity/ reputation/ x402/ bridge/ swap/ wallet/  │
└──────────────────────────────────────────────────────────────┘
```

---

## Design Principles

1. **Build on open standards.** ERC-8004, A2A, XMTP. Don't invent protocols that already exist.
2. **ERC-8004 is the bootstrap.** Every agent interaction starts from resolving identity. Wallet, endpoints, services — all flow from there.
3. **A2A is the interaction protocol.** Task lifecycle, skill negotiation, agent cards — follow the spec, don't fork it.
4. **XMTP is the async transport.** HTTP is synchronous. Agents need async, wallet-bound, durable messaging. XMTP is that layer.
5. **Composition over reinvention.** Map A2A → evalanche negotiation. Map XMTP → evalanche settlement receipts. Don't build parallel systems.
6. **Receipts are first-class.** Every meaningful agent interaction should produce a portable, verifiable receipt.
7. **Demos prove the stack.** Every phase ends with something runnable, not just abstractions.
8. **Follow existing patterns.** Match structure of `src/economy/`. TypeScript strict mode. JSDoc on all public methods. No `any`.
9. **Tests are mandatory.** Every new module gets unit tests. Maintain 325+ passing test standard.

---

## Phase 7: Identity as the Control Plane

> **Why first:** Every phase 8 and 9 interaction starts by asking "who is this agent and how do I reach them?" ERC-8004 answers that. Until it's properly resolved and consumed, everything else is hardcoded.

- [ ] **Step 7.1 — ERC-8004 registration file resolver**
  - Create `src/interop/identity.ts`
  - `resolveAgent(agentId, agentRegistry?)` — fetches and parses the agent registration file from `agentURI`
  - Supports `ipfs://`, `https://`, and `data:` URI schemes
  - Parses `services[]`, `x402Support`, `supportedTrust`, `active`, `registrations`
  - Returns typed `AgentRegistration` object
  - _Notes: (fill in when done)_

- [ ] **Step 7.2 — Service endpoint resolution**
  - `getServiceEndpoints(agentId)` — returns all advertised services, typed by name (A2A, MCP, XMTP, ENS, DID, email, web)
  - `getPreferredTransport(agentId)` — returns best available transport in priority order: A2A > XMTP > MCP > web
  - `resolveAgentWallet(agentId)` — returns `agentWallet` address (payment destination)
  - _Notes: (fill in when done)_

- [ ] **Step 7.3 — Endpoint domain verification**
  - `verifyEndpointBinding(agentId, endpoint)` — checks `https://{domain}/.well-known/agent-registration.json`
  - Validates that returned `registrations[]` includes matching `agentRegistry` + `agentId`
  - Returns `{ verified: boolean, reason?: string }`
  - _Notes: (fill in when done)_

- [ ] **Step 7.4 — Reverse resolution**
  - `resolveByWallet(address)` — queries on-chain registry to find agent ID from wallet address
  - `resolveByEndpoint(endpoint)` — best-effort reverse lookup from endpoint domain
  - _Notes: (fill in when done)_

- [ ] **Step 7.5 — Wire into existing ERC-8004 modules**
  - Replace or augment existing `IdentityResolver` in `src/identity/` to use new registration file parsing
  - Ensure `discovery.ts` can bootstrap from ERC-8004 registration instead of manual registration only
  - _Notes: (fill in when done)_

- [ ] **Step 7.6 — MCP tools for identity resolution**
  - `resolve_agent` — resolve full agent registration from agentId
  - `get_agent_services` — list all service endpoints for an agent
  - `get_agent_wallet` — get payment address for an agent
  - `verify_agent_endpoint` — verify endpoint domain binding
  - `resolve_by_wallet` — find agent from wallet address
  - _Notes: (fill in when done)_

- [ ] **Step 7.7 — Tests for Phase 7**
  - `test/interop/identity.test.ts` — mocked agentURI responses covering all URI schemes, service types, trust modes
  - `test/interop/identity.test.ts` — endpoint verification flow
  - Update `test/mcp/server.test.ts` for new tools
  - _Notes: (fill in when done)_

---

## Phase 8: Native A2A Support

> **Why second:** A2A is the emerging standard for agent-to-agent interaction under the Linux Foundation. It defines Agent Cards, task lifecycle, skill negotiation, streaming, and async push. Evalanche should speak this language natively and map it to its economy primitives — not replace them.

- [ ] **Step 8.1 — Agent Card client**
  - Create `src/interop/a2a.ts`
  - `fetchAgentCard(endpoint)` — fetches `.well-known/agent-card.json`
  - Parses: name, description, url, capabilities, skills, authentication, supported modalities
  - Returns typed `AgentCard` object (aligned with A2A spec v0.3+)
  - `resolveAgentCardFromERC8004(agentId)` — chains identity resolution → A2A endpoint → agent card
  - _Notes: (fill in when done)_

- [ ] **Step 8.2 — A2A task client**
  - Implement `A2AClient` class
  - `submitTask(endpoint, skill, input, auth?)` — POST task to agent, returns `taskId`
  - `getTask(endpoint, taskId)` — poll task status and artifacts
  - `streamTask(endpoint, taskId, onUpdate)` — SSE streaming for long-running tasks
  - `cancelTask(endpoint, taskId)` — cancel in-progress task
  - Full task lifecycle: `submitted → working → completed / failed / canceled`
  - _Notes: (fill in when done)_

- [ ] **Step 8.3 — Evalanche adapters**
  - Map **A2A agent card skills** → evalanche `DiscoveryClient.AgentService` shape
  - Map **A2A task submission** → evalanche `NegotiationClient.propose()` (with A2A task as payload)
  - Map **A2A task completion** → settlement trigger (auto-settle when task completes + artifact received)
  - Map **A2A task failure** → `NegotiationClient.reject()` + refund escrow if funded
  - `AgentCard` → `AgentRegistration` bridge so ERC-8004 and A2A are interchangeable discovery sources
  - _Notes: (fill in when done)_

- [ ] **Step 8.4 — A2A server support (optional but powerful)**
  - Add `A2AServer` class that wraps evalanche capabilities as an A2A-compliant agent
  - Generates `agent-card.json` from registered skills
  - Serves `/.well-known/agent-card.json` endpoint
  - Handles incoming A2A task requests and routes them to registered handlers
  - _Notes: (fill in when done)_

- [ ] **Step 8.5 — MCP tools for A2A**
  - `fetch_agent_card` — get agent card from URL or agentId
  - `a2a_submit_task` — submit a task to an A2A-compliant agent
  - `a2a_get_task` — get task status and artifacts
  - `a2a_cancel_task` — cancel a task
  - `a2a_list_skills` — list skills available from an agent card
  - `a2a_serve` — register local skill as A2A-compatible endpoint
  - _Notes: (fill in when done)_

- [ ] **Step 8.6 — Tests for Phase 8**
  - `test/interop/a2a.test.ts` — mocked agent cards, task lifecycle, error states, streaming
  - `test/interop/a2a-adapters.test.ts` — A2A → evalanche mapping
  - Update `test/mcp/server.test.ts` for new tools
  - _Notes: (fill in when done)_

---

## Phase 9: XMTP Transport Layer

> **Why third:** A2A handles synchronous task coordination over HTTP. What it doesn't cover is async, durable, wallet-bound messaging between agents that may be offline, running on different schedules, or needing inbox-style coordination. XMTP fills this gap. Wallet address = XMTP identity — which maps cleanly to evalanche's agent wallet model.

- [ ] **Step 9.1 — XMTP client adapter**
  - Install `@xmtp/xmtp-js` or `@xmtp/node-sdk` (evaluate which fits better)
  - Create `src/transport/xmtp.ts`
  - `XMTPAdapter` class initialized from agent wallet signer
  - `openDM(agentWallet)` — open or resume DM conversation with another agent by wallet address
  - `sendMessage(conversation, payload)` — send typed message envelope
  - `streamMessages(conversation, onMessage)` — stream incoming messages
  - `listConversations()` — list active agent conversations
  - _Notes: (fill in when done)_

- [ ] **Step 9.2 — Structured message envelopes**
  - Create `src/transport/schemas.ts`
  - Define canonical message types with versioned schema:
    - `NegotiationProposal` — propose task + price + deadline
    - `NegotiationCounter` — counter with new price
    - `NegotiationAcceptance` — accept proposal
    - `NegotiationRejection` — reject with reason
    - `PaymentRequest` — request payment for completed work
    - `SettlementReceipt` — signed receipt: task hash, amount paid, tx hash
    - `TaskUpdate` — async progress update for long-running tasks
    - `TrustAttestation` — reputation signal with evidence
  - All types signed with sender wallet key
  - _Notes: (fill in when done)_

- [ ] **Step 9.3 — A2A over XMTP bridge**
  - `sendA2ATaskViaXMTP(agentWallet, task)` — route A2A task submission through XMTP when HTTP is unavailable
  - Subscribe to incoming XMTP messages and route `NegotiationProposal` types to `NegotiationClient`
  - Route `SettlementReceipt` to `SettlementClient.recordFromReceipt()`
  - Route `TaskUpdate` to registered A2A task handlers
  - _Notes: (fill in when done)_

- [ ] **Step 9.4 — Memory integration**
  - Record XMTP-sourced interactions in `AgentMemory`
  - Type mapping: `NegotiationProposal` → `negotiation_proposed`, `SettlementReceipt` → `payment_received`, etc.
  - Trust scoring should consider XMTP relationship history
  - _Notes: (fill in when done)_

- [ ] **Step 9.5 — MCP tools for XMTP**
  - `xmtp_open_channel` — open DM with an agent by wallet address or agentId
  - `xmtp_send_agent_message` — send structured message to an agent
  - `xmtp_list_messages` — read messages from a conversation
  - `xmtp_watch_messages` — stream new messages from a conversation
  - `xmtp_list_conversations` — list all agent conversations
  - _Notes: (fill in when done)_

- [ ] **Step 9.6 — Tests for Phase 9**
  - `test/transport/xmtp.test.ts` — mocked XMTP client, conversation flows, message schemas
  - `test/transport/bridge.test.ts` — A2A over XMTP routing
  - Update `test/mcp/server.test.ts` for new tools
  - _Notes: (fill in when done)_

---

## Phase 10: Trust and Settlement Composition

> **Why fourth:** With identity, protocol, and transport in place, the final layer is making trust and settlement composable — so agents can require proof, not just assume honesty.

- [ ] **Step 10.1 — Signed service manifests**
  - Create `src/interop/manifests.ts`
  - `ServiceManifest` type: ties together ERC-8004 identity, wallet, A2A endpoint, XMTP address, pricing, x402 support, accepted trust modes, supported currencies/chains
  - `signManifest(manifest, wallet)` — produces EIP-712 signed manifest
  - `verifyManifest(manifest)` — validates signature + cross-checks ERC-8004 registration
  - `publishManifest(manifest)` — stores to IPFS or pins to agentURI
  - _Notes: (fill in when done)_

- [ ] **Step 10.2 — Canonical receipts**
  - Create `src/interop/receipts.ts`
  - `TaskReceipt` — task hash, agent IDs, completion timestamp, artifact CID, settlement tx hash
  - `PaymentReceipt` — from, to, amount, chain, tx hash, task hash, timestamp
  - `EscrowReceipt` — escrow address, funded amount, release conditions, release tx
  - `ReputationReceipt` — score submitted, evidence hash, validation tx
  - All receipts: typed, EIP-712 signable, IPFS-storable
  - `buildReceipt(type, data, wallet)` — creates and signs receipt
  - `verifyReceipt(receipt)` — checks signature and cross-references on-chain data
  - _Notes: (fill in when done)_

- [ ] **Step 10.3 — Trust policy v2**
  - Extend `PolicyEngine` with interop-aware rules:
    - `requireVerifiedEndpoint` — only transact with agents who have verified endpoint-domain binding
    - `requireMinReputation(score)` — enforce ERC-8004 reputation threshold
    - `requireTrustMode(mode)` — require specific trust model (`reputation`, `crypto-economic`, `tee-attestation`)
    - `requireEscrowAbove(threshold)` — mandate on-chain escrow for amounts above X
    - `requireSettlementReceipt` — only release escrow on verified task receipt
  - _Notes: (fill in when done)_

- [ ] **Step 10.4 — Receipt-gated escrow release**
  - Extend `EscrowClient` with `releaseOnReceipt(escrowId, receipt)` — validates receipt, then releases
  - Validates: receipt signature, task hash match, completion timestamp within TTL, A2A task status
  - _Notes: (fill in when done)_

- [ ] **Step 10.5 — MCP tools for trust and receipts**
  - `create_service_manifest` — generate signed manifest for this agent
  - `verify_service_manifest` — validate another agent's manifest
  - `build_receipt` — create a signed receipt for a completed interaction
  - `verify_receipt` — verify a receipt's authenticity and on-chain state
  - `release_escrow_on_receipt` — release escrow given a valid task receipt
  - `require_trust_policy` — set interop-aware trust requirements
  - _Notes: (fill in when done)_

- [ ] **Step 10.6 — Tests for Phase 10**
  - `test/interop/manifests.test.ts` — signing, verification, cross-check with ERC-8004
  - `test/interop/receipts.test.ts` — all receipt types, signing, verification
  - `test/economy/escrow.test.ts` — extend with receipt-gated release
  - Update `test/mcp/server.test.ts`
  - _Notes: (fill in when done)_

---

## Phase 11: Real Multi-Agent Demos

> **Why last:** Abstractions without proof are just theory. These demos run against real infrastructure and show the full stack working end-to-end across separate processes or machines.

- [ ] **Demo 1 — Paid research agent**
  - Two agents, separate processes
  - Agent A: discover Agent B via ERC-8004 → fetch A2A card → negotiate via XMTP → pay via x402 → receive artifact → record trust
  - Agent B: serve research skill via A2A → receive payment → deliver artifact → sign receipt
  - Script: `examples/demo-paid-research.ts`
  - _Notes: (fill in when done)_

- [ ] **Demo 2 — Cross-agent execution market**
  - Agent A requests a swap/bridge/monitoring task from Agent B
  - Flow: ERC-8004 resolve → A2A task submit → XMTP updates → escrow fund → settlement on completion → reputation submitted
  - Script: `examples/demo-execution-market.ts`
  - _Notes: (fill in when done)_

- [ ] **Demo 3 — Async long-running job**
  - Agent A submits a long task via A2A
  - Agent B sends progress updates via XMTP
  - On completion: receipt generated → escrow released → memory updated
  - Script: `examples/demo-async-job.ts`
  - _Notes: (fill in when done)_

- [ ] **Step 11.4 — Update README**
  - New architecture diagram
  - Quickstart for A2A + XMTP
  - Link to demos
  - Protocol compatibility table: ERC-8004 ✓, A2A ✓, XMTP ✓, x402 ✓, MCP ✓
  - _Notes: (fill in when done)_

---

## Final Codebase Shape

```
src/
  interop/
    identity.ts        — ERC-8004 registration resolver, endpoint resolution
    a2a.ts             — A2A client (agent cards, task lifecycle, server mode)
    manifests.ts       — signed service manifests
    receipts.ts        — portable canonical receipts
    schemas.ts         — shared interop types
    index.ts           — barrel exports
  transport/
    xmtp.ts            — XMTP adapter (wallet-bound messaging)
    schemas.ts         — structured message envelope types
    index.ts           — barrel exports
  economy/
    ...                — (unchanged from 1.x)
  agent.ts             — evalanche agent class (extended with interop accessors)
  index.ts             — top-level barrel (economy + interop + transport)

test/
  interop/
    identity.test.ts
    a2a.test.ts
    a2a-adapters.test.ts
    manifests.test.ts
    receipts.test.ts
  transport/
    xmtp.test.ts
    bridge.test.ts

examples/
  demo-paid-research.ts
  demo-execution-market.ts
  demo-async-job.ts
```

---

## Rules for Implementation

1. **Read this file before starting any work.** Check which step is next (first unchecked box).
2. **One step at a time.** Complete and tick before moving on.
3. **Don't break existing tests.** Run `npx vitest run` after each step. All 325+ tests must pass.
4. **Follow existing patterns.** Match structure of `src/economy/`. Look at how `src/economy/discovery.ts` or `src/economy/settlement.ts` are structured.
5. **Use EvalancheError.** Add new error codes to `src/utils/errors.ts` as needed (e.g., `A2A_ERROR`, `XMTP_ERROR`, `MANIFEST_ERROR`, `RECEIPT_ERROR`).
6. **Lazy load new modules.** Add `interop()` and `transport()` accessors to `Evalanche` class, like how `economy()` and `dydx()` work.
7. **TypeScript strict mode.** No `any` types. JSDoc on all public methods.
8. **When you tick a box, add a one-liner about what was done and list files touched.**

---

## Progress Log

| Date | Step | Agent | Summary |
|------|------|-------|---------|
| (TBD) | 7.1 | — | — |

---

## Version Framing

### evalanche 1.x
wallet + economy primitives — agent can hold funds, trade, negotiate, settle, remember

### evalanche 2.0
**open agent interoperability stack**
- identity-aware (ERC-8004 full resolution)
- protocol-aware (A2A task lifecycle, agent cards)
- transport-aware (XMTP wallet-bound messaging)
- settlement-aware (receipts, escrow, trust composition)

**the goal:** any agent, any framework, any organization — can find, negotiate with, pay, and rate an evalanche-compatible agent without a custom integration.
