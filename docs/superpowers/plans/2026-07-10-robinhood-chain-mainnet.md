# Robinhood Chain Mainnet Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Robinhood Chain mainnet (`robinhood`, chain ID `4663`) as a first-class Evalanche network across the generic EVM SDK, MCP, holdings, LI.FI bridge, documentation, and truthful Gas.zip capability handling.

**Architecture:** Extend the existing central chain registry so all derived network consumers inherit Robinhood support. Keep LI.FI on the existing numeric-chain bridge path, add explicit regression coverage for chain `4663`, and encode Gas.zip's current lack of Robinhood support as registry capability metadata checked before any quote request.

**Tech Stack:** TypeScript 5.4, Node.js 18+, ethers 6, Vitest 4, LI.FI REST API, MCP JSON-RPC

## Global Constraints

- Support Robinhood Chain mainnet only: chain ID `4663`, alias `robinhood`.
- Do not add Robinhood Chain Testnet (`46630`) or a testnet alias.
- Use official metadata: ETH, 18 decimals, `https://rpc.mainnet.chain.robinhood.com`, and `https://robinhoodchain.blockscout.com`.
- Preserve Avalanche-first defaults and every existing chain alias.
- Treat LI.FI route availability as live vendor state, not a permanent guarantee.
- Reject Robinhood Gas.zip requests before `fetch` while LI.FI's `gasZipBridge` matrix excludes chain `4663`.
- Live verification must remain read-only and quote-only; do not broadcast or fund transactions.
- Prefix CLI commands with `rtk`, except `npm run` commands as required by the repository instructions.
- Every milestone ends with focused tests and the full regression suite; fix all discovered regressions before advancing.

---

## File map

- Modify `src/utils/chains.ts`: canonical Robinhood metadata, LI.FI key, RPC overrides, and Gas.zip capability flag.
- Modify `src/utils/networks.ts`: add `robinhood` to the public `ChainName` union.
- Modify `src/bridge/gaszip.ts`: capability preflight and forced `gasZipBridge` quote routing.
- Modify `src/mcp/server.ts`: include Robinhood in the `switch_network` tool guidance.
- Modify `src/mcp/cli.ts`: correct the environment documentation for generic EVM aliases.
- Modify `test/chains.test.ts`: registry, alias, metadata, and mainnet-only regression coverage.
- Create `test/utils/robinhood-network.test.ts`: RPC default and environment override coverage.
- Modify `test/utils/errors-networks-safe-fetch.test.ts`: named-network resolution coverage.
- Modify `test/agent.test.ts`: construction, chain-info, and switching coverage.
- Modify `test/mcp/server.test.ts`: public MCP discovery and switching coverage.
- Modify `test/holdings/client.test.ts`: default native scan includes Robinhood.
- Modify `test/bridge/lifi.test.ts`: characterize and certify LI.FI request construction for chain `4663`.
- Modify `test/bridge/gaszip.test.ts`: unsupported-chain preflight and bridge-tool pinning regressions.
- Modify `README.md`: public support statement and quick-start example.
- Modify `skill/SKILL.md`: supported-chain count/list and environment guidance.
- Modify `docs/live-smoke-checklist.md`: read-only Robinhood verification steps.
- Modify `package.json`: add a Robinhood Chain discovery keyword.

---

## Milestone 1: Registry and core EVM surfaces

### Task 1: Drive Robinhood support through the central registry

**Files:**

- Modify: `test/chains.test.ts`
- Create: `test/utils/robinhood-network.test.ts`
- Modify: `test/utils/errors-networks-safe-fetch.test.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/mcp/server.test.ts`
- Modify: `test/holdings/client.test.ts`
- Modify: `src/utils/chains.ts`
- Modify: `src/utils/networks.ts`

**Interfaces:**

- Produces: `ChainName` member `'robinhood'`.
- Produces: `CHAINS[4663]: ChainConfig`.
- Produces: `CHAIN_ALIASES.robinhood === 4663`.
- Produces: `NETWORKS.robinhood: NetworkConfig` derived from the registry.
- Consumed by: `Evalanche`, `HoldingsClient`, MCP tools, and Milestone 2 bridge capability handling.

- [ ] **Step 1: Add failing chain-registry tests**

Add these cases to `test/chains.test.ts`:

```ts
it('should contain Robinhood Chain mainnet with official metadata', () => {
  expect(CHAINS[4663]).toMatchObject({
    id: 4663,
    name: 'Robinhood Chain',
    shortName: 'rh',
    currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    explorer: 'https://robinhoodchain.blockscout.com',
    lifiChainKey: 'out',
  });
  expect(CHAINS[4663].rpc).toContain('https://rpc.mainnet.chain.robinhood.com');
  expect(CHAINS[4663].isTestnet).not.toBe(true);
});

it('should expose only Robinhood mainnet', () => {
  expect(CHAIN_ALIASES.robinhood).toBe(4663);
  expect(CHAINS[46630]).toBeUndefined();
  expect(getAllChains(false).some((chain) => chain.id === 4663)).toBe(true);
});
```

Also add `4663` to `requiredIds` and `'robinhood'` to `requiredAliases` in the existing aggregate assertions.

- [ ] **Step 2: Add failing network-resolution and RPC-override tests**

Extend the known-alias test in `test/utils/errors-networks-safe-fetch.test.ts`:

```ts
expect(NETWORKS.robinhood.chainId).toBe(4663);
expect(getNetworkConfig('robinhood')).toMatchObject({
  chainId: 4663,
  name: 'Robinhood Chain',
  explorer: 'https://robinhoodchain.blockscout.com',
});
```

Create `test/utils/robinhood-network.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Robinhood Chain RPC configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses the official public RPC by default', async () => {
    vi.stubEnv('ROBINHOOD_RPC_URLS', '');
    vi.stubEnv('EVALANCHE_ROBINHOOD_RPC_URLS', '');
    vi.resetModules();

    const { getNetworkConfig } = await import('../../src/utils/networks');

    expect(getNetworkConfig('robinhood').rpcUrl)
      .toBe('https://rpc.mainnet.chain.robinhood.com');
  });

  it('prefers deduplicated environment RPC overrides', async () => {
    vi.stubEnv('ROBINHOOD_RPC_URLS', 'https://rpc.example/one, https://rpc.example/two');
    vi.stubEnv('EVALANCHE_ROBINHOOD_RPC_URLS', 'https://rpc.example/two');
    vi.resetModules();

    const { CHAINS } = await import('../../src/utils/chains');

    expect(CHAINS[4663].rpc).toEqual([
      'https://rpc.example/one',
      'https://rpc.example/two',
      'https://rpc.mainnet.chain.robinhood.com',
    ]);
  });
});
```

- [ ] **Step 3: Add failing agent behavior tests**

Add focused cases in the corresponding `test/agent.test.ts` describes:

```ts
it('should create an agent on Robinhood Chain', () => {
  const agent = new Evalanche({
    privateKey: TEST_PRIVATE_KEY,
    network: 'robinhood',
  });

  expect(agent.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
});

it('should return Robinhood Chain info', () => {
  const agent = new Evalanche({
    privateKey: TEST_PRIVATE_KEY,
    network: 'robinhood',
  });

  expect(agent.getChainInfo()).toMatchObject({
    id: 4663,
    name: 'Robinhood Chain',
    currency: { symbol: 'ETH' },
  });
});

it('should switch to Robinhood Chain', () => {
  const agent = new Evalanche({
    privateKey: TEST_PRIVATE_KEY,
    network: 'ethereum',
  });

  expect(agent.switchNetwork('robinhood').getChainInfo()).toMatchObject({
    id: 4663,
    name: 'Robinhood Chain',
  });
});
```

- [ ] **Step 4: Add failing MCP discovery and switching tests**

Add to `test/mcp/server.test.ts`:

```ts
it('lists Robinhood Chain as a supported mainnet', async () => {
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 9_4663,
    method: 'tools/call',
    params: { name: 'get_supported_chains', arguments: { includeTestnets: false } },
  });
  const result = res.result as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text);

  expect(parsed.chains).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: 4663,
      name: 'Robinhood Chain',
      currency: 'ETH',
      isTestnet: false,
    }),
  ]));
});

it('switches the MCP wallet to Robinhood Chain', async () => {
  const res = await server.handleRequest({
    jsonrpc: '2.0',
    id: 10_4663,
    method: 'tools/call',
    params: { name: 'switch_network', arguments: { network: 'robinhood' } },
  });
  const result = res.result as { content: Array<{ text: string }> };
  const parsed = JSON.parse(result.content[0].text);

  expect(parsed).toMatchObject({
    network: 'robinhood',
    chainId: 4663,
    name: 'Robinhood Chain',
  });
});
```

- [ ] **Step 5: Add a failing holdings-discovery regression**

Add to `test/holdings/client.test.ts`:

```ts
it('includes Robinhood Chain in the default native-balance scan', async () => {
  const switchedChains: string[] = [];
  const makeAgent = (chain: string): any => ({
    address: '0x0fe61780bd5508b3C99e420662050e5560608cA4',
    provider: { getBalance: vi.fn().mockResolvedValue(0n) },
    getChainInfo: () => ({ id: 0, name: chain, currency: { symbol: 'ETH' } }),
    switchNetwork: (next: string) => {
      switchedChains.push(next);
      return makeAgent(next);
    },
    hyperliquid: vi.fn(),
    dydx: vi.fn(),
  });

  const client = new HoldingsClient(makeAgent('ethereum'));
  await client.scan({ include: ['native'] });

  expect(switchedChains).toContain('robinhood');
});
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```bash
npm run test -- test/chains.test.ts test/utils/robinhood-network.test.ts test/utils/errors-networks-safe-fetch.test.ts test/agent.test.ts test/mcp/server.test.ts test/holdings/client.test.ts
```

Expected: FAIL because `CHAINS[4663]`, `CHAIN_ALIASES.robinhood`, and `NETWORKS.robinhood` do not exist; agent and MCP construction report `Unknown network: robinhood`; the holdings scan omits `robinhood`.

- [ ] **Step 7: Add the minimal registry implementation**

Add this mainnet entry to `CHAINS` in `src/utils/chains.ts`, ordered by chain ID:

```ts
4663: {
  id: 4663,
  name: 'Robinhood Chain',
  shortName: 'rh',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: withEnvRpcOverrides(
    ['https://rpc.mainnet.chain.robinhood.com'],
    ['ROBINHOOD_RPC_URLS', 'EVALANCHE_ROBINHOOD_RPC_URLS'],
  ),
  explorer: 'https://robinhoodchain.blockscout.com',
  lifiChainKey: 'out',
},
```

Add the alias in `CHAIN_ALIASES`:

```ts
robinhood: 4663,
```

Add the public name to `ChainName` in `src/utils/networks.ts`:

```ts
| 'robinhood'
```

- [ ] **Step 8: Run focused tests and verify GREEN**

Run the same focused command from Step 6.

Expected: all selected tests PASS with no warnings.

- [ ] **Step 9: Run the Milestone 1 regression gate**

Run:

```bash
npm run typecheck
npm run test
```

Expected: TypeScript exits `0`; the complete Vitest suite passes. Fix every regression before continuing.

- [ ] **Step 10: Commit Milestone 1**

```bash
rtk git add src/utils/chains.ts src/utils/networks.ts test/chains.test.ts test/utils/robinhood-network.test.ts test/utils/errors-networks-safe-fetch.test.ts test/agent.test.ts test/mcp/server.test.ts test/holdings/client.test.ts
rtk git commit -m "feat: add Robinhood Chain network support"
```

---

## Milestone 2: LI.FI certification and truthful Gas.zip behavior

### Task 2: Cover bridge routing and reject unavailable Gas.zip pairs

**Files:**

- Modify: `test/bridge/lifi.test.ts`
- Modify: `test/bridge/gaszip.test.ts`
- Modify: `test/chains.test.ts`
- Modify: `src/utils/chains.ts`
- Modify: `src/bridge/gaszip.ts`

**Interfaces:**

- Consumes: `CHAINS[4663]` and numeric LI.FI destination chain ID `4663` from Milestone 1.
- Produces: optional `ChainConfig.gasZipSupported?: boolean`.
- Produces: deterministic `GAS_ZIP_ERROR` before network access for explicitly unsupported chains.
- Preserves: existing `LiFiClient.getQuote(params): Promise<BridgeQuote>` and `GasZipClient.getQuote(params): Promise<GasZipQuote>` signatures.

- [ ] **Step 1: Add the LI.FI Robinhood characterization test**

Add to the `getQuote` describe in `test/bridge/lifi.test.ts`:

```ts
it('should construct a native ETH quote to Robinhood Chain', async () => {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 'ethereum-robinhood-eth',
      tool: 'across',
      action: {
        fromChainId: 1,
        toChainId: 4663,
        fromToken: { address: NATIVE_TOKEN },
        toToken: { address: NATIVE_TOKEN },
        fromAmount: '1000000000000000',
      },
      estimate: {
        toAmount: '985000000000000',
        gasCosts: [{ amountUSD: '0.25' }],
        executionDuration: 10,
      },
      transactionRequest: {
        to: '0xbridge',
        data: '0x',
        value: '1000000000000000',
      },
    }),
  });

  const quote = await client.getQuote({
    ...baseParams,
    toChainId: 4663,
    fromAmount: '0.001',
  });

  const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
  expect(callUrl.searchParams.get('fromChain')).toBe('1');
  expect(callUrl.searchParams.get('toChain')).toBe('4663');
  expect(callUrl.searchParams.get('fromToken')).toBe(NATIVE_TOKEN);
  expect(callUrl.searchParams.get('toToken')).toBe(NATIVE_TOKEN);
  expect(quote).toMatchObject({
    id: 'ethereum-robinhood-eth',
    fromChainId: 1,
    toChainId: 4663,
    tool: 'across',
  });
});
```

Run:

```bash
npm run test -- test/bridge/lifi.test.ts
```

Expected: PASS immediately. This is intentional characterization of the existing generic numeric-chain bridge path; no LI.FI production change is required.

- [ ] **Step 2: Add failing Gas.zip capability tests**

Import `EvalancheErrorCode` in `test/bridge/gaszip.test.ts`:

```ts
import { EvalancheErrorCode } from '../../src/utils/errors';
```

Add these tests:

```ts
it('should reject Robinhood Chain before requesting a quote', async () => {
  const error = await client.getQuote({
    ...baseParams,
    toChainId: 4663,
  }).catch((caught) => caught);

  expect(error).toMatchObject({ code: EvalancheErrorCode.GAS_ZIP_ERROR });
  expect(error.message).toContain('Robinhood Chain (4663)');
  expect(mockFetch).not.toHaveBeenCalled();
});
```

Extend the existing successful quote test:

```ts
const callUrl = new URL(mockFetch.mock.calls[0][0] as string);
expect(callUrl.searchParams.get('allowBridges')).toBe('gasZipBridge');
```

Extend the Robinhood registry test in `test/chains.test.ts`:

```ts
expect(CHAINS[4663].gasZipSupported).toBe(false);
```

- [ ] **Step 3: Run Gas.zip tests and verify RED**

Run:

```bash
npm run test -- test/bridge/gaszip.test.ts test/chains.test.ts
```

Expected: FAIL because `gasZipSupported` is absent, Robinhood reaches `fetch`, and successful Gas.zip requests omit `allowBridges=gasZipBridge`.

- [ ] **Step 4: Add capability metadata and preflight**

Extend `ChainConfig` in `src/utils/chains.ts`:

```ts
/** Explicit Gas.zip availability override; undefined delegates to live vendor behavior. */
gasZipSupported?: boolean;
```

Add to `CHAINS[4663]`:

```ts
gasZipSupported: false,
```

Import the registry lookup in `src/bridge/gaszip.ts`:

```ts
import { getChainById } from '../utils/chains';
```

Add this guard to `GasZipClient`:

```ts
private assertSupportedChainPair(params: GasZipParams): void {
  for (const chainId of [params.fromChainId, params.toChainId]) {
    const chain = getChainById(chainId);
    if (chain?.gasZipSupported === false) {
      throw new EvalancheError(
        `Gas.zip does not currently support ${chain.name} (${chain.id})`,
        EvalancheErrorCode.GAS_ZIP_ERROR,
      );
    }
  }
}
```

Call it as the first line of `findQuote`:

```ts
this.assertSupportedChainPair(params);
```

Pin the LI.FI bridge tool in `fetchLiFiQuote`:

```ts
const searchParams = new URLSearchParams({
  fromChain: params.fromChainId.toString(),
  toChain: params.toChainId.toString(),
  fromToken: NATIVE_TOKEN,
  toToken: NATIVE_TOKEN,
  fromAmount: fromAmountWei.toString(),
  fromAddress,
  toAddress: params.toAddress,
  integrator: 'evalanche',
  allowBridges: 'gasZipBridge',
});
```

- [ ] **Step 5: Run bridge tests and verify GREEN**

Run:

```bash
npm run test -- test/bridge/lifi.test.ts test/bridge/gaszip.test.ts test/chains.test.ts
```

Expected: all selected tests PASS; the Robinhood Gas.zip test performs zero fetches; supported Gas.zip tests still parse and execute mocked `gasZipBridge` transactions.

- [ ] **Step 6: Run the Milestone 2 regression gate**

Run:

```bash
npm run typecheck
npm run test
```

Expected: TypeScript and the complete Vitest suite pass. Fix every regression before continuing.

- [ ] **Step 7: Commit Milestone 2**

```bash
rtk git add src/utils/chains.ts src/bridge/gaszip.ts test/chains.test.ts test/bridge/lifi.test.ts test/bridge/gaszip.test.ts
rtk git commit -m "feat: certify Robinhood bridge capabilities"
```

---

## Milestone 3: Public documentation and full verification

### Task 3: Document the support boundary and prove the release surface

**Files:**

- Modify: `README.md`
- Modify: `skill/SKILL.md`
- Modify: `docs/live-smoke-checklist.md`
- Modify: `package.json`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/cli.ts`

**Interfaces:**

- Consumes: completed registry and bridge behavior from Milestones 1 and 2.
- Produces: public instructions for `network: 'robinhood'`, RPC overrides, LI.FI availability, and Gas.zip limitation.
- Preserves: package version and release notes until a separate release is cut.

- [ ] **Step 1: Update README support and usage**

Add a Robinhood example after the primary quick start in `README.md`:

```ts
const { agent: robinhoodAgent } = await Evalanche.boot({ network: 'robinhood' });
console.log(robinhoodAgent.getChainInfo()); // Robinhood Chain, chain ID 4663
```

Update the supported-EVM sentence to name Robinhood Chain:

```md
Avalanche is the primary path, but Evalanche also supports Robinhood Chain, Base, Ethereum, Arbitrum, Optimism, Polygon, BSC, and other EVM networks for execution and holdings discovery.
```

Add an operational note near the example:

```md
Robinhood's public RPC is rate-limited. For production, set `ROBINHOOD_RPC_URLS` or `EVALANCHE_ROBINHOOD_RPC_URLS` to a comma-separated list of provider endpoints. LI.FI bridging is supported when a live route is available; Gas.zip does not currently advertise Robinhood Chain support.
```

- [ ] **Step 2: Update the bundled skill and MCP guidance**

In `skill/SKILL.md`:

- replace both `21+` chain claims with `22+`;
- add `Robinhood Chain` to the explicit supported-chain list;
- include `'robinhood'` in the `AVALANCHE_NETWORK` examples.

Use this supported-chain sentence:

```md
Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, Robinhood Chain, Fantom, Gnosis, zkSync Era, Linea, Scroll, Blast, Mantle, Celo, Moonbeam, Cronos, Berachain, + testnets (Fuji, Sepolia, Base Sepolia).
```

Update the `switch_network` schema description in `src/mcp/server.ts`:

```ts
network: {
  type: 'string',
  description: 'Network name (e.g. "ethereum", "base", "robinhood", "arbitrum", "optimism", "polygon")',
},
```

Update the stale environment comment in `src/mcp/cli.ts`:

```ts
*   AVALANCHE_NETWORK  — named EVM alias such as "avalanche", "base", or "robinhood" (default: "avalanche")
```

- [ ] **Step 3: Add the live-smoke runbook**

Append this section to `docs/live-smoke-checklist.md`:

```md
## Robinhood Chain mainnet

- `eth_chainId` against `https://rpc.mainnet.chain.robinhood.com` returns `0x1237` (`4663`).
- `Evalanche.getSupportedChains(false)` includes `Robinhood Chain` and excludes chain `46630`.
- MCP `get_supported_chains` and `switch_network` expose alias `robinhood` and chain ID `4663`.
- A read-only LI.FI native ETH quote from Ethereum (`1`) to Robinhood Chain (`4663`) returns a route or an exact current liquidity/provider error.
- `fund_destination_gas` involving chain `4663` fails before execution with `Gas.zip does not currently support Robinhood Chain (4663)`.
- No bridge, gas-funding, transfer, or contract transaction is broadcast during this smoke pass.
```

- [ ] **Step 4: Update package discovery metadata**

Add this keyword in `package.json` without changing the package version:

```json
"robinhood-chain"
```

- [ ] **Step 5: Run documentation and metadata regressions**

Run:

```bash
npm run test -- test/utils/refresh-release-docs.test.ts test/utils/release-automation.test.ts
```

Expected: PASS; generated release sections and release metadata remain unchanged.

- [ ] **Step 6: Run static and full automated verification**

Run:

```bash
npm run typecheck
npm run build
npm run test
rtk git diff --check
```

Expected: every command exits `0`, all tests pass, build artifacts compile, and `git diff --check` emits no whitespace errors.

- [ ] **Step 7: Verify the official mainnet RPC read-only**

Run:

```bash
rtk node -e 'fetch("https://rpc.mainnet.chain.robinhood.com",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]})}).then(r=>r.json()).then(console.log)'
```

Expected: `{ jsonrpc: '2.0', id: 1, result: '0x1237' }` or equivalent JSON.

- [ ] **Step 8: Verify the built SDK surface read-only**

Run after `npm run build`:

```bash
rtk node -e 'import("./dist/index.mjs").then(({Evalanche})=>{const chain=Evalanche.getSupportedChains(false).find(c=>c.id===4663);console.log(JSON.stringify(chain))})'
```

Expected: JSON containing `"id":4663`, `"name":"Robinhood Chain"`, and the official RPC/explorer metadata.

- [ ] **Step 9: Verify a live LI.FI route without execution**

Run:

```bash
rtk node -e 'const n="0x0000000000000000000000000000000000000000",a="0x000000000000000000000000000000000000dEaD",u=new URL("https://li.quest/v1/quote");Object.entries({fromChain:"1",toChain:"4663",fromToken:n,toToken:n,fromAmount:"1000000000000000",fromAddress:a,toAddress:a,integrator:"evalanche"}).forEach(([k,v])=>u.searchParams.set(k,v));fetch(u).then(async r=>({status:r.status,body:await r.json()})).then(({status,body})=>console.log(JSON.stringify({status,tool:body.tool,fromChainId:body.action?.fromChainId,toChainId:body.action?.toChainId,error:body.message},null,2)))'
```

Expected: HTTP `200`, a bridge tool such as `across`, `fromChainId: 1`, and `toChainId: 4663`. If live liquidity has changed, record the exact vendor response and keep the deterministic unit coverage green.

- [ ] **Step 10: Reconfirm Gas.zip capability truth**

Run:

```bash
rtk node -e 'fetch("https://li.quest/v1/tools").then(r=>r.json()).then(x=>{const t=(x.bridges||[]).find(t=>t.key==="gasZipBridge");const pairs=(t?.supportedChains||[]).filter(p=>p.fromChainId===4663||p.toChainId===4663);console.log(JSON.stringify({key:t?.key,pairCount:pairs.length,pairs},null,2))})'
```

Expected: `key: "gasZipBridge"` and `pairCount: 0`. If `pairCount` is no longer zero, stop and update `gasZipSupported`, its tests, and the docs to current vendor truth before completion.

- [ ] **Step 11: Review the final diff and commit Milestone 3**

Run:

```bash
rtk git status --short
rtk git diff --stat
rtk git diff -- README.md skill/SKILL.md docs/live-smoke-checklist.md package.json src/mcp/server.ts src/mcp/cli.ts
```

Confirm only in-scope files changed, then commit:

```bash
rtk git add README.md skill/SKILL.md docs/live-smoke-checklist.md package.json src/mcp/server.ts src/mcp/cli.ts
rtk git commit -m "docs: document Robinhood Chain support"
```

- [ ] **Step 12: Run the final repository gate**

Run once more from the committed tree:

```bash
npm run typecheck
npm run build
npm run test
rtk git status --short --branch
```

Expected: all commands pass and the worktree is clean apart from the branch being ahead by the planned commits.
