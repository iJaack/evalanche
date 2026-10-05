import { Contract, formatEther, formatUnits } from 'ethers';
import { safeFetch } from '../utils/safe-fetch';
import { NETWORKS } from '../utils/networks';
import type { ChainName } from '../utils/networks';
import type { HyperliquidClient } from '../perps/hyperliquid/client';
import type { PerpPosition } from '../perps/types';
import type {
  AssetRecord,
  HoldingRecord,
  HoldingsInclude,
  HoldingsNetwork,
  HoldingsScanOptions,
  HoldingsScanResult,
  PositionSourceRecord,
  ProtocolRecord,
} from './types';
import { createUniversalHoldingsRegistry, type UniversalHoldingsRegistry } from './registry';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

const ERC4626_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function asset() view returns (address)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function symbol() view returns (string)',
] as const;

interface HoldingsAgentLike {
  address: string;
  provider: { getBalance(address: string): Promise<bigint> };
  getChainInfo(): { id: number; name: string; currency?: { symbol: string } };
  switchNetwork(network: ChainName): HoldingsAgentLike;
  hyperliquid(): Promise<HyperliquidClient>;
}

function isChainName(chain: HoldingsNetwork): chain is ChainName {
  return chain !== 'hyperliquid';
}

function buildSummary(holdings: HoldingRecord[]) {
  const byType: Record<string, number> = {};
  const byChain: Record<string, number> = {};
  const byProtocol: Record<string, number> = {};

  for (const holding of holdings) {
    byType[holding.holdingType] = (byType[holding.holdingType] ?? 0) + 1;
    byChain[holding.chain] = (byChain[holding.chain] ?? 0) + 1;
    byProtocol[holding.protocolId] = (byProtocol[holding.protocolId] ?? 0) + 1;
  }

  return {
    totalHoldings: holdings.length,
    byType,
    byChain,
    byProtocol,
  };
}

export class HoldingsClient {
  private readonly providerAgents = new Map<ChainName, HoldingsAgentLike>();

  constructor(
    private readonly agent: HoldingsAgentLike,
    private readonly registry: UniversalHoldingsRegistry = createUniversalHoldingsRegistry(),
  ) {}

  getRegistry(): UniversalHoldingsRegistry {
    return this.registry;
  }

  async scan(options: HoldingsScanOptions = {}): Promise<HoldingsScanResult> {
    const walletAddress = options.walletAddress ?? this.agent.address;
    const include = new Set<HoldingsInclude>(options.include ?? ['native', 'token', 'defi', 'prediction', 'perp']);
    const warnings: string[] = [];
    const holdings: HoldingRecord[] = [];
    const requestedChains = options.chains?.length ? options.chains : undefined;
    const protocolFilter = this.resolveProtocolFilter(options.protocols);

    if (include.has('native')) {
      const nativeChains = (requestedChains?.filter(isChainName) ?? this.defaultNativeChains());
      for (const chain of nativeChains) {
        try {
          const holding = await this.scanNativeBalance(chain, walletAddress);
          if (holding) holdings.push(holding);
        } catch (error) {
          warnings.push(`native:${chain}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (include.has('token')) {
      const tokenAssets = this.registry.getAssets().filter((asset) => {
        if (requestedChains && !requestedChains.includes(asset.chain)) return false;
        return protocolFilter.size === 0 || protocolFilter.has(asset.protocolId);
      });

      for (const asset of tokenAssets) {
        try {
          const holding = await this.scanTokenAsset(asset, walletAddress);
          if (holding) holdings.push(holding);
        } catch (error) {
          warnings.push(`token:${asset.chain}:${asset.symbol}:${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const defiSources = this.registry.getPositionSourcesForChains(requestedChains).filter((source) => {
      if (protocolFilter.size > 0 && !protocolFilter.has(source.protocolId)) return false;
      if (include.has('defi') && ['erc4626_vault', 'liquid_staking', 'lending_receipt', 'lp_receipt'].includes(source.sourceKind)) return true;
      if (include.has('prediction') && source.sourceKind === 'prediction_venue') return true;
      if (include.has('perp') && source.sourceKind === 'perp_venue') return true;
      return false;
    });

    for (const source of defiSources) {
      try {
        const detected = await this.scanPositionSource(source, walletAddress, warnings);
        holdings.push(...detected);
      } catch (error) {
        warnings.push(`${source.detectorId}:${source.protocolId}:${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const unique = this.dedupeHoldings(holdings);

    return {
      walletAddress,
      scannedAt: new Date().toISOString(),
      holdings: unique,
      summary: buildSummary(unique),
      warnings,
    };
  }

  private resolveProtocolFilter(filters?: string[]): Set<string> {
    if (!filters || filters.length === 0) return new Set<string>();
    const protocolIds = new Set<string>();
    for (const filter of filters) {
      const found = this.registry.search(filter);
      for (const protocol of found.protocols) protocolIds.add(protocol.protocolId);
      if (found.protocols.length === 0) protocolIds.add(filter.trim().toLowerCase());
    }
    return protocolIds;
  }

  private defaultNativeChains(): ChainName[] {
    return Object.keys(NETWORKS) as ChainName[];
  }

  private getAgentForChain(chain: ChainName): HoldingsAgentLike {
    const cached = this.providerAgents.get(chain);
    if (cached) return cached;
    const next = this.agent.switchNetwork(chain);
    this.providerAgents.set(chain, next);
    return next;
  }

  private getProtocol(protocolId: string): ProtocolRecord {
    const protocol = this.registry.getProtocol(protocolId);
    if (!protocol) {
      return {
        protocolId,
        name: protocolId,
        slug: protocolId,
        category: 'unknown',
        chains: [],
        source: 'local',
      };
    }
    return protocol;
  }

  private async scanNativeBalance(chain: ChainName, walletAddress: string): Promise<HoldingRecord | null> {
    const networkAgent = this.getAgentForChain(chain);
    const balance = await networkAgent.provider.getBalance(walletAddress);
    if (!balance || balance <= 0n) return null;

    const chainInfo = networkAgent.getChainInfo();
    const symbol = 'currency' in chainInfo && chainInfo.currency
      ? chainInfo.currency.symbol
      : chainInfo.name;

    return {
      holdingType: 'native',
      protocolId: `native-${chain}`,
      protocolName: `${chainInfo.name} Native`,
      chain,
      symbol,
      displayBalance: formatEther(balance),
      rawBalance: balance.toString(),
      source: 'onchain',
      confidence: 'high',
    };
  }

  private async scanTokenAsset(asset: AssetRecord, walletAddress: string): Promise<HoldingRecord | null> {
    const provider = this.getAgentForChain(asset.chain).provider;
    const contract = new Contract(asset.address, ERC20_ABI, provider as any);
    const balance: bigint = await contract.balanceOf(walletAddress);
    if (!balance || balance <= 0n) return null;

    const protocol = this.getProtocol(asset.protocolId);

    return {
      holdingType: 'token',
      protocolId: protocol.protocolId,
      protocolName: protocol.name,
      chain: asset.chain,
      assetAddress: asset.address,
      contractAddress: asset.address,
      symbol: asset.symbol,
      displayBalance: formatUnits(balance, asset.decimals),
      rawBalance: balance.toString(),
      source: asset.source,
      confidence: 'high',
    };
  }

  private async scanPositionSource(source: PositionSourceRecord, walletAddress: string, warnings: string[]): Promise<HoldingRecord[]> {
    switch (source.detectorId) {
      case 'erc4626_detector':
        return this.scanVaultSource(source, walletAddress, warnings);
      case 'liquid_staking_detector':
        return this.scanReceiptSource(source, walletAddress, 'staking');
      case 'lending_receipt_detector':
        return this.scanReceiptSource(source, walletAddress, 'lending');
      case 'lp_receipt_detector':
        return this.scanReceiptSource(source, walletAddress, 'lp');
      case 'polymarket_detector':
        return this.scanPolymarketPositions(source, walletAddress);
      case 'hyperliquid_detector':
        return this.scanPerpVenue(source, 'hyperliquid');
      case 'erc20_balance_detector': {
        if (!source.address || !isChainName(source.chain)) return [];
        const holding = await this.scanTokenAsset({
          assetId: source.sourceId,
          protocolId: source.protocolId,
          chain: source.chain,
          address: source.address,
          symbol: this.getProtocol(source.protocolId).name,
          decimals: 18,
          assetType: 'erc20',
          source: source.source,
        }, walletAddress);
        return holding ? [holding] : [];
      }
      default:
        return [];
    }
  }

  private async scanVaultSource(source: PositionSourceRecord, walletAddress: string, warnings: string[]): Promise<HoldingRecord[]> {
    if (!source.address || !isChainName(source.chain)) return [];
    const provider = this.getAgentForChain(source.chain).provider;
    const vault = new Contract(source.address, ERC4626_ABI, provider as any);
    const [balance, shareDecimals, assetAddress, symbol] = await Promise.all([
      vault.balanceOf(walletAddress),
      vault.decimals(),
      vault.asset(),
      vault.symbol().catch(() => this.getProtocol(source.protocolId).name),
    ]);

    if (!balance || balance <= 0n) return [];

    const assetRecord = this.registry.getAssets()
      .find((asset) => asset.chain === source.chain && asset.address.toLowerCase() === String(assetAddress).toLowerCase());
    let underlyingValue: bigint | undefined;
    try {
      underlyingValue = await vault.convertToAssets(balance);
    } catch {
      warnings.push(`${source.detectorId}:${source.protocolId}:underlying value unavailable; convertToAssets failed`);
    }
    const protocol = this.getProtocol(source.protocolId);

    return [{
      holdingType: 'vault',
      protocolId: protocol.protocolId,
      protocolName: protocol.name,
      chain: source.chain,
      assetAddress: assetRecord?.address ?? String(assetAddress),
      contractAddress: source.address,
      symbol: String(symbol),
      displayBalance: formatUnits(balance, Number(shareDecimals)),
      rawBalance: balance.toString(),
      underlyingValue: underlyingValue === undefined ? undefined : assetRecord
        ? formatUnits(underlyingValue, assetRecord.decimals)
        : underlyingValue.toString(),
      underlyingToken: assetRecord?.symbol,
      positionMetadata: {
        detectorId: source.detectorId,
        shareDecimals: Number(shareDecimals),
      },
      source: source.source,
      confidence: underlyingValue === undefined ? 'medium' : 'high',
    }];
  }

  private async scanReceiptSource(
    source: PositionSourceRecord,
    walletAddress: string,
    holdingType: 'staking' | 'lending' | 'lp',
  ): Promise<HoldingRecord[]> {
    if (!source.address || !isChainName(source.chain)) return [];
    const provider = this.getAgentForChain(source.chain).provider;
    const contract = new Contract(source.address, ERC20_ABI, provider as any);
    const [balance, decimals, symbol] = await Promise.all([
      contract.balanceOf(walletAddress),
      contract.decimals(),
      contract.symbol().catch(() => this.getProtocol(source.protocolId).name),
    ]);
    if (!balance || balance <= 0n) return [];

    const protocol = this.getProtocol(source.protocolId);
    const underlyingToken = source.underlyingTokens?.[0]?.split(':')[1];

    return [{
      holdingType,
      protocolId: protocol.protocolId,
      protocolName: protocol.name,
      chain: source.chain,
      assetAddress: source.address,
      contractAddress: source.address,
      symbol: String(symbol),
      displayBalance: formatUnits(balance, Number(decimals)),
      rawBalance: balance.toString(),
      underlyingToken,
      positionMetadata: {
        detectorId: source.detectorId,
        role: source.role,
      },
      source: source.source,
      confidence: 'high',
    }];
  }

  private async scanPolymarketPositions(source: PositionSourceRecord, walletAddress: string): Promise<HoldingRecord[]> {
    const response = await safeFetch(`https://data-api.polymarket.com/positions?user=${walletAddress}`);
    const positions = await response.json() as Array<Record<string, unknown>>;
    const protocol = this.getProtocol(source.protocolId);

    return (Array.isArray(positions) ? positions : [])
      .filter((position) => {
        const size = Number(position.size ?? position.balance ?? 0);
        const currentValue = Number(position.currentValue ?? position.current_value ?? 0);
        return Number.isFinite(size) && size > 0 && (currentValue >= 0 || size > 0);
      })
      .map((position) => ({
        holdingType: 'prediction' as const,
        protocolId: protocol.protocolId,
        protocolName: protocol.name,
        chain: source.chain,
        venue: 'polymarket',
        symbol: String(position.outcome ?? position.title ?? 'POSITION'),
        displayBalance: String(position.size ?? position.balance ?? '0'),
        rawBalance: String(position.size ?? position.balance ?? '0'),
        underlyingValue: position.currentValue != null ? String(position.currentValue) : undefined,
        positionMetadata: {
          conditionId: position.conditionId ?? position.condition_id,
          title: position.title,
          outcome: position.outcome,
          averageEntryPrice: position.avgPrice ?? position.avg_price,
          tokenId: position.asset ?? position.tokenId,
        },
        source: 'venue',
        confidence: 'high',
      }));
  }

  private async scanPerpVenue(source: PositionSourceRecord, venue: 'hyperliquid'): Promise<HoldingRecord[]> {
    const positions: PerpPosition[] = await (await this.agent.hyperliquid()).getPositions();

    const protocol = this.getProtocol(source.protocolId);
    return positions
      .filter((position) => Number(position.size) > 0)
      .map((position) => ({
        holdingType: 'perp' as const,
        protocolId: protocol.protocolId,
        protocolName: protocol.name,
        chain: source.chain,
        venue,
        symbol: position.market,
        displayBalance: position.size,
        rawBalance: position.size,
        positionMetadata: {
          side: position.side,
          entryPrice: position.entryPrice,
          unrealizedPnl: position.unrealizedPnl,
          liquidationPrice: position.liquidationPrice,
          marketId: position.marketId,
          marketClass: position.marketClass,
        },
        source: 'venue',
        confidence: 'high',
      }));
  }

  private dedupeHoldings(holdings: HoldingRecord[]): HoldingRecord[] {
    const byKey = new Map<string, HoldingRecord>();
    for (const holding of holdings) {
      const key = [
        holding.holdingType,
        holding.protocolId,
        holding.chain,
        holding.contractAddress ?? holding.assetAddress ?? holding.symbol,
        holding.positionMetadata?.conditionId ?? holding.positionMetadata?.marketId ?? '',
      ].join(':');
      if (!byKey.has(key)) byKey.set(key, holding);
    }
    return [...byKey.values()];
  }
}
