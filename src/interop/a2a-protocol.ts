/**
 * A2A protocol 1.0 wire types (JSON-RPC binding), limited to what the
 * Evalanche server and client exchange. Field names and enum strings follow
 * the ProtoJSON form of https://a2a-protocol.org/v1.0.0/specification/.
 */

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_VERSION_HEADER = 'A2A-Version';
export const A2A_AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const A2A_JSONRPC_BINDING = 'JSONRPC';

export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED';

const TERMINAL_STATES = new Set<string>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export function isA2ATerminalState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** A message part. Exactly one of `text`, `data`, `url` or `raw` is set. */
export interface A2APart {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  messageId: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
  referenceTaskIds?: string[];
  extensions?: string[];
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: A2AMessage;
  /** ISO 8601 timestamp */
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

/** `SendMessage` result: either a task or a direct message. */
export interface A2ASendMessageResult {
  task?: A2ATask;
  message?: A2AMessage;
}

export interface A2AAgentInterface {
  url: string;
  protocolBinding: string;
  protocolVersion: string;
  tenant?: string;
}

export interface A2AAgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface A2AAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: A2AAgentInterface[];
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  capabilities: { streaming?: boolean; pushNotifications?: boolean; extendedAgentCard?: boolean };
  securitySchemes?: Record<string, Record<string, unknown>>;
  securityRequirements?: Array<{ schemes: Record<string, { list: string[] }> }>;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2AAgentSkill[];
}

/** JSON-RPC and A2A error codes (spec section 9.5). */
export const A2A_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  EXTENDED_CARD_NOT_CONFIGURED: -32007,
  VERSION_NOT_SUPPORTED: -32009,
} as const;

/** True when `version` is 1.0 (`"1"` counts as `"1.0"`). An absent version means 0.3. */
export function isSupportedA2AVersion(version: string | null | undefined): boolean {
  const match = /^\s*(\d+)(?:\.(\d+))?\s*$/.exec(version ?? '');
  return !!match && Number(match[1]) === 1 && Number(match[2] ?? 0) === 0;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
