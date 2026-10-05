import type { ChainName } from '../utils/networks';

export type HoldingsRegistrySource = 'local' | 'defillama' | 'avapilot';

export type HoldingsNetwork = ChainName | 'hyperliquid';

export type AssetType = 'erc20';

export type PositionSourceKind =
  | 'native_token'
  | 'erc20'
  | 'erc4626_vault'
  | 'liquid_staking'
  | 'lending_receipt'
  | 'lp_receipt'
  | 'prediction_venue'
  | 'perp_venue';

export type HoldingsInclude = 'native' | 'token' | 'defi' | 'prediction' | 'perp';

export type HoldingType =
  | 'native'
  | 'token'
  | 'vault'
  | 'staking'
  | 'lending'
  | 'lp'
  | 'prediction'
  | 'perp';

export interface ProtocolRecord {
  protocolId: string;
  name: string;
  slug: string;
  category: string;
  chains: HoldingsNetwork[];
  website?: string;
  aliases?: string[];
  source: HoldingsRegistrySource;
}

export interface AssetRecord {
  assetId: string;
  protocolId: string;
  chain: ChainName;
  address: string;
  symbol: string;
  decimals: number;
  assetType: AssetType;
  source: HoldingsRegistrySource;
}

export interface PositionSourceRecord {
  sourceId: string;
  protocolId: string;
  chain: HoldingsNetwork;
  sourceKind: PositionSourceKind;
  address?: string;
  detectorId: string;
  role?: string;
  underlyingTokens?: string[];
  priority?: number;
  source: HoldingsRegistrySource;
}

export interface HoldingsScanOptions {
  walletAddress?: string;
  chains?: HoldingsNetwork[];
  include?: HoldingsInclude[];
  protocols?: string[];
}

export interface HoldingRecord {
  holdingType: HoldingType;
  protocolId: string;
  protocolName: string;
  chain: HoldingsNetwork;
  venue?: string;
  assetAddress?: string;
  contractAddress?: string;
  symbol: string;
  displayBalance: string;
  rawBalance: string;
  underlyingValue?: string;
  underlyingToken?: string;
  positionMetadata?: Record<string, unknown>;
  source: HoldingsRegistrySource | 'onchain' | 'venue';
  confidence: 'high' | 'medium';
}

export interface HoldingsScanSummary {
  totalHoldings: number;
  byType: Record<string, number>;
  byChain: Record<string, number>;
  byProtocol: Record<string, number>;
}

export interface HoldingsScanResult {
  walletAddress: string;
  scannedAt: string;
  holdings: HoldingRecord[];
  summary: HoldingsScanSummary;
  warnings: string[];
}

export interface RegistrySearchResult {
  query: string;
  protocols: ProtocolRecord[];
  assets: AssetRecord[];
  sources: PositionSourceRecord[];
}

export interface RegistryStatusResult {
  protocols: number;
  assets: number;
  positionSources: number;
  countsBySource: Record<string, number>;
  countsByDetector: Record<string, number>;
}
