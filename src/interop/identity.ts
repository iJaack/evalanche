import { Contract, JsonRpcProvider } from 'ethers';
import { IDENTITY_ABI, IDENTITY_REGISTRY } from '../identity/constants';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type {
  AgentRegistration,
  AgentServiceEntry,
  EndpointVerification,
  ServiceEndpoints,
  TransportType,
} from './schemas';

/** ABI for reading agentURI and metadata from the ERC-8004 registry */
const REGISTRY_ABI = [
  ...IDENTITY_ABI,
  'function tokenURI(uint256 agentId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

/** ABI for reading key-value metadata from ERC-8004 */
const METADATA_ABI = [
  'function metadata(uint256 agentId, string key) view returns (string)',
];

/** Transport priority for getPreferredTransport */
const TRANSPORT_PRIORITY: TransportType[] = ['A2A', 'XMTP', 'MCP', 'web'];

/** Default IPFS gateway */
const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/**
 * InteropIdentityResolver resolves full ERC-8004 agent registrations.
 *
 * Given an agent ID, it reads the on-chain `agentURI`, fetches the
 * registration file (JSON), and returns typed data including services,
 * wallet address, trust modes, and endpoint bindings.
 *
 * Supports `ipfs://`, `https://`, and `data:` URI schemes.
 *
 * @example
 * ```ts
 * const resolver = new InteropIdentityResolver(provider);
 * const registration = await resolver.resolveAgent(1599);
 * console.log(registration.services);
 * ```
 */
export class InteropIdentityResolver {
  private readonly _provider: JsonRpcProvider;
  private readonly _defaultRegistry: string;

  constructor(provider: JsonRpcProvider, defaultRegistry?: string) {
    this._provider = provider;
    this._defaultRegistry = defaultRegistry ?? IDENTITY_REGISTRY;
  }

  /**
   * Resolve the full agent registration file from on-chain agentURI.
   * @param agentId - Agent token ID (number or string)
   * @param agentRegistry - Optional override for registry contract address
   * @returns Parsed AgentRegistration from the agent's URI
   */
  async resolveAgent(agentId: number | string, agentRegistry?: string): Promise<AgentRegistration> {
    const registry = agentRegistry ?? this._defaultRegistry;
    const contract = new Contract(registry, REGISTRY_ABI, this._provider);
    const idBigInt = BigInt(agentId);

    let agentURI: string;
    try {
      agentURI = await contract.getFunction('tokenURI')(idBigInt) as string;
    } catch (error) {
      throw new EvalancheError(
        `Agent ${agentId} not found in registry ${registry}`,
        EvalancheErrorCode.AGENT_NOT_FOUND,
        error instanceof Error ? error : undefined,
      );
    }

    if (!agentURI) {
      throw new EvalancheError(
        `Agent ${agentId} has no URI set`,
        EvalancheErrorCode.AGENT_NOT_FOUND,
      );
    }

    return this._fetchRegistration(agentURI, String(agentId));
  }

  /**
   * Get all service endpoints from an agent's registration file.
   * @param agentId - Agent token ID
   * @param agentRegistry - Optional registry override
   * @returns Array of typed service entries
   */
  async getServiceEndpoints(agentId: number | string, agentRegistry?: string): Promise<AgentServiceEntry[]> {
    const registration = await this.resolveAgent(agentId, agentRegistry);
    return registration.services;
  }

  /**
   * Get the preferred transport for an agent, based on priority order:
   * A2A > XMTP > MCP > web.
   * @param agentId - Agent token ID
   * @param agentRegistry - Optional registry override
   * @returns The best available transport type and endpoint, or null if none
   */
  async getPreferredTransport(
    agentId: number | string,
    agentRegistry?: string,
  ): Promise<{ transport: TransportType; endpoint: string } | null> {
    const services = await this.getServiceEndpoints(agentId, agentRegistry);
    const endpointMap: ServiceEndpoints = {};

    for (const svc of services) {
      if (!endpointMap[svc.name]) {
        endpointMap[svc.name] = svc.endpoint;
      }
    }

    for (const transport of TRANSPORT_PRIORITY) {
      const endpoint = endpointMap[transport];
      if (endpoint) {
        return { transport, endpoint };
      }
    }

    // Fall back to first available service
    if (services.length > 0) {
      return { transport: services[0].name, endpoint: services[0].endpoint };
    }

    return null;
  }

  /**
   * Resolve the agent wallet address from on-chain metadata.
   * Reads the "agentWallet" key from the registry's metadata mapping.
   * Falls back to the registration file's agentWallet field.
   * @param agentId - Agent token ID
   * @param agentRegistry - Optional registry override
   * @returns Wallet address string
   */
  async resolveAgentWallet(agentId: number | string, agentRegistry?: string): Promise<string> {
    const registry = agentRegistry ?? this._defaultRegistry;

    // Try on-chain metadata first
    try {
      const contract = new Contract(registry, METADATA_ABI, this._provider);
      const wallet = await contract.getFunction('metadata')(BigInt(agentId), 'agentWallet') as string;
      if (wallet && wallet !== '') {
        return wallet;
      }
    } catch {
      // metadata function may not exist; fall through to registration file
    }

    // Fallback: read from registration file
    const registration = await this.resolveAgent(agentId, agentRegistry);
    if (!registration.agentWallet) {
      throw new EvalancheError(
        `No wallet found for agent ${agentId}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
      );
    }
    return registration.agentWallet;
  }

  /**
   * Verify that an agent's endpoint domain has a matching registration binding.
   * Fetches `https://{domain}/.well-known/agent-registration.json` and checks
   * that `registrations[]` contains a matching agentRegistry + agentId.
   * @param agentId - Agent token ID
   * @param endpoint - The endpoint URL to verify
   * @param agentRegistry - Optional registry override
   * @returns Verification result with verified flag and optional reason
   */
  async verifyEndpointBinding(
    agentId: number | string,
    endpoint: string,
    agentRegistry?: string,
  ): Promise<EndpointVerification> {
    const registry = agentRegistry ?? this._defaultRegistry;

    let domain: string;
    try {
      const url = new URL(endpoint);
      domain = url.hostname;
    } catch {
      return { verified: false, reason: 'Invalid endpoint URL' };
    }

    const wellKnownUrl = `https://${domain}/.well-known/agent-registration.json`;

    try {
      const res = await fetch(wellKnownUrl);
      if (!res.ok) {
        return { verified: false, reason: `Well-known endpoint returned ${res.status}` };
      }

      const data = await res.json() as { registrations?: Array<{ agentRegistry: string; agentId: string }> };
      if (!data.registrations || !Array.isArray(data.registrations)) {
        return { verified: false, reason: 'No registrations array in well-known file' };
      }

      const agentIdStr = String(agentId);
      const match = data.registrations.some(
        (r) => r.agentId === agentIdStr && this._registryMatches(r.agentRegistry, registry),
      );

      if (match) {
        return { verified: true };
      }

      return { verified: false, reason: 'No matching registration found for this agent and registry' };
    } catch (error) {
      return {
        verified: false,
        reason: `Failed to fetch well-known file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Reverse-resolve an agent ID from a wallet address by querying
   * Transfer events on the identity registry.
   * @param address - Wallet address to look up
   * @param agentRegistry - Optional registry override
   * @returns Agent ID string, or null if not found
   */
  async resolveByWallet(address: string, agentRegistry?: string): Promise<string | null> {
    const registry = agentRegistry ?? this._defaultRegistry;
    const contract = new Contract(registry, REGISTRY_ABI, this._provider);

    try {
      // Query Transfer events where 'to' is the given address
      const filter = contract.filters.Transfer(null, address);
      const events = await contract.queryFilter(filter);

      if (events.length === 0) {
        return null;
      }

      // Return the most recent transfer's token ID
      const lastEvent = events[events.length - 1];
      if ('args' in lastEvent && lastEvent.args) {
        const tokenId = lastEvent.args[2];
        return String(tokenId);
      }

      return null;
    } catch (error) {
      throw new EvalancheError(
        `Failed to resolve agent by wallet ${address}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Fetch and parse a registration file from a URI.
   * Supports ipfs://, https://, and data: schemes.
   */
  private async _fetchRegistration(uri: string, agentId: string): Promise<AgentRegistration> {
    let json: string;

    if (uri.startsWith('data:')) {
      json = this._decodeDataUri(uri);
    } else if (uri.startsWith('ipfs://')) {
      const cid = uri.slice(7);
      const gatewayUrl = `${IPFS_GATEWAY}${cid}`;
      json = await this._fetchUrl(gatewayUrl, agentId);
    } else if (uri.startsWith('https://') || uri.startsWith('http://')) {
      json = await this._fetchUrl(uri, agentId);
    } else {
      throw new EvalancheError(
        `Unsupported URI scheme for agent ${agentId}: ${uri.split(':')[0] ?? uri}`,
        EvalancheErrorCode.UNSUPPORTED_URI_SCHEME,
      );
    }

    try {
      const parsed = JSON.parse(json) as AgentRegistration;
      return parsed;
    } catch (error) {
      throw new EvalancheError(
        `Failed to parse registration JSON for agent ${agentId}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /** Fetch a URL and return the response text */
  private async _fetchUrl(url: string, agentId: string): Promise<string> {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new EvalancheError(
          `HTTP ${res.status} fetching registration for agent ${agentId}: ${url}`,
          EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
        );
      }
      return await res.text();
    } catch (error) {
      if (error instanceof EvalancheError) throw error;
      throw new EvalancheError(
        `Failed to fetch registration for agent ${agentId}: ${url}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /** Decode a data: URI (supports base64 and plain text) */
  private _decodeDataUri(uri: string): string {
    // data:[<mediatype>][;base64],<data>
    const commaIndex = uri.indexOf(',');
    if (commaIndex === -1) {
      throw new EvalancheError(
        'Invalid data: URI — missing comma separator',
        EvalancheErrorCode.UNSUPPORTED_URI_SCHEME,
      );
    }

    const header = uri.slice(0, commaIndex);
    const data = uri.slice(commaIndex + 1);

    if (header.includes(';base64')) {
      return Buffer.from(data, 'base64').toString('utf-8');
    }

    return decodeURIComponent(data);
  }

  /** Check if two registry addresses match (handles CAIP-10 and raw formats) */
  private _registryMatches(a: string, b: string): boolean {
    const normalize = (addr: string): string => {
      // Extract raw address from CAIP-10 format
      if (addr.startsWith('eip155:')) {
        const parts = addr.split(':');
        return (parts[2] ?? addr).toLowerCase();
      }
      return addr.toLowerCase();
    };
    return normalize(a) === normalize(b);
  }
}
