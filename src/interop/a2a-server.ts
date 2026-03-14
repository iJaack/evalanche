/**
 * A2A Server — Wrap evalanche capabilities as an A2A-compliant agent.
 *
 * Generates `agent-card.json` from registered skills,
 * serves `/.well-known/agent-card.json`, and routes incoming
 * A2A task requests to registered handlers.
 *
 * Usage:
 * ```ts
 * const server = new A2AServer({ name: 'MyAgent', url: 'https://my-agent.com' });
 *
 * server.registerSkill({
 *   id: 'audit',
 *   name: 'Smart Contract Audit',
 *   description: 'Security audit for Solidity contracts',
 *   handler: async (input) => ({ text: 'Audit complete. No vulnerabilities found.' }),
 * });
 *
 * const httpServer = server.listen(3000);
 * ```
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type {
  AgentCard,
  A2ASkill,
  A2ATask,
  A2AMessage,
  A2AArtifact,
  A2AAuthentication,
} from './schemas';

/** Handler function for an A2A skill */
export type SkillHandler = (input: string, metadata?: Record<string, unknown>) => Promise<SkillResult>;

/** Result from a skill handler */
export interface SkillResult {
  /** Text output */
  text?: string;
  /** Binary artifact */
  data?: { name: string; mimeType: string; content: string };
  /** External URI to result */
  uri?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Skill registration with handler */
export interface RegisteredSkill extends A2ASkill {
  /** The function that handles this skill */
  handler: SkillHandler;
}

/** Options for creating an A2A server */
export interface A2AServerOptions {
  /** Agent display name */
  name: string;
  /** Base URL where this agent is hosted */
  url: string;
  /** Agent description */
  description?: string;
  /** Agent version */
  version?: string;
  /** Provider info */
  provider?: { name: string; url?: string };
  /** Authentication config */
  authentication?: A2AAuthentication;
}

/**
 * A2AServer wraps evalanche agent capabilities as an A2A-compliant endpoint.
 */
export class A2AServer {
  private readonly _options: A2AServerOptions;
  private readonly _skills: Map<string, RegisteredSkill> = new Map();
  private readonly _tasks: Map<string, A2ATask> = new Map();
  private _server: Server | null = null;

  constructor(options: A2AServerOptions) {
    this._options = options;
  }

  /**
   * Register a skill that this agent can perform.
   */
  registerSkill(skill: Omit<A2ASkill, 'id'> & { id?: string; handler: SkillHandler }): string {
    const id = skill.id ?? `skill_${randomBytes(4).toString('hex')}`;

    this._skills.set(id, {
      id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      inputModes: skill.inputModes,
      outputModes: skill.outputModes,
      examples: skill.examples,
      handler: skill.handler,
    });

    return id;
  }

  /**
   * Remove a registered skill.
   */
  unregisterSkill(skillId: string): boolean {
    return this._skills.delete(skillId);
  }

  /**
   * Generate the agent card for this server.
   */
  getAgentCard(): AgentCard {
    const skills: A2ASkill[] = Array.from(this._skills.values()).map(
      ({ handler: _, ...skill }) => skill,
    );

    return {
      name: this._options.name,
      description: this._options.description ?? '',
      url: this._options.url,
      version: this._options.version,
      provider: this._options.provider,
      authentication: this._options.authentication,
      skills,
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      // Streaming not implemented — always advertise false to avoid misleading clients
      supportsStreaming: false,
    };
  }

  /**
   * Start an HTTP server that serves the A2A protocol.
   * Returns a promise that resolves with the Server once it's listening,
   * or rejects on startup errors (EADDRINUSE, EACCES, etc.).
   */
  listen(port: number): Promise<Server> {
    this._server = createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          const isValidationError = err instanceof EvalancheError &&
            err.code === EvalancheErrorCode.A2A_ERROR;
          const status = isValidationError ? 400 : 500;
          const message = isValidationError
            ? (err as Error).message
            : 'Internal server error';
          res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message }));
        }
      });
    });

    return new Promise<Server>((resolve, reject) => {
      this._server!.once('error', (err) => {
        reject(new EvalancheError(
          `A2A server failed to start: ${err.message}`,
          EvalancheErrorCode.A2A_ERROR,
          err,
        ));
      });
      this._server!.listen(port, () => resolve(this._server!));
    });
  }

  /**
   * Stop the server.
   */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /** Get a task by ID (for testing/inspection) */
  getTask(taskId: string): A2ATask | undefined {
    return this._tasks.get(taskId);
  }

  // ── HTTP Request Routing ──

  private async _handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse pathname to strip query strings (e.g. /tasks?api_key=... → /tasks)
    const rawUrl = req.url ?? '/';
    const url = rawUrl.split('?')[0];
    const method = req.method ?? 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    const cors = { 'Access-Control-Allow-Origin': '*' };

    // Agent card endpoint
    if (url === '/.well-known/agent-card.json' && method === 'GET') {
      const card = this.getAgentCard();
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(card));
      return;
    }

    // Enforce authentication on task endpoints if configured
    if (this._options.authentication && url.startsWith('/tasks')) {
      if (!this._checkAuth(req)) {
        res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return;
      }
    }

    // Submit task
    if (url === '/tasks' && method === 'POST') {
      const body = await this._parseBody(req);
      const task = await this._handleSubmitTask(body);
      res.writeHead(201, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // Get task
    const taskMatch = url.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch && method === 'GET') {
      const task = this._tasks.get(taskMatch[1]);
      if (!task) {
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // Cancel task
    const cancelMatch = url.match(/^\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      const task = this._tasks.get(cancelMatch[1]);
      if (!task) {
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found' }));
        return;
      }
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Cannot cancel task in '${task.status}' state` }));
        return;
      }
      task.status = 'canceled';
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
      return;
    }

    // 404
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /** Handle task submission: validate, create task, execute handler */
  private async _handleSubmitTask(body: Record<string, unknown>): Promise<A2ATask> {
    const skillId = body.skill_id as string;
    if (!skillId) {
      throw new EvalancheError('Missing skill_id in task submission', EvalancheErrorCode.A2A_ERROR);
    }

    const skill = this._skills.get(skillId);
    if (!skill) {
      throw new EvalancheError(`Unknown skill: ${skillId}`, EvalancheErrorCode.A2A_ERROR);
    }

    // Extract input from messages
    const messages = body.messages as A2AMessage[] | undefined;
    let input = '';
    if (messages && messages.length > 0) {
      const firstMsg = messages[0];
      if (firstMsg.parts && firstMsg.parts.length > 0) {
        const textPart = firstMsg.parts.find((p) => p.type === 'text');
        if (textPart && 'text' in textPart) {
          input = textPart.text;
        }
      }
    }

    const taskId = `task_${randomBytes(8).toString('hex')}`;
    const task: A2ATask = {
      id: taskId,
      status: 'submitted',
      messages: messages ?? [],
      artifacts: [],
      metadata: body.metadata as Record<string, unknown> | undefined,
    };
    this._tasks.set(taskId, task);

    // Execute handler asynchronously
    task.status = 'working';
    this._executeSkill(task, skill, input).catch(() => {
      // Error already handled inside _executeSkill
    });

    return task;
  }

  /** Execute a skill handler and update task state */
  private async _executeSkill(task: A2ATask, skill: RegisteredSkill, input: string): Promise<void> {
    try {
      const result = await skill.handler(input, task.metadata);

      const artifacts: A2AArtifact[] = [];
      if (result.text) {
        artifacts.push({ name: 'response', mimeType: 'text/plain', text: result.text });
      }
      if (result.data) {
        artifacts.push({ name: result.data.name, mimeType: result.data.mimeType, data: result.data.content });
      }
      if (result.uri) {
        artifacts.push({ name: 'result', uri: result.uri });
      }

      // Don't overwrite terminal states (e.g. task was canceled while handler ran)
      if (task.status === 'canceled' || task.status === 'failed') return;

      task.artifacts = artifacts;
      task.messages.push({
        role: 'agent',
        parts: [{ type: 'text', text: result.text ?? 'Task completed' }],
      });
      task.status = 'completed';
    } catch (error) {
      if (task.status === 'canceled') return;
      task.status = 'failed';
      task.error = {
        code: 'HANDLER_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Check request credentials against configured authentication */
  private _checkAuth(req: IncomingMessage): boolean {
    const auth = this._options.authentication;
    if (!auth) return true;

    const location = auth.in ?? 'header';
    const paramName = auth.name ?? 'Authorization';

    if (location === 'header') {
      const value = req.headers[paramName.toLowerCase()];
      return typeof value === 'string' && value.length > 0;
    }

    if (location === 'query') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      return url.searchParams.has(paramName);
    }

    return false;
  }

  /** Parse JSON body from request */
  private _parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          reject(new EvalancheError('Invalid JSON body', EvalancheErrorCode.A2A_ERROR));
        }
      });
      req.on('error', reject);
    });
  }
}
