/**
 * A2A 1.0 client (JSON-RPC binding). Reads the agent card, selects its
 * JSONRPC 1.0 interface and calls SendMessage, GetTask and CancelTask.
 *
 * ```ts
 * const agent = new A2AClient({ url: 'https://agent.example', token: process.env.AGENT_TOKEN });
 * const { task } = await agent.sendMessage({ text: 'quote 1 AVAX to USDC', skillId: 'quote' });
 * ```
 */

import { randomUUID } from 'crypto';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import { assertSafeUrl, safeFetch, type SafeFetchOptions } from '../utils/safe-fetch';
import {
  A2A_AGENT_CARD_PATH,
  A2A_ERROR_CODES,
  A2A_JSONRPC_BINDING,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  isPlainObject,
  isSupportedA2AVersion,
  type A2AAgentCard,
  type A2AMessage,
  type A2APart,
  type A2ASendMessageResult,
  type A2ATask,
} from './a2a-protocol';

/** An A2A call failed. `rpcCode` is the JSON-RPC error code, `httpStatus` the HTTP status. */
export class A2AError extends EvalancheError {
  constructor(message: string, readonly rpcCode?: number, readonly httpStatus?: number) {
    super(message, EvalancheErrorCode.A2A_ERROR);
    this.name = 'A2AError';
  }
}

export interface A2AClientOptions {
  /** Agent base URL (card read from /.well-known/agent-card.json) or the card URL itself */
  url: string;
  /** Bearer token. Sent only to the agent card's own origin. */
  token?: string;
  /** Default 30 seconds per request */
  timeoutMs?: number;
  /** Default 1 MB per response */
  maxResponseBytes?: number;
  /** Allow plain http. By default only loopback hosts may use http. */
  allowHttp?: boolean;
  /** Refuse private and loopback hosts. Set it when the URL comes from untrusted input. */
  blockPrivateNetwork?: boolean;
}

export interface A2ASendMessageInput {
  text?: string;
  data?: unknown;
  /** Skill to run; sent as `message.metadata.skillId` */
  skillId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  /** Return once the task exists instead of waiting for it to finish */
  returnImmediately?: boolean;
  historyLength?: number;
}

const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);

function isTask(value: unknown): value is A2ATask {
  return isPlainObject(value) && typeof value.id === 'string' && isPlainObject(value.status) && typeof value.status.state === 'string';
}

export class A2AClient {
  private readonly cardUrl: URL;
  private card?: A2AAgentCard;
  private endpoint?: URL;
  private nextId = 1;

  constructor(private readonly options: A2AClientOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new EvalancheError('A2A client: invalid url', EvalancheErrorCode.INVALID_PARAMS);
    }
    this.cardUrl = url.pathname.endsWith('/agent-card.json') ? url : new URL(A2A_AGENT_CARD_PATH, url);
    assertSafeUrl(this.cardUrl, this.policy(this.cardUrl));
  }

  /** Fetches and caches the agent card. */
  async getAgentCard(): Promise<A2AAgentCard> {
    if (this.card) return this.card;
    const response = await safeFetch(this.cardUrl, {
      ...this.policy(this.cardUrl),
      headers: { Accept: 'application/json', [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION },
    });
    if (!response.ok) throw new A2AError(`Agent card request failed: HTTP ${response.status}`, undefined, response.status);
    const card = await this.readJson(response);
    if (!isPlainObject(card) || typeof card.name !== 'string' || !Array.isArray(card.supportedInterfaces)) {
      throw new A2AError('Invalid agent card');
    }
    const binding = card.supportedInterfaces.find((entry) => isPlainObject(entry)
      && entry.protocolBinding === A2A_JSONRPC_BINDING
      && typeof entry.url === 'string'
      && isSupportedA2AVersion(String(entry.protocolVersion))) as { url: string } | undefined;
    if (!binding) throw new A2AError(`Agent does not offer the A2A ${A2A_PROTOCOL_VERSION} JSON-RPC binding`);
    const endpoint = new URL(binding.url, this.cardUrl);
    assertSafeUrl(endpoint, this.policy(endpoint));
    if (this.options.token && endpoint.origin !== this.cardUrl.origin) {
      throw new A2AError('Agent endpoint is on another origin than its card; refusing to send the token there');
    }
    this.endpoint = endpoint;
    this.card = card as unknown as A2AAgentCard;
    return this.card;
  }

  /** Sends a message. By default waits until the task finishes. */
  async sendMessage(input: A2ASendMessageInput): Promise<A2ASendMessageResult> {
    const parts: A2APart[] = [];
    if (input.text !== undefined) parts.push({ text: input.text });
    if (input.data !== undefined) parts.push({ data: input.data });
    if (!parts.length) throw new EvalancheError('A2A sendMessage needs text or data', EvalancheErrorCode.INVALID_PARAMS);
    const metadata = { ...input.metadata, ...(input.skillId ? { skillId: input.skillId } : {}) };
    const message: A2AMessage = {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts,
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    const configuration = {
      ...(input.returnImmediately ? { returnImmediately: true } : {}),
      ...(input.historyLength !== undefined ? { historyLength: input.historyLength } : {}),
    };
    const result = await this.call('SendMessage', { message, ...(Object.keys(configuration).length ? { configuration } : {}) });
    if (isPlainObject(result) && (isTask(result.task) || isPlainObject(result.message))) return result as A2ASendMessageResult;
    throw new A2AError('Invalid SendMessage response', A2A_ERROR_CODES.INVALID_AGENT_RESPONSE);
  }

  async getTask(id: string, historyLength?: number): Promise<A2ATask> {
    return this.expectTask('GetTask', await this.call('GetTask', { id, ...(historyLength !== undefined ? { historyLength } : {}) }));
  }

  async cancelTask(id: string): Promise<A2ATask> {
    return this.expectTask('CancelTask', await this.call('CancelTask', { id }));
  }

  private policy(url: URL): SafeFetchOptions {
    return {
      timeoutMs: this.options.timeoutMs ?? 30_000,
      maxBytes: this.options.maxResponseBytes ?? 1_000_000,
      allowHttp: this.options.allowHttp ?? isLoopbackHost(url.hostname),
      blockPrivateNetwork: this.options.blockPrivateNetwork ?? false,
    };
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private expectTask(method: string, result: unknown): A2ATask {
    if (isTask(result)) return result;
    throw new A2AError(`Invalid ${method} response`, A2A_ERROR_CODES.INVALID_AGENT_RESPONSE);
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.getAgentCard();
    const endpoint = this.endpoint!;
    const id = this.nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const response = await safeFetch(endpoint, {
      ...this.policy(endpoint),
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body = await this.readJson(response);
    if (isPlainObject(body) && isPlainObject(body.error)) {
      const { code, message } = body.error;
      throw new A2AError(
        `A2A ${method} failed (${String(code)}): ${String(message ?? '').slice(0, 200)}`,
        typeof code === 'number' ? code : undefined,
        response.status,
      );
    }
    if (!response.ok) throw new A2AError(`A2A ${method} failed: HTTP ${response.status}`, undefined, response.status);
    if (!isPlainObject(body) || body.jsonrpc !== '2.0' || body.id !== id || !('result' in body)) {
      throw new A2AError(`Invalid ${method} response`, A2A_ERROR_CODES.INVALID_AGENT_RESPONSE);
    }
    return body.result;
  }
}
