import { Contract, JsonRpcProvider } from 'ethers';
import { IDENTITY_ABI, IDENTITY_REGISTRY } from '../identity/constants';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { safeFetch } from '../utils/safe-fetch';
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
const REGISTRATION_MAX_BYTES = 512_000;

export class InteropIdentityResolver {
  private readonly _provider: JsonRpcProvider;
  private readonly _defaultRegistry: string;

  constructor(provider: JsonRpcProvider, defaultRegistry?: string) {
    this._provider = provider;
    this._defaultRegistry = defaultRegistry ?? IDENTITY_REGISTRY;
  }

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

  async getServiceEndpoints(agentId: number | string, agentRegistry?: string): Promise<AgentServiceEntry[]> {
    const registration = await this.resolveAgent(agentId, agentRegistry);
    return registration.services;
  }

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
      if (endpoint) return { transport, endpoint };
    }

    if (services.length > 0) {
      return { transport: services[0].name, endpoint: services[0].endpoint };
    }

    return null;
  }

  async resolveAgentWallet(agentId: number | string, agentRegistry?: string): Promise<string> {
    const registry = agentRegistry ?? this._defaultRegistry;

    try {
      const contract = new Contract(registry, METADATA_ABI, this._provider);
      const wallet = await contract.getFunction('metadata')(BigInt(agentId), 'agentWallet') as string;
      if (wallet && wallet !== '') return wallet;
    } catch {
      // metadata function may not exist; fall through to registration file
    }

    const registration = await this.resolveAgent(agentId, agentRegistry);
    if (!registration.agentWallet) {
      throw new EvalancheError(
        `No wallet found for agent ${agentId}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
      );
    }
    return registration.agentWallet;
  }

  async verifyEndpointBinding(
    agentId: number | string,
    endpoint: string,
    agentRegistry?: string,
  ): Promise<EndpointVerification> {
    const registry = agentRegistry ?? this._defaultRegistry;

    let domain: string;
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') {
        return { verified: false, reason: 'Endpoint must use HTTPS' };
      }
      domain = url.hostname;
    } catch {
      return { verified: false, reason: 'Invalid endpoint URL' };
    }

    const wellKnownUrl = `https://${domain}/.well-known/agent-registration.json`;

    try {
      const res = await safeFetch(wellKnownUrl, {
        timeoutMs: 8_000,
        maxBytes: REGISTRATION_MAX_BYTES,
        blockPrivateNetwork: true,
      });
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

      return match
        ? { verified: true }
        : { verified: false, reason: 'No matching registration found for this agent and registry' };
    } catch (error) {
      return {
        verified: false,
        reason: `Failed to fetch well-known file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async resolveByWallet(address: string, agentRegistry?: string): Promise<string | null> {
    const registry = agentRegistry ?? this._defaultRegistry;
    const contract = new Contract(registry, REGISTRY_ABI, this._provider);

    try {
      const filter = contract.filters.Transfer(null, address);
      const events = await contract.queryFilter(filter);
      if (events.length === 0) return null;

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

  private async _fetchRegistration(uri: string, expectedAgentId: string): Promise<AgentRegistration> {
    let raw: string;

    if (uri.startsWith('data:')) {
      raw = this._decodeDataUri(uri);
    } else if (uri.startsWith('ipfs://')) {
      const cidPath = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
      raw = await this._fetchHttp(`${IPFS_GATEWAY}${cidPath}`);
    } else if (uri.startsWith('https://')) {
      raw = await this._fetchHttp(uri);
    } else if (uri.startsWith('http://')) {
      throw new EvalancheError(
        'Plain HTTP agent registration URIs are not allowed',
        EvalancheErrorCode.UNSUPPORTED_URI_SCHEME,
      );
    } else {
      throw new EvalancheError(
        `Unsupported URI scheme in ${uri}`,
        EvalancheErrorCode.UNSUPPORTED_URI_SCHEME,
      );
    }

    let parsed: AgentRegistration;
    try {
      parsed = JSON.parse(raw) as AgentRegistration;
    } catch (error) {
      throw new EvalancheError(
        `Failed to parse registration JSON for agent ${expectedAgentId}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new EvalancheError(
        `Invalid registration payload for agent ${expectedAgentId}`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_ERROR,
      );
    }

    parsed.services = Array.isArray(parsed.services) ? parsed.services : [];
    parsed.registrations = Array.isArray(parsed.registrations) ? parsed.registrations : [];
    parsed.active = parsed.active !== false;

    return parsed;
  }

  private async _fetchHttp(url: string): Promise<string> {
    const res = await safeFetch(url, {
      timeoutMs: 8_000,
      maxBytes: REGISTRATION_MAX_BYTES,
      blockPrivateNetwork: true,
    });

    if (!res.ok) {
      throw new EvalancheError(
        `HTTP ${res.status} while fetching registration`,
        EvalancheErrorCode.IDENTITY_RESOLUTION_FAILED,
      );
    }

    return await res.text();
  }

  private _decodeDataUri(uri: string): string {
    const commaIndex = uri.indexOf(',');
    if (commaIndex === -1) {
      throw new EvalancheError(
        'Invalid data: URI — missing comma separator',
        EvalancheErrorCode.UNSUPPORTED_URI_SCHEME,
      );
    }

    const meta = uri.slice(5, commaIndex);
    const data = uri.slice(commaIndex + 1);
    const isBase64 = meta.includes(';base64');

    try {
      return isBase64
        ? Buffer.from(data, 'base64').toString('utf8')
        : decodeURIComponent(data);
    } catch (error) {
      throw new EvalancheError(
        'Failed to decode data: URI',
        EvalancheErrorCode.IDENTITY_RESOLUTION_FAILED,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private _registryMatches(candidate: string, expected: string): boolean {
    const a = candidate.toLowerCase();
    const b = expected.toLowerCase();
    return a === b || a.endsWith(`:${b}`);
  }
}
