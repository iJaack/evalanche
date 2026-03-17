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

  async getMarket(conditionId: string): Promise<PMMarket> {
    const url = `${GAMMA_API}/markets?conditionId=${conditionId}`;
    const res = await fetch(url);
    if (!res.ok) throw new EvalancheError(`Gamma API error: ${res.status}`, EvalancheErrorCode.POLYMARKET_ERROR);
    const data = await res.json() as Record<string, unknown>[];
    if (!data.length) throw new EvalancheError(`Market not found: ${conditionId}`, EvalancheErrorCode.POLYMARKET_NOT_FOUND);
    return this.mapMarket(data[0]);
  }

  async getPositions(walletAddress: string): Promise<PMPosition[]> {
    const url = `${GAMMA_API}/positions?user=${walletAddress}`;
    const res = await fetch(url);
    if (!res.ok) throw new EvalancheError(`Gamma API error: ${res.status}`, EvalancheErrorCode.POLYMARKET_ERROR);
    const data = await res.json() as Record<string, unknown>[];

    const positions: PMPosition[] = [];
    for (const p of data) {
      const tokenId = String(p.tokenId ?? p.token_id ?? '');
      if (!tokenId) continue;
      const balance: bigint = await this.ctfContract.balanceOf(walletAddress, tokenId);
      if (balance === 0n) continue;
      const shares = formatUnits(balance, 6);
      const currentPrice = Number(p.currentPrice ?? p.price ?? 0);
      positions.push({
        conditionId: String(p.conditionId ?? ''),
        question: String(p.question ?? ''),
        outcome: String(p.outcome ?? ''),
        tokenId,
        shares,
        currentPrice,
        value: Number(shares) * currentPrice,
      });
    }
    return positions;
  }

  async getOrderbook(tokenId: string): Promise<PMOrderbook> {
    const url = `${CLOB_API}/order-book?token_id=${tokenId}`;
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
    maxSlippagePct = 1,
  ): Promise<PMBuyResult> {
    // Fetch market to get tokenId
    const market = await this.getMarket(conditionId);
    const outcomeIndex = market.outcomes.indexOf(outcome);
    if (outcomeIndex === -1) throw new EvalancheError(`Outcome "${outcome}" not found in market`, EvalancheErrorCode.POLYMARKET_ORDER_FAILED);
    const tokenId = market.tokens?.[outcomeIndex]?.token_id;
    if (!tokenId) throw new EvalancheError('Token ID not found for outcome', EvalancheErrorCode.POLYMARKET_ORDER_FAILED);

    // Fetch orderbook for best ask
    const orderbook = await this.getOrderbook(tokenId);
    const bestAsk = Number(orderbook.bestAsk);
    if (bestAsk <= 0) throw new EvalancheError('No asks available in orderbook', EvalancheErrorCode.POLYMARKET_ORDER_FAILED);

    // Check MATIC balance for gas
    const address = await this.wallet.getAddress();
    const maticBalance = await this.provider.getBalance(address);
    if (maticBalance === 0n) throw new EvalancheError('Zero MATIC balance — cannot pay gas', EvalancheErrorCode.POLYMARKET_INSUFFICIENT_GAS);

    // Check + approve USDC allowance
    const amountWei = parseUnits(amountUSDC, 6);
    const allowance: bigint = await this.usdcContract.allowance(address, EXCHANGE);
    if (allowance < amountWei) {
      await this.approveUsdc(amountUSDC);
    }

    // Calculate estimated shares with slippage
    const maxPrice = bestAsk * (1 + maxSlippagePct / 100);
    const estimatedShares = Number(amountUSDC) / bestAsk;
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
      side: '0',
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
      pricePerShare: maxPrice,
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

    // Redeem positions
    const conditionIdBytes = conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`;
    const tx = await this.ctfRedeemer.redeemPositions(
      USDC_NATIVE,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      conditionIdBytes,
      [1, 2],
    );
    const receipt = await tx.wait();

    // Get USDC balance after redemption
    const balanceAfter: bigint = await this.usdcContract.balanceOf(address);
    const usdcReceived = formatUnits(balanceAfter - balanceBefore, 6);

    return { txHash: receipt.hash, usdcReceived };
  }

  private mapMarket(m: Record<string, unknown>): PMMarket {
    let outcomePrices: number[] = [];
    const rawPrices = m.outcomePrices;
    if (typeof rawPrices === 'string') {
      try { outcomePrices = JSON.parse(rawPrices) as number[]; } catch { /* empty */ }
    } else if (Array.isArray(rawPrices)) {
      outcomePrices = rawPrices.map(Number);
    }

    return {
      conditionId: String(m.conditionId ?? ''),
      question: String(m.question ?? ''),
      endDate: String(m.endDate ?? ''),
      outcomes: Array.isArray(m.outcomes) ? (m.outcomes as string[]) : typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : [],
      outcomePrices,
      volume: Number(m.volume ?? m.volumeNum ?? 0),
      liquidity: Number(m.liquidity ?? m.liquidityNum ?? 0),
      active: Boolean(m.active),
      closed: Boolean(m.closed),
      tokens: m.tokens as PMMarket['tokens'],
    };
  }
}
