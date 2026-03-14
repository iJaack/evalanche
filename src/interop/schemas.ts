/**
 * Shared interop types for ERC-8004 identity resolution and
 * cross-protocol agent interoperability.
 */

/** Transport protocols supported by agent services */
export type TransportType = 'A2A' | 'XMTP' | 'MCP' | 'web' | 'ENS' | 'DID' | 'email';

/** Trust verification modes */
export type TrustMode = 'reputation' | 'crypto-economic' | 'tee-attestation';

/** A service endpoint advertised in an agent registration file */
export interface AgentServiceEntry {
  /** Service transport type */
  name: TransportType;
  /** URL or address for the service */
  endpoint: string;
  /** Optional version string */
  version?: string;
}

/** On-chain registration binding from the well-known file */
export interface RegistrationBinding {
  /** Agent registry contract address (CAIP-10 or raw 0x) */
  agentRegistry: string;
  /** Agent token ID */
  agentId: string;
}

/** Full ERC-8004 agent registration file shape */
export interface AgentRegistration {
  /** Agent display name */
  name: string;
  /** Short description of the agent */
  description: string;
  /** Agent wallet address for payments */
  agentWallet: string;
  /** Whether the agent is currently active */
  active: boolean;
  /** Service endpoints this agent exposes */
  services: AgentServiceEntry[];
  /** x402 payment support */
  x402Support?: boolean;
  /** Trust modes the agent supports */
  supportedTrust?: TrustMode[];
  /** Domain-registry bindings for endpoint verification */
  registrations?: RegistrationBinding[];
}

/** Typed map of service endpoints keyed by transport type */
export type ServiceEndpoints = Partial<Record<TransportType, string>>;

/** Result of verifying an endpoint domain binding */
export interface EndpointVerification {
  /** Whether the endpoint is verified */
  verified: boolean;
  /** Reason for failure, if not verified */
  reason?: string;
}

// ── A2A Protocol Types (v0.3+) ──

/** Supported input/output modalities for an A2A skill */
export type A2AModality = 'text' | 'image' | 'audio' | 'video' | 'file';

/** Authentication schemes supported by an A2A agent */
export interface A2AAuthentication {
  /** Auth scheme type (e.g., 'bearer', 'apiKey', 'x402') */
  type: string;
  /** Where to place the credential */
  in?: 'header' | 'query';
  /** Header or query parameter name */
  name?: string;
}

/** A single skill advertised in an A2A agent card */
export interface A2ASkill {
  /** Unique skill identifier */
  id: string;
  /** Human-readable skill name */
  name: string;
  /** Description of what this skill does */
  description: string;
  /** Tags for categorization/search */
  tags?: string[];
  /** Input modalities accepted */
  inputModes?: A2AModality[];
  /** Output modalities produced */
  outputModes?: A2AModality[];
  /** Example prompts or inputs */
  examples?: string[];
}

/** A2A Agent Card — the identity card for an A2A-compliant agent */
export interface AgentCard {
  /** Agent display name */
  name: string;
  /** Agent description */
  description: string;
  /** Base URL of the agent's A2A endpoint */
  url: string;
  /** Agent version */
  version?: string;
  /** Provider/organization info */
  provider?: { name: string; url?: string };
  /** Authentication requirements */
  authentication?: A2AAuthentication;
  /** Skills this agent offers */
  skills: A2ASkill[];
  /** Default input modality */
  defaultInputModes?: A2AModality[];
  /** Default output modality */
  defaultOutputModes?: A2AModality[];
  /** Whether this agent supports streaming */
  supportsStreaming?: boolean;
  /** Whether this agent supports push notifications */
  supportsPushNotifications?: boolean;
}

/** A2A task status lifecycle */
export type A2ATaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/** An artifact produced by a task */
export interface A2AArtifact {
  /** Artifact name */
  name?: string;
  /** MIME type of the artifact */
  mimeType?: string;
  /** Text content (for text artifacts) */
  text?: string;
  /** Base64 data (for binary artifacts) */
  data?: string;
  /** CID or URL for externally stored artifacts */
  uri?: string;
}

/** A message in a task conversation */
export interface A2AMessage {
  /** Role: user (requester) or agent (worker) */
  role: 'user' | 'agent';
  /** Message parts */
  parts: Array<{ type: 'text'; text: string } | { type: 'file'; mimeType: string; data: string }>;
}

/** Full A2A task object */
export interface A2ATask {
  /** Unique task ID */
  id: string;
  /** Current status */
  status: A2ATaskStatus;
  /** Conversation history */
  messages: A2AMessage[];
  /** Artifacts produced */
  artifacts: A2AArtifact[];
  /** Error info if failed */
  error?: { code: string; message: string };
  /** Metadata */
  metadata?: Record<string, unknown>;
}
