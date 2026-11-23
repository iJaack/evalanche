/**
 * A2A 1.0 server (JSON-RPC binding) with verified bearer credentials,
 * a loopback default, an explicit skill allowlist and bounded resources.
 *
 * ```ts
 * const server = new A2AServer({
 *   name: 'quote-agent', description: 'Quotes swaps', version: '1.0.0',
 *   auth: { tokens: [{ token: process.env.A2A_TOKEN!, principal: 'desk', scopes: ['skill:quote'] }] },
 *   skills: [{ id: 'quote', name: 'Quote', description: 'Quote a swap', handler: ({ text }) => quote(text) }],
 * });
 * await server.listen(4100); // http://127.0.0.1:4100/a2a, card at /.well-known/agent-card.json
 * ```
 */

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { isIP, type AddressInfo } from 'net';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_TASK_TIMEOUT_MS,
  A2A_ERROR_CODES as E,
  A2A_JSONRPC_BINDING,
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  isA2ATerminalState,
  isPlainObject,
  isSupportedA2AVersion,
  type A2AAgentCard,
  type A2AMessage,
  type A2APart,
  type A2ASendMessageResult,
  type A2ATask,
  type A2ATaskState,
} from './a2a-protocol';

/** Privileged permissions. Each one is granted separately as a scope of the same name. */
export type A2APermission = 'sign' | 'spend';

export interface A2APrincipal {
  /** Caller identity. A task is visible only to the principal that created it. */
  id: string;
  /** `skill:<id>` or `skill:*` for skills, plus `sign` and `spend` for privileged skills. */
  scopes: readonly string[];
}

export interface A2AStaticCredential {
  /** At least 32 characters. Never advertised or logged. */
  token: string;
  principal: string;
  scopes: string[];
}

/** Exactly one of `tokens` (static bearer tokens) or `verify` (custom bearer verifier, e.g. JWT). */
export type A2AServerAuth =
  | { tokens: A2AStaticCredential[] }
  | { verify: (token: string) => A2APrincipal | null | undefined | Promise<A2APrincipal | null | undefined> };

export interface A2ASkillContext {
  principal: A2APrincipal;
  taskId: string;
  contextId: string;
  message: A2AMessage;
  /** Text parts joined with newlines */
  text: string;
  /** Values of the data parts, in order */
  data: unknown[];
  /** Aborted on cancel, timeout or close. Handlers must stop their work when it fires. */
  signal: AbortSignal;
}

export type A2ASkillOutput = string | { text?: string; data?: unknown } | undefined;

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  /** Callers need these scopes in addition to `skill:<id>`. Use for skills that sign or spend. */
  permissions?: A2APermission[];
  handler: (context: A2ASkillContext) => A2ASkillOutput | Promise<A2ASkillOutput>;
}

/** Throw from a handler to fail the task with this message. Other errors are reported generically. */
export class A2ASkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2ASkillError';
  }
}

export interface A2AServerLimits {
  maxBodyBytes: number;
  /** Deadline for receiving a request */
  requestTimeoutMs: number;
  /** Deadline for a task; the handler is aborted and the task fails */
  taskTimeoutMs: number;
  /** Handlers running at once, including aborted ones that have not returned */
  maxConcurrentTasks: number;
  maxRetainedTasks: number;
  /** How long finished tasks stay readable */
  taskRetentionMs: number;
  maxParts: number;
}

export interface A2AServerOptions {
  name: string;
  description: string;
  version: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  /** The only capabilities callers can run */
  skills: A2ASkill[];
  auth: A2AServerAuth;
  /** Default 127.0.0.1. Any other address needs `allowRemote` and an https `publicUrl`. */
  host?: string;
  allowRemote?: boolean;
  /** JSON-RPC endpoint advertised in the agent card. Default http://<host>:<port><path>. */
  publicUrl?: string;
  /** JSON-RPC endpoint path. Default /a2a. */
  path?: string;
  limits?: Partial<A2AServerLimits>;
}

const DEFAULT_LIMITS: A2AServerLimits = {
  maxBodyBytes: 64 * 1024,
  requestTimeoutMs: 10_000,
  taskTimeoutMs: A2A_DEFAULT_TASK_TIMEOUT_MS,
  maxConcurrentTasks: 4,
  maxRetainedTasks: 100,
  taskRetentionMs: 10 * 60_000,
  maxParts: 16,
};
const MODES = ['text/plain', 'application/json'];
const MIN_TOKEN_LENGTH = 32;
const MAX_ID_LENGTH = 256;
const MAX_LIST_ITEMS = 32;
/** Largest delay Node timers accept; longer ones fire after 1 ms. */
const MAX_LIMIT = 2_147_483_647;
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface TaskRecord {
  task: A2ATask;
  owner: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  finishedAt?: number;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

class HttpReject extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

function configError(message: string): never {
  throw new EvalancheError(`A2A server: ${message}`, EvalancheErrorCode.INVALID_CONFIG);
}

const invalid = (message: string) => new RpcError(E.INVALID_PARAMS, message);
const sha256 = (value: string) => createHash('sha256').update(value).digest();
const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

function optionalCount(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(`${name} must be a non-negative integer`);
  return value as number;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  if (Number(req.headers['content-length']) > maxBytes) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.removeAllListeners('data');
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// True when `accepted` (empty means anything) allows `mode`, counting the any-type and type-wide wildcards.
function accepts(accepted: string[], mode: string): boolean {
  return !accepted.length || accepted.some((entry) =>
    entry === mode || entry === '*/*' || (entry.endsWith('/*') && mode.startsWith(entry.slice(0, -1))));
}

/** Skill output as parts in a mode the caller accepts: JSON text for data, or a JSON string for text. */
function toParts(output: A2ASkillOutput, accepted: string[]): A2APart[] | undefined {
  const value = typeof output === 'string' ? { text: output } : output;
  const parts: A2APart[] = [];
  if (value?.text !== undefined) {
    const text = String(value.text);
    parts.push(accepts(accepted, 'text/plain') ? { text } : { data: text, mediaType: 'application/json' });
  }
  if (value?.data !== undefined) {
    parts.push(accepts(accepted, 'application/json')
      ? { data: value.data, mediaType: 'application/json' }
      : { text: JSON.stringify(value.data) });
  }
  JSON.stringify(parts);
  return parts.length ? parts : undefined;
}

export class A2AServer {
  private readonly limits: A2AServerLimits;
  private readonly skills = new Map<string, A2ASkill>();
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly credentials?: Array<{ digest: Buffer; principal: A2APrincipal }>;
  private readonly host: string;
  private readonly path: string;
  private server?: Server;
  private endpoint?: string;
  private running = 0;

  constructor(private readonly options: A2AServerOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMIT) configError(`limits.${key} must be an integer from 1 to ${MAX_LIMIT}`);
    }
    if (this.limits.maxRetainedTasks <= this.limits.maxConcurrentTasks) {
      configError('limits.maxRetainedTasks must be greater than limits.maxConcurrentTasks');
    }
    if (!options.name || !options.description || !options.version) configError('name, description and version are required');
    if (!options.skills?.length) configError('at least one skill is required');
    for (const skill of options.skills) {
      if (!SKILL_ID.test(skill.id)) configError(`invalid skill id "${skill.id}"`);
      if (this.skills.has(skill.id)) configError(`duplicate skill id "${skill.id}"`);
      if (typeof skill.handler !== 'function') configError(`skill "${skill.id}" has no handler`);
      for (const permission of skill.permissions ?? []) {
        if (permission !== 'sign' && permission !== 'spend') configError(`skill "${skill.id}" has unknown permission "${permission}"`);
      }
      this.skills.set(skill.id, skill);
    }

    const auth = options.auth as { tokens?: A2AStaticCredential[]; verify?: unknown } | undefined;
    if (!auth || (auth.tokens === undefined) === (auth.verify === undefined)) configError('auth must set exactly one of tokens or verify');
    if (auth.tokens) {
      const seen = new Set<string>();
      this.credentials = auth.tokens.map(({ token, principal, scopes }) => {
        if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) configError(`tokens must be at least ${MIN_TOKEN_LENGTH} characters`);
        if (!isId(principal)) configError('each token needs a principal');
        const digest = sha256(token);
        if (seen.has(digest.toString('hex'))) configError('duplicate token');
        seen.add(digest.toString('hex'));
        return { digest, principal: { id: principal, scopes: [...(scopes ?? [])] } };
      });
      if (!this.credentials.length) configError('auth.tokens is empty');
    } else if (typeof auth.verify !== 'function') {
      configError('auth.verify must be a function');
    }

    this.host = options.host ?? '127.0.0.1';
    if (options.publicUrl !== undefined && !URL.canParse(options.publicUrl)) configError('invalid publicUrl');
    if (!isLoopback(this.host)) {
      if (!options.allowRemote) configError(`${this.host} is not a loopback address; set allowRemote to expose the server`);
      if (!options.publicUrl?.startsWith('https://')) configError('allowRemote requires an https publicUrl; terminate TLS in front of the server');
    }
    this.path = options.path ?? '/a2a';
    if (!this.path.startsWith('/') || this.path === A2A_AGENT_CARD_PATH) configError('invalid path');
  }

  /** JSON-RPC endpoint URL, once listening */
  get url(): string | undefined {
    return this.endpoint;
  }

  listen(port = 0): Promise<Server> {
    if (this.server) return Promise.reject(new EvalancheError('A2A server is already listening', EvalancheErrorCode.INVALID_CONFIG));
    const { requestTimeoutMs } = this.limits;
    const server = createServer(
      { requestTimeout: requestTimeoutMs, connectionsCheckingInterval: 1_000 },
      (req, res) => void this.handle(req, res),
    );
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', (error) => {
        this.server = undefined;
        reject(error);
      });
      server.listen(port, this.host, () => {
        const { address, family, port: bound } = server.address() as AddressInfo;
        this.endpoint = this.options.publicUrl ?? `http://${family === 'IPv6' ? `[${address}]` : address}:${bound}${this.path}`;
        resolve(server);
      });
    });
  }

  /** Aborts running tasks and stops the listener. */
  async close(): Promise<void> {
    for (const record of this.tasks.values()) this.settle(record, 'TASK_STATE_CANCELED', 'Agent shut down');
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  getAgentCard(): A2AAgentCard {
    const { name, description, version, provider, documentationUrl, publicUrl } = this.options;
    return {
      name,
      description,
      version,
      supportedInterfaces: [{
        url: this.endpoint ?? publicUrl ?? '',
        protocolBinding: A2A_JSONRPC_BINDING,
        protocolVersion: A2A_PROTOCOL_VERSION,
      }],
      ...(provider ? { provider } : {}),
      ...(documentationUrl ? { documentationUrl } : {}),
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      defaultInputModes: MODES,
      defaultOutputModes: MODES,
      skills: [...this.skills.values()].map(({ id, name: skillName, description: skillDescription, tags, examples }) => ({
        id,
        name: skillName,
        description: skillDescription,
        tags: tags ?? [],
        ...(examples?.length ? { examples } : {}),
      })),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === A2A_AGENT_CARD_PATH) {
        if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
        return send(res, 200, this.getAgentCard(), { 'Cache-Control': 'no-store' });
      }
      if (url.pathname !== this.path) return send(res, 404, { error: 'not found' }, { Connection: 'close' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { Allow: 'POST', Connection: 'close' });

      const principal = await this.authenticate(req.headers.authorization);
      if (!principal) {
        return send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer realm="a2a"', Connection: 'close' });
      }
      const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json' && type !== 'application/a2a+json') {
        return send(res, 415, { error: 'unsupported media type' }, { Connection: 'close' });
      }
      const body = await readBody(req, this.limits.maxBodyBytes);
      if (body === null) {
        res.on('finish', () => req.destroy());
        return send(res, 413, { error: 'payload too large' }, { Connection: 'close' });
      }
      const header = req.headers[A2A_VERSION_HEADER.toLowerCase()];
      const version = typeof header === 'string' ? header : url.searchParams.get(A2A_VERSION_HEADER);
      send(res, 200, await this.dispatch(body, principal, version));
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpReject) return send(res, error.status, { error: error.message }, error.headers);
      send(res, 500, { error: 'internal error' });
    }
  }

  private async authenticate(header: string | undefined): Promise<A2APrincipal | null> {
    const token = /^Bearer +(\S+) *$/i.exec(header ?? '')?.[1];
    if (!token) return null;
    if (this.credentials) {
      const digest = sha256(token);
      let match: A2APrincipal | null = null;
      for (const credential of this.credentials) {
        if (timingSafeEqual(digest, credential.digest)) match = credential.principal;
      }
      return match;
    }
    try {
      const principal = await (this.options.auth as { verify: (token: string) => unknown }).verify(token);
      if (isPlainObject(principal) && isId(principal.id) && Array.isArray(principal.scopes)) return principal as unknown as A2APrincipal;
    } catch {
      // A failing verifier rejects the request.
    }
    return null;
  }

  private async dispatch(body: string, principal: A2APrincipal, version: string | null): Promise<unknown> {
    let request: unknown;
    try {
      request = JSON.parse(body);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: E.PARSE_ERROR, message: 'Parse error' } };
    }
    const rawId = isPlainObject(request) ? request.id : undefined;
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!isPlainObject(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || id === null) {
      return fail(E.INVALID_REQUEST, 'Invalid JSON-RPC request');
    }
    if (!isSupportedA2AVersion(version)) {
      return fail(E.VERSION_NOT_SUPPORTED, `A2A version ${version || '0.3'} is not supported; send ${A2A_VERSION_HEADER}: ${A2A_PROTOCOL_VERSION}`);
    }
    this.pruneTasks();
    try {
      const params = request.params ?? {};
      if (!isPlainObject(params)) throw invalid('params must be an object');
      let result: unknown;
      switch (request.method) {
        case 'SendMessage':
          result = await this.sendMessage(params, principal);
          break;
        case 'GetTask': {
          const historyLength = optionalCount(params.historyLength, 'historyLength');
          result = this.snapshot(this.ownedTask(params, principal), historyLength);
          break;
        }
        case 'CancelTask': {
          const record = this.ownedTask(params, principal);
          // Canceling a canceled task is idempotent; other finished tasks cannot be canceled.
          if (!this.settle(record, 'TASK_STATE_CANCELED') && record.task.status.state !== 'TASK_STATE_CANCELED') {
            throw new RpcError(E.TASK_NOT_CANCELABLE, 'Task is already in a terminal state');
          }
          result = this.snapshot(record);
          break;
        }
        case 'SendStreamingMessage':
        case 'SubscribeToTask':
        case 'ListTasks':
          throw new RpcError(E.UNSUPPORTED_OPERATION, `${request.method} is not supported by this agent`);
        case 'CreateTaskPushNotificationConfig':
        case 'GetTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfigs':
        case 'DeleteTaskPushNotificationConfig':
          throw new RpcError(E.PUSH_NOTIFICATION_NOT_SUPPORTED, 'Push notifications are not supported');
        case 'GetExtendedAgentCard':
          throw new RpcError(E.EXTENDED_CARD_NOT_CONFIGURED, 'No extended agent card is configured');
        default:
          throw new RpcError(E.METHOD_NOT_FOUND, 'Method not found');
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (error instanceof RpcError) return fail(error.code, error.message);
      if (error instanceof HttpReject) throw error;
      return fail(E.INTERNAL_ERROR, 'Internal error');
    }
  }

  private async sendMessage(params: Record<string, unknown>, principal: A2APrincipal): Promise<A2ASendMessageResult> {
    const message = this.parseMessage(params.message);
    const config = params.configuration ?? {};
    if (!isPlainObject(config)) throw invalid('configuration must be an object');
    const historyLength = optionalCount(config.historyLength, 'configuration.historyLength');
    const { returnImmediately, acceptedOutputModes: accepted } = config;
    if (returnImmediately !== undefined && typeof returnImmediately !== 'boolean') throw invalid('configuration.returnImmediately must be a boolean');
    if (accepted !== undefined) {
      if (!Array.isArray(accepted) || accepted.some((mode) => typeof mode !== 'string')) throw invalid('configuration.acceptedOutputModes must be strings');
      if (!MODES.some((mode) => accepts(accepted, mode))) {
        throw new RpcError(E.CONTENT_TYPE_NOT_SUPPORTED, `Supported output modes: ${MODES.join(', ')}`);
      }
    }
    if (params.metadata !== undefined && !isPlainObject(params.metadata)) throw invalid('metadata must be an object');
    if (message.taskId !== undefined) throw new RpcError(E.UNSUPPORTED_OPERATION, 'Continuing an existing task is not supported; omit message.taskId');

    const requestMetadata = params.metadata as Record<string, unknown> | undefined;
    const skillId = message.metadata?.skillId ?? requestMetadata?.skillId ?? (this.skills.size === 1 ? [...this.skills.keys()][0] : undefined);
    if (typeof skillId !== 'string') throw invalid('metadata.skillId is required');
    const skill = this.skills.get(skillId);
    if (!skill) throw invalid('Unknown skill');

    const granted = new Set(principal.scopes);
    const missing = [
      ...(granted.has(`skill:${skill.id}`) || granted.has('skill:*') ? [] : [`skill:${skill.id}`]),
      ...(skill.permissions ?? []).filter((permission) => !granted.has(permission)),
    ];
    if (missing.length) {
      throw new HttpReject(403, 'forbidden', { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${missing.join(' ')}"` });
    }
    if (this.running >= this.limits.maxConcurrentTasks) throw new HttpReject(429, 'too many concurrent tasks', { 'Retry-After': '1' });

    this.pruneTasks(true);
    const record = this.start(skill, message, principal, accepted ?? []);
    if (!returnImmediately) await record.done;
    return { task: this.snapshot(record, historyLength) };
  }

  private parseMessage(value: unknown): A2AMessage {
    if (!isPlainObject(value)) throw invalid('message is required');
    const { messageId, role, parts, contextId, taskId, metadata, referenceTaskIds, extensions } = value;
    if (!isId(messageId)) throw invalid('message.messageId is required');
    if (role !== 'ROLE_USER') throw invalid('message.role must be ROLE_USER');
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > this.limits.maxParts) {
      throw invalid(`message.parts must hold 1 to ${this.limits.maxParts} parts`);
    }
    if (contextId !== undefined && !isId(contextId)) throw invalid('message.contextId must be a non-empty string');
    if (taskId !== undefined && !isId(taskId)) throw invalid('message.taskId must be a non-empty string');
    if (metadata !== undefined && !isPlainObject(metadata)) throw invalid('message.metadata must be an object');
    for (const [name, list] of [['referenceTaskIds', referenceTaskIds], ['extensions', extensions]] as const) {
      if (list !== undefined && (!Array.isArray(list) || list.length > MAX_LIST_ITEMS || !list.every(isId))) {
        throw invalid(`message.${name} must be a list of up to ${MAX_LIST_ITEMS} non-empty strings`);
      }
    }
    return {
      messageId,
      role,
      parts: parts.map((part): A2APart => {
        if (!isPlainObject(part)) throw invalid('each part must be an object');
        const kinds = (['text', 'data', 'url', 'raw'] as const).filter((kind) => part[kind] !== undefined);
        if (kinds.length !== 1) throw invalid('each part must set exactly one of text, data, url or raw');
        if (kinds[0] === 'url' || kinds[0] === 'raw') throw new RpcError(E.CONTENT_TYPE_NOT_SUPPORTED, 'Only text and data parts are accepted');
        if (kinds[0] === 'text' && typeof part.text !== 'string') throw invalid('part.text must be a string');
        const { mediaType, filename, metadata: partMetadata } = part;
        if (mediaType !== undefined && typeof mediaType !== 'string') throw invalid('part.mediaType must be a string');
        if (filename !== undefined && typeof filename !== 'string') throw invalid('part.filename must be a string');
        if (partMetadata !== undefined && !isPlainObject(partMetadata)) throw invalid('part.metadata must be an object');
        return {
          ...(kinds[0] === 'text' ? { text: part.text as string } : { data: part.data }),
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(filename !== undefined ? { filename } : {}),
          ...(partMetadata !== undefined ? { metadata: partMetadata } : {}),
        };
      }),
      ...(contextId !== undefined ? { contextId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(referenceTaskIds !== undefined ? { referenceTaskIds: referenceTaskIds as string[] } : {}),
      ...(extensions !== undefined ? { extensions: extensions as string[] } : {}),
    };
  }

  private start(skill: A2ASkill, message: A2AMessage, principal: A2APrincipal, accepted: string[]): TaskRecord {
    const id = randomUUID();
    const contextId = message.contextId ?? randomUUID();
    const input: A2AMessage = { ...message, taskId: id, contextId };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const record: TaskRecord = {
      task: { id, contextId, status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() }, history: [input] },
      owner: principal.id,
      controller: new AbortController(),
      done,
      finish,
    };
    this.tasks.set(id, record);
    this.running++;
    const timer = setTimeout(() => this.settle(record, 'TASK_STATE_FAILED', 'Task timed out'), this.limits.taskTimeoutMs);
    timer.unref();
    const text = message.parts.filter((part) => part.text !== undefined).map((part) => part.text).join('\n');
    const data = message.parts.filter((part) => part.text === undefined).map((part) => part.data);
    Promise.resolve()
      .then(() => skill.handler({ principal, taskId: id, contextId, message: input, text, data, signal: record.controller.signal }))
      .then((output) => toParts(output, accepted))
      .then(
        (parts) => this.settle(record, 'TASK_STATE_COMPLETED', undefined, parts),
        (error) => this.settle(record, 'TASK_STATE_FAILED', error instanceof A2ASkillError ? error.message : 'Skill execution failed'),
      )
      .finally(() => {
        clearTimeout(timer);
        this.running--;
      });
    return record;
  }

  /** Moves a task to a terminal state once. Anything but completion aborts the handler. */
  private settle(record: TaskRecord, state: A2ATaskState, text?: string, parts?: A2APart[]): boolean {
    const { task } = record;
    if (isA2ATerminalState(task.status.state)) return false;
    if (state !== 'TASK_STATE_COMPLETED') record.controller.abort(new Error(text ?? 'Task canceled'));
    task.status = {
      state,
      timestamp: new Date().toISOString(),
      ...(text ? {
        message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }], taskId: task.id, contextId: task.contextId },
      } : {}),
    };
    if (parts) task.artifacts = [{ artifactId: randomUUID(), name: 'result', parts }];
    record.finishedAt = Date.now();
    record.finish();
    return true;
  }

  private ownedTask(params: Record<string, unknown>, principal: A2APrincipal): TaskRecord {
    if (!isId(params.id)) throw invalid('id is required');
    const record = this.tasks.get(params.id);
    if (!record || record.owner !== principal.id) throw new RpcError(E.TASK_NOT_FOUND, 'Task not found');
    return record;
  }

  private snapshot({ task }: TaskRecord, historyLength?: number): A2ATask {
    const { history = [], ...rest } = task;
    const kept = historyLength === undefined ? history : history.slice(history.length - Math.min(historyLength, history.length));
    return { ...rest, ...(kept.length ? { history: kept } : {}) };
  }

  /** Drops expired finished tasks. With `makeRoom`, also the oldest finished ones while the store is full. */
  private pruneTasks(makeRoom = false): void {
    const cutoff = Date.now() - this.limits.taskRetentionMs;
    for (const [id, record] of this.tasks) {
      if (record.finishedAt !== undefined && record.finishedAt < cutoff) this.tasks.delete(id);
    }
    for (const [id, record] of this.tasks) {
      if (!makeRoom || this.tasks.size < this.limits.maxRetainedTasks) break;
      if (record.finishedAt !== undefined) this.tasks.delete(id);
    }
  }
}
