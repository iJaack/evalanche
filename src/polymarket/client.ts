import { Contract, parseUnits, formatUnits } from 'ethers';
import type { Wallet, HDNodeWallet, JsonRpcProvider } from 'ethers';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { PMMarket, PMPosition, PMOrderbook, PMBuyResult } from './types';

// Polymarket constants (Polygon mainnet)
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
// Blockscout Polygon API for on-chain token balance discovery
const BLOCKSCOUT_API = 'https://polygon.blockscout.com/api';
const CHAIN_ID = 137;

const ERC1155_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

type Signer = Wallet | HDNodeWallet;

export class PolymarketClient {
  private ctfContract: Contract;
  private usdcContract: Contract;
  private ctfRedeemer: Contract;

  constructor(private wallet: Signer, private provider: JsonRpcProvider) {
    this.ctfContract = new Contract(CTF_CONTRACT, ERC1155_ABI, provider);
    this.usdcContract = new Contract(USDC_NATIVE, ERC20_ABI, wallet);
    this.ctfRedeemer = new Contract(CTF_CONTRACT, CTF_ABI, wallet);
  }

  async searchMarkets(query: string, limit = 10): Promise<PMMarket[]> {
    const url = `${GAMMA_API}/markets?active=true&limit=${limit}&keyword=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new EvalancheError(`Gamma API error: ${res.status}`, EvalancheErrorCode.POLYMARKET_ERROR);
    const data = await res.json() as Record<string, unknown>[];
    return data.map((m) => this.mapMarket(m));
  }

  /**
   * Get a specific market by numeric market ID or conditionId (0x...).
   *
   * Bug fix: Gamma API `?conditionId=X` does NOT filter — it ignores the param
   * and returns all markets. The correct approaches are:
   *   - Numeric ID: GET /markets/{id}  (e.g. "1581306")
   *   - conditionId: GET /markets?id=X where X is the numeric ID
   *     OR search by conditionId client-side after fetching by ?id=
   *
   * This method accepts either a numeric market ID (as string) or a 0x conditionId.
   * If conditionId is given, it uses ?id= param which Gamma DOES filter correctly,
   * but we don't have the numeric ID from conditionId alone — so we fall back to
   * fetching recent markets and scanning, or use the direct /markets/{id} path.
   *
   * Best practice: prefer numeric market ID. conditionId lookup does a CLOB search.
   */
  async getMarket(idOrConditionId: string): Promise<PMMarket> {
    // For conditionId: fetch from CLOB (canonical tokens source), merge with Gamma for volume/liquidity
    // For numeric ID: fetch from Gamma, then enrich with CLOB tokens
    // In both cases we need CLOB tokens array for buy() to work.

    let conditionId = idOrConditionId;
    let gammaData: Record<string, unknown> | null = null;

    if (/^\d+$/.test(idOrConditionId)) {
      // Numeric ID → Gamma for market details
      const url = `${GAMMA_API}/markets/${idOrConditionId}`;
      const res = await fetch(url);
      if (res.status === 404) throw new EvalancheError(`Market not found: ${idOrConditionId}`, EvalancheErrorCode.POLYMARKET_NOT_FOUND);
      if (!res.ok) throw new EvalancheError(`Gamma API error: ${res.status}`, EvalancheErrorCode.POLYMARKET_ERROR);
      gammaData = await res.json() as Record<string, unknown>;
      conditionId = String(gammaData.conditionId ?? '');
    } else {
      // conditionId → try Gamma ?id= param (correct filter)
      // First resolve via CLOB to get numeric Gamma ID
      const clobUrl = `${CLOB_API}/markets/${idOrConditionId}`;
      const clobRes = await fetch(clobUrl);
      if (clobRes.ok) {
        const clobData = await clobRes.json() as Record<string, unknown>;
        const gammaId = String(clobData.id ?? clobData.market_id ?? '');
        if (gammaId) {
          const gammaUrl = `${GAMMA_API}/markets?id=${gammaId}`;
          const gammaRes = await fetch(gammaUrl);
          if (gammaRes.ok) {
            const markets = await gammaRes.json() as Record<string, unknown>[];
            if (markets.length) gammaData = markets[0];
          }
        }
      }
    }

    // Always fetch CLOB market data to get tokens[] (required for buy())
    if (conditionId) {
      const clobUrl = `${CLOB_API}/markets/${conditionId}`;
      const clobRes = await fetch(clobUrl);
      if (clobRes.ok) {
        const clobData = await clobRes.json() as Record<string, unknown>;
        // Merge: use gammaData as base (has volume/liquidity), inject CLOB tokens
        const merged = { ...(gammaData ?? clobData), tokens: clobData.tokens };
        return this.mapMarket(merged);
      }
    }

    if (gammaData) return this.mapMarket(gammaData);

    // Final fallback: use conditionId param — Gamma ignores it as a filter but we
    // client-side filter for matching conditionId
    const fallbackUrl = `${GAMMA_API}/markets?limit=100`;
    const fallbackRes = await fetch(fallbackUrl);
    if (!fallbackRes.ok) throw new EvalancheError(`Gamma API error: ${fallbackRes.status}`, EvalancheErrorCode.POLYMARKET_ERROR);
    const all = await fallbackRes.json() as Record<string, unknown>[];
    const match = all.find((m) => String(m.conditionId ?? '').toLowerCase() === idOrConditionId.toLowerCase());
    if (!match) throw new EvalancheError(`Market not found for conditionId: ${idOrConditionId}`, EvalancheErrorCode.POLYMARKET_NOT_FOUND);
    return this.mapMarket(match);
  }

  /**
   * Get on-chain verified CTF ERC-1155 positions for a wallet.
   *
   * Bug fix: Gamma /positions endpoint returns 404. Instead we:
   * 1. Query Blockscout for ERC-1155 token transfers to/from the wallet
   *    on the CTF contract to discover token IDs held
   * 2. For each token ID, call ctfContract.balanceOf() directly on-chain
   * 3. Filter out zero balances — on-chain truth only
   * 4. Enrich with Gamma market data for prices/questions
   */
  async getPositions(walletAddress: string): Promise<PMPosition[]> {
    // Step 1: Discover CTF token IDs held by wallet via Blockscout token transfers
    let tokenIds: string[] = [];
    try {
      const url = `${BLOCKSCOUT_API}?module=account&action=tokennfttx&contractaddress=${CTF_CONTRACT}&address=${walletAddress}&sort=asc`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as { status: string; result: Array<{ tokenID: string }> };
        if (data.status === '1' && Array.isArray(data.result)) {
          // Deduplicate token IDs
          tokenIds = [...new Set(data.result.map((tx) => tx.tokenID))];
        }
      }
    } catch {
      // Blockscout unavailable — proceed with empty (will return [] — accurate for new wallets)
    }

    if (tokenIds.length === 0) return [];

    // Step 2: Verify on-chain balances via balanceOfBatch
    const addresses = tokenIds.map(() => walletAddress);
    let balances: bigint[];
    try {
      balances = await this.ctfContract.balanceOfBatch(addresses, tokenIds);
    } catch {
      // Fallback to individual calls if batch fails
      balances = await Promise.all(
        tokenIds.map((id) => this.ctfContract.balanceOf(walletAddress, id) as Promise<bigint>),
      );
    }

    // Step 3: Filter non-zero, enrich with Gamma data
    const positions: PMPosition[] = [];
    for (let i = 0; i < tokenIds.length; i++) {
      const balance = balances[i];
      if (!balance || balance === 0n) continue;

      const tokenId = tokenIds[i];
      const shares = formatUnits(balance, 6);

      // Try to enrich from Gamma — best effort
      let conditionId = '';
      let question = '';
      let outcome = '';
      let currentPrice = 0;
      try {
        const gammaUrl = `${GAMMA_API}/markets?clob_token_ids=${tokenId}`;
        const gammaRes = await fetch(gammaUrl);
        if (gammaRes.ok) {
          const markets = await gammaRes.json() as Record<string, unknown>[];
          if (markets.length) {
            const m = this.mapMarket(markets[0]);
            conditionId = m.conditionId;
            question = m.question;
            const tokenIndex = m.tokens?.findIndex((t) => t.token_id === tokenId) ?? -1;
            if (tokenIndex >= 0) {
              outcome = m.outcomes[tokenIndex] ?? '';
              currentPrice = m.outcomePrices[tokenIndex] ?? 0;
            }
          }
        }
      } catch { /* best-effort enrichment */ }

      positions.push({
        conditionId,
        question,
        outcome,
        tokenId,
        shares,
        currentPrice,
        value: Number(shares) * currentPrice,
      });
    }

    return positions;
  }

  async getOrderbook(tokenId: string): Promise<PMOrderbook> {
    const url = `${CLOB_API}/book?token_id=${tokenId}`;
    const res = await fetch(url);
    if (!res.ok) throw new EvalancheError(`CLOB API error: ${res.status}`, EvalancheErrorCode.POLYMARKET_ERROR);
    const data = await res.json() as Record<string, unknown>;

    const bids = (data.bids as Array<{ price: string; size: string }>) ?? [];
    const asks = (data.asks as Array<{ price: string; size: string }>) ?? [];
    const bestBid = bids.length ? bids[0].price : '0';
    const bestAsk = asks.length ? asks[0].price : '0';
    const spread = String(Number(bestAsk) - Number(bestBid));

    return { bids, asks, bestBid, bestAsk, spread };
  }

  async approveUsdc(amount: string): Promise<{ txHash: string }> {
    const amountWei = parseUnits(amount, 6);
    try {
      const tx = await this.usdcContract.approve(EXCHANGE, amountWei);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    } catch {
      // Fallback to bridged USDC
      const bridgedUsdc = new Contract(USDC_BRIDGED, ERC20_ABI, this.wallet);
      const tx = await bridgedUsdc.approve(EXCHANGE, amountWei);
      const receipt = await tx.wait();
      return { txHash: receipt.hash };
    }
  }

  async buy(
    conditionId: string,
    outcome: 'YES' | 'NO',
    amountUSDC: string,
    options: {
      orderType?: 'market' | 'limit';
      limitPrice?: number;
      maxSlippagePct?: number;
    } = {},
  ): Promise<PMBuyResult> {
    const orderType = options.orderType ?? 'market';
    const maxSlippagePct = options.maxSlippagePct ?? 1;

    // Fetch market to get tokenId
    const market = await this.getMarket(conditionId);
    const outcomeIndex = market.outcomes.findIndex(
      (o) => o.toLowerCase() === outcome.toLowerCase(),
    );
    if (outcomeIndex === -1) throw new EvalancheError(`Outcome ${outcome} not found in market outcomes: ${market.outcomes.join(', ')}`, EvalancheErrorCode.POLYMARKET_ORDER_FAILED);
    const tokenId = market.tokens?.[outcomeIndex]?.token_id;
    if (!tokenId) throw new EvalancheError('Token ID not found for outcome — market.tokens missing', EvalancheErrorCode.POLYMARKET_ORDER_FAILED);

    // Determine fill price
    let fillPrice: number;
    if (orderType === 'limit') {
      if (!options.limitPrice || options.limitPrice <= 0 || options.limitPrice >= 1) {
        throw new EvalancheError('limitPrice required for limit orders and must be between 0 and 1', EvalancheErrorCode.POLYMARKET_ORDER_FAILED);
      }
      fillPrice = options.limitPrice;
    } else {
      // Market order: use best ask with slippage cap
      const orderbook = await this.getOrderbook(tokenId);
      const bestAsk = Number(orderbook.bestAsk);
      if (bestAsk <= 0) throw new EvalancheError('No asks available in orderbook', EvalancheErrorCode.POLYMARKET_ORDER_FAILED);
      fillPrice = bestAsk * (1 + maxSlippagePct / 100);
    }

    // Check MATIC balance for gas
    const address = await this.wallet.getAddress();
    const maticBalance = await this.provider.getBalance(address);
    if (maticBalance === 0n) throw new EvalancheError(
      'Zero MATIC balance — cannot pay gas on Polygon. Use fund_destination_gas tool to send MATIC from another chain.',
      EvalancheErrorCode.POLYMARKET_INSUFFICIENT_GAS,
    );

    // Check + approve USDC allowance
    const amountWei = parseUnits(amountUSDC, 6);
    const allowance: bigint = await this.usdcContract.allowance(address, EXCHANGE);
    if (allowance < amountWei) {
      await this.approveUsdc(amountUSDC);
    }

    // makerAmount = USDC to spend; takerAmount = shares expected at fillPrice
    // For limit (GTC maker): CLOB holds until a seller hits the bid at fillPrice
    const estimatedShares = Number(amountUSDC) / fillPrice;
    const takerAmount = BigInt(Math.floor(estimatedShares * 1e6));

    // Build order
    const order = {
      maker: address,
      signer: address,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount: amountWei.toString(),
      takerAmount: takerAmount.toString(),
      expiration: '0',
      nonce: '0',
      feeRateBps: '0',
      side: '0', // BUY
      signatureType: '0',
    };

    // EIP-712 signing
    const domain = {
      name: 'Polymarket CTF Exchange',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: EXCHANGE,
    };

    const types = {
      Order: [
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    };

    const signature = await this.wallet.signTypedData(domain, types, order);

    // Submit to CLOB
    const res = await fetch(`${CLOB_API}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order, signature }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new EvalancheError(`Order submission failed: ${errText}`, EvalancheErrorCode.POLYMARKET_ORDER_FAILED);
    }

    const result = await res.json() as Record<string, unknown>;

    return {
      orderId: String(result.orderId ?? result.id ?? ''),
      tokenId,
      side: outcome,
      amountUSDC,
      estimatedShares,
      pricePerShare: fillPrice,
      orderType,
    };
  }

  async redeem(conditionId: string): Promise<{ txHash: string; usdcReceived: string }> {
    const market = await this.getMarket(conditionId);
    if (market.active && !market.closed) {
      throw new EvalancheError('Market is still active — cannot redeem', EvalancheErrorCode.POLYMARKET_MARKET_CLOSED);
    }

    // Get USDC balance before redemption
    const address = await this.wallet.getAddress();
    const balanceBefore: bigint = await this.usdcContract.balanceOf(address);

    // Redeem positions (indexSets [1,2] = YES and NO outcome slots)
    const conditionIdBytes = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;
    const tx = await this.ctfRedeemer.redeemPositions(
      USDC_NATIVE,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      conditionIdBytes,
      [1, 2],
    );
    const receipt = await tx.wait();

    // Compute USDC received from balance diff
    const balanceAfter: bigint = await this.usdcContract.balanceOf(address);
    const usdcReceived = formatUnits(balanceAfter - balanceBefore, 6);

    return { txHash: receipt.hash, usdcReceived };
  }

  private mapMarket(m: Record<string, unknown>): PMMarket {
    let outcomePrices: number[] = [];
    const rawPrices = m.outcomePrices;
    if (typeof rawPrices === 'string') {
      try { outcomePrices = (JSON.parse(rawPrices) as (string | number)[]).map(Number); } catch { /* empty */ }
    } else if (Array.isArray(rawPrices)) {
      outcomePrices = rawPrices.map(Number);
    }

    let outcomes: string[] = [];
    if (Array.isArray(m.outcomes)) {
      outcomes = m.outcomes as string[];
    } else if (typeof m.outcomes === 'string') {
      try { outcomes = JSON.parse(m.outcomes) as string[]; } catch { /* empty */ }
    }

    return {
      conditionId: String(m.conditionId ?? ''),
      question: String(m.question ?? ''),
      endDate: String(m.endDate ?? ''),
      outcomes,
      outcomePrices,
      volume: Number(m.volume ?? m.volumeNum ?? 0),
      liquidity: Number(m.liquidity ?? m.liquidityNum ?? 0),
      active: Boolean(m.active),
      closed: Boolean(m.closed),
      tokens: m.tokens as PMMarket['tokens'],
    };
  }
}
