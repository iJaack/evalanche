import { getAddress } from 'ethers';
import protocolsSeed from './seed/protocols.universal.json';
import assetsSeed from './seed/assets.universal.json';
import sourcesSeed from './seed/sources.universal.json';
import { AVAPILOT_SEED_SERVICES } from '../../defi/avapilot-seed';
import { CHAIN_ALIASES, getChainByAlias, getChainById } from '../../utils/chains';
import type { ChainName } from '../../utils/networks';
import {
  EvalancheError,
  EvalancheErrorCode,
} from '../../utils/errors';
import type {
  AssetRecord,
  HoldingsNetwork,
  PositionSourceRecord,
  ProtocolRecord,
  RegistrySearchResult,
  RegistryStatusResult,
} from '../types';

export type UniversalDappResolutionSource =
  | 'local_registry'
  | 'defillama_registry'
  | 'avapilot_registry';

export interface UniversalResolvedDappRecord {
  address: string;
  network: ChainName;
  protocol: string;
  source: UniversalDappResolutionSource;
  aliases?: string[];
  category?: string;
  protocolId?: string;
}

type SeedProtocolRecord = ProtocolRecord;
type SeedAssetRecord = AssetRecord;
type SeedPositionSourceRecord = PositionSourceRecord;

const SOURCE_PRIORITY: Record<string, number> = {
  local: 3,
  avapilot: 2,
  defillama: 1,
};

function normalizeAddress(address: string): string {
  return getAddress(address.toLowerCase());
}

function normalizeNetworkName(network?: string): ChainName | undefined {
  if (!network) return undefined;
  const normalized = network.trim().toLowerCase();
  if (normalized in CHAIN_ALIASES) return normalized as ChainName;
  const chain = getChainByAlias(normalized);
  if (chain) {
    const alias = Object.entries(CHAIN_ALIASES).find(([, chainId]) => chainId === chain.id)?.[0];
    if (alias) return alias as ChainName;
  }
  const hyphenated = normalized.replace(/\s+/g, '-');
  if (hyphenated in CHAIN_ALIASES) return hyphenated as ChainName;
  return undefined;
}

function avapilotProtocolId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isEvmChain(chain: HoldingsNetwork): chain is ChainName {
  return !['hyperliquid'].includes(chain);
}

function mapRegistrySource(source: SeedPositionSourceRecord['source'] | SeedProtocolRecord['source']): UniversalDappResolutionSource {
  if (source === 'local') return 'local_registry';
  if (source === 'avapilot') return 'avapilot_registry';
  return 'defillama_registry';
}

const UNIVERSAL_PROTOCOL_RECORDS: ProtocolRecord[] = protocolsSeed as ProtocolRecord[];
const UNIVERSAL_ASSET_RECORDS: AssetRecord[] = assetsSeed as AssetRecord[];
const UNIVERSAL_SOURCE_RECORDS: PositionSourceRecord[] = sourcesSeed as PositionSourceRecord[];

function buildAvaPilotProtocolRecords(): ProtocolRecord[] {
  return AVAPILOT_SEED_SERVICES.map((service) => ({
    protocolId: avapilotProtocolId(service.name),
    name: service.name,
    slug: avapilotProtocolId(service.name),
    category: service.category?.toLowerCase() ?? 'defi',
    chains: ['avalanche'],
    website: service.website,
    aliases: service.aliases,
    source: 'avapilot',
  }));
}

function buildAvaPilotSourceRecords(): PositionSourceRecord[] {
  return AVAPILOT_SEED_SERVICES.flatMap((service) =>
    service.contracts
      .map((contract) => ({
        sourceId: `avapilot-${avapilotProtocolId(service.name)}-${contract.label}`,
        protocolId: avapilotProtocolId(service.name),
        chain: 'avalanche' as const,
        sourceKind: contract.label.startsWith('qi') ? 'lending_receipt' : contract.label === 'token' ? 'erc20' : 'erc20',
        address: normalizeAddress(contract.address),
        detectorId: contract.label.startsWith('qi')
          ? 'lending_receipt_detector'
          : contract.label === 'token'
            ? 'erc20_balance_detector'
            : 'erc20_balance_detector',
        role: contract.label,
        priority: 20,
        source: 'avapilot' as const,
      })),
  );
}

export class UniversalHoldingsRegistry {
  private readonly protocols: ProtocolRecord[];
  private readonly assets: AssetRecord[];
  private readonly sources: PositionSourceRecord[];
  private readonly protocolsById = new Map<string, ProtocolRecord>();
  private readonly protocolsBySlug = new Map<string, ProtocolRecord>();
  private readonly protocolsByAlias = new Map<string, ProtocolRecord>();
  private readonly assetsByChain = new Map<string, AssetRecord[]>();
  private readonly sourcesByChain = new Map<string, PositionSourceRecord[]>();

  constructor(input?: {
    protocols?: ProtocolRecord[];
    assets?: AssetRecord[];
    sources?: PositionSourceRecord[];
  }) {
    const mergedProtocols = this.mergeProtocols([
      ...(input?.protocols ?? UNIVERSAL_PROTOCOL_RECORDS),
      ...buildAvaPilotProtocolRecords(),
    ]);
    const mergedAssets = this.mergeAssets(input?.assets ?? UNIVERSAL_ASSET_RECORDS);
    const mergedSources = this.mergeSources([
      ...(input?.sources ?? UNIVERSAL_SOURCE_RECORDS),
      ...buildAvaPilotSourceRecords(),
    ]);

    this.protocols = mergedProtocols;
    this.assets = mergedAssets;
    this.sources = mergedSources;

    for (const protocol of this.protocols) {
      this.protocolsById.set(protocol.protocolId, protocol);
      this.protocolsBySlug.set(protocol.slug.toLowerCase(), protocol);
      this.setProtocolAlias(protocol.name, protocol);
      for (const alias of protocol.aliases ?? []) {
        this.setProtocolAlias(alias, protocol);
      }
    }

    for (const asset of this.assets) {
      const key = asset.chain;
      const list = this.assetsByChain.get(key) ?? [];
      list.push(asset);
      this.assetsByChain.set(key, list);
    }

    for (const source of this.sources) {
      const key = source.chain;
      const list = this.sourcesByChain.get(key) ?? [];
      list.push(source);
      this.sourcesByChain.set(key, list);
    }
  }

  private setProtocolAlias(alias: string, protocol: ProtocolRecord): void {
    const key = alias.trim().toLowerCase();
    const existing = this.protocolsByAlias.get(key);
    if (!existing || SOURCE_PRIORITY[protocol.source] >= SOURCE_PRIORITY[existing.source]) {
      this.protocolsByAlias.set(key, protocol);
    }
  }

  getProtocols(): ProtocolRecord[] {
    return [...this.protocols];
  }

  getAssets(): AssetRecord[] {
    return [...this.assets];
  }

  getPositionSources(): PositionSourceRecord[] {
    return [...this.sources];
  }

  getProtocol(protocolId: string): ProtocolRecord | undefined {
    return this.protocolsById.get(protocolId);
  }

  getAssetsForChain(chain: ChainName): AssetRecord[] {
    return [...(this.assetsByChain.get(chain) ?? [])];
  }

  getPositionSourcesForChains(chains?: HoldingsNetwork[]): PositionSourceRecord[] {
    if (!chains || chains.length === 0) return this.getPositionSources();
    return this.sources.filter((source) => chains.includes(source.chain));
  }

  search(query: string, options: { chain?: string; category?: string } = {}): RegistrySearchResult {
    const needle = query.trim().toLowerCase();
    const chain = options.chain?.trim().toLowerCase();
    const category = options.category?.trim().toLowerCase();
    const protocolIds = new Set<string>();

    const protocols = this.protocols.filter((protocol) => {
      if (chain && !protocol.chains.map((item) => item.toLowerCase()).includes(chain)) return false;
      if (category && protocol.category.toLowerCase() !== category) return false;
      if (!needle) return true;
      const haystacks = [protocol.name, protocol.slug, ...(protocol.aliases ?? [])];
      return haystacks.some((value) => value.toLowerCase().includes(needle));
    });

    for (const protocol of protocols) protocolIds.add(protocol.protocolId);

    const assets = this.assets.filter((asset) => {
      if (chain && asset.chain !== chain) return false;
      if (!needle) return protocolIds.has(asset.protocolId);
      return asset.symbol.toLowerCase().includes(needle)
        || asset.address.toLowerCase() === needle
        || protocolIds.has(asset.protocolId);
    });

    for (const asset of assets) protocolIds.add(asset.protocolId);

    const sources = this.sources.filter((source) => {
      if (chain && source.chain.toLowerCase() !== chain) return false;
      if (!needle) return protocolIds.has(source.protocolId);
      return source.address?.toLowerCase() === needle || protocolIds.has(source.protocolId);
    });

    return { query, protocols, assets, sources };
  }

  status(): RegistryStatusResult {
    const countsBySource: Record<string, number> = {};
    const countsByDetector: Record<string, number> = {};

    for (const protocol of this.protocols) {
      countsBySource[protocol.source] = (countsBySource[protocol.source] ?? 0) + 1;
    }
    for (const asset of this.assets) {
      countsBySource[asset.source] = (countsBySource[asset.source] ?? 0) + 1;
    }
    for (const source of this.sources) {
      countsBySource[source.source] = (countsBySource[source.source] ?? 0) + 1;
      countsByDetector[source.detectorId] = (countsByDetector[source.detectorId] ?? 0) + 1;
    }

    return {
      protocols: this.protocols.length,
      assets: this.assets.length,
      positionSources: this.sources.length,
      countsBySource,
      countsByDetector,
    };
  }

  resolveAddress(address: string): UniversalResolvedDappRecord | null {
    const normalized = normalizeAddress(address).toLowerCase();
    const candidates = this.sources
      .filter((source) => source.address && normalizeAddress(source.address).toLowerCase() === normalized)
      .filter((source) => isEvmChain(source.chain))
      .sort((a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0));

    const candidate = candidates[0];
    if (!candidate) return null;
    const protocol = this.protocolsById.get(candidate.protocolId);
    if (!protocol || !isEvmChain(candidate.chain)) return null;

    return {
      address: normalizeAddress(candidate.address ?? address),
      network: candidate.chain,
      protocol: protocol.name,
      aliases: protocol.aliases,
      category: protocol.category,
      protocolId: protocol.protocolId,
      source: mapRegistrySource(candidate.source),
    };
  }

  resolveAlias(alias: string): UniversalResolvedDappRecord | null {
    const protocol = this.protocolsByAlias.get(alias.trim().toLowerCase())
      ?? this.protocolsBySlug.get(alias.trim().toLowerCase());
    if (!protocol) return null;
    const sources = this.sources
      .filter((source) => source.protocolId === protocol.protocolId)
      .filter((source) => source.address && isEvmChain(source.chain))
      .sort((a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0));
    const source = sources[0];
    if (!source || !source.address || !isEvmChain(source.chain)) return null;

    return {
      address: normalizeAddress(source.address),
      network: source.chain,
      protocol: protocol.name,
      aliases: protocol.aliases,
      category: protocol.category,
      protocolId: protocol.protocolId,
      source: mapRegistrySource(source.source),
    };
  }

  private mergeProtocols(records: SeedProtocolRecord[]): ProtocolRecord[] {
    const byId = new Map<string, ProtocolRecord>();
    for (const record of records) {
      const existing = byId.get(record.protocolId);
      if (!existing || SOURCE_PRIORITY[record.source] >= SOURCE_PRIORITY[existing.source]) {
        byId.set(record.protocolId, {
          ...record,
          aliases: Array.from(new Set([...(existing?.aliases ?? []), ...(record.aliases ?? [])])),
        });
      }
    }
    return [...byId.values()];
  }

  private mergeAssets(records: SeedAssetRecord[]): AssetRecord[] {
    const byKey = new Map<string, AssetRecord>();
    for (const record of records) {
      const normalized = { ...record, address: normalizeAddress(record.address) };
      const key = `${normalized.chain}:${normalized.address.toLowerCase()}`;
      const existing = byKey.get(key);
      if (!existing || SOURCE_PRIORITY[normalized.source] >= SOURCE_PRIORITY[existing.source]) {
        byKey.set(key, normalized);
      }
    }
    return [...byKey.values()];
  }

  private mergeSources(records: SeedPositionSourceRecord[]): PositionSourceRecord[] {
    const byKey = new Map<string, PositionSourceRecord>();
    for (const record of records) {
      const normalized = {
        ...record,
        address: record.address ? normalizeAddress(record.address) : undefined,
      };
      const key = `${normalized.protocolId}:${normalized.chain}:${normalized.address?.toLowerCase() ?? normalized.detectorId}:${normalized.sourceKind}`;
      const existing = byKey.get(key);
      if (!existing || SOURCE_PRIORITY[normalized.source] >= SOURCE_PRIORITY[existing.source]) {
        byKey.set(key, normalized);
      }
    }
    return [...byKey.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }
}

export function createUniversalHoldingsRegistry(): UniversalHoldingsRegistry {
  return new UniversalHoldingsRegistry();
}

export function parseRegistryInteroperableAddress(target: string): { address: string; network?: ChainName } {
  const value = target.trim();
  const atMatch = value.match(/^(0x[a-fA-F0-9]{40})@([a-z0-9-]+)$/);
  if (atMatch) {
    const [, address, network] = atMatch;
    const normalized = normalizeNetworkName(network);
    if (!normalized) {
      throw new EvalancheError(
        `Unsupported interoperable address network: ${network}`,
        EvalancheErrorCode.INTEROP_ADDRESS_ERROR,
      );
    }
    return { address: normalizeAddress(address), network: normalized };
  }

  const caipMatch = value.match(/^eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  if (caipMatch) {
    const [, chainIdRaw, address] = caipMatch;
    const chain = getChainById(Number(chainIdRaw));
    const normalized = chain
      ? normalizeNetworkName(chain.shortName) ?? normalizeNetworkName(chain.name)
      : undefined;
    if (!normalized) {
      throw new EvalancheError(
        `Unsupported CAIP-10 chain ID: ${chainIdRaw}`,
        EvalancheErrorCode.INTEROP_ADDRESS_ERROR,
      );
    }
    return { address: normalizeAddress(address), network: normalized };
  }

  if (/^0x[a-fA-F0-9]{40}$/.test(value)) {
    return { address: normalizeAddress(value) };
  }

  throw new EvalancheError(
    `Invalid interoperable address input: ${target}`,
    EvalancheErrorCode.INTEROP_ADDRESS_ERROR,
  );
}
