/**
 * A2A Protocol Client — Agent-to-Agent interaction following the A2A spec.
 *
 * Supports:
 * - Fetching and parsing Agent Cards from `.well-known/agent-card.json`
 * - Resolving agent cards via ERC-8004 identity
 * - Full task lifecycle: submit, poll, stream, cancel
 *
 * Usage:
 * ```ts
 * const a2a = new A2AClient();
 *
 * // Fetch an agent's card
 * const card = await a2a.fetchAgentCard('https://agent.example.com');
 *
 * // Submit a task
 * const task = await a2a.submitTask('https://agent.example.com', 'audit', 'Audit this contract: 0x...');
 *
 * // Poll for completion
 * const result = await a2a.getTask('https://agent.example.com', task.id);
 * ```
 */
import { EvalancheError, EvalancheErrorCode } from '../utils/errors';
import type { InteropIdentityResolver } from './identity';
import type {
  AgentCard,
  A2ASkill,
  A2ATask,
  A2ATaskStatus,
  A2AMessage,
  A2AArtifact,
} from './schemas';

/** Auth placement config matching A2AAuthentication from agent card */
export interface AuthPlacement {
  /** Where to send the credential */
  in?: 'header' | 'query';
  /** Header or query parameter name (defaults to 'Authorization') */
  name?: string;
}

/** Options for submitting a task */
export interface SubmitTaskOptions {
  /** Skill ID to invoke */
  skillId: string;
  /** Input text or prompt */
  input: string;
  /** Optional metadata to attach */
  metadata?: Record<string, unknown>;
  /** Auth credential value (e.g., 'Bearer xxx' or an API key) */
  auth?: string;
  /** Where to place the auth credential (from agent card authentication config) */
  authPlacement?: AuthPlacement;
}

/** Callback for streaming task updates */
export type TaskUpdateCallback = (event: {
  status: A2ATaskStatus;
  message?: A2AMessage;
  artifact?: A2AArtifact;
}) => void;

/**
 * A2AClient handles all A2A protocol interactions.
 *
 * Can optionally use an `InteropIdentityResolver` to resolve
 * agent cards from ERC-8004 identities (agentId → A2A endpoint → card).
 */
export class A2AClient {
  private readonly _identity?: InteropIdentityResolver;
  private readonly _fetchFn: typeof globalThis.fetch;

  constructor(options?: {
    identity?: InteropIdentityResolver;
    fetch?: typeof globalThis.fetch;
  }) {
    this._identity = options?.identity;
    this._fetchFn = options?.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ── Agent Card (Step 8.1) ──

  /**
   * Fetch an agent card from a base URL.
   * Looks up `{baseUrl}/.well-known/agent-card.json`.
   */
  async fetchAgentCard(baseUrl: string): Promise<AgentCard> {
    const url = baseUrl.replace(/\/+$/, '') + '/.well-known/agent-card.json';

    let response: Response;
    try {
      response = await this._fetchFn(url, {
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      throw new EvalancheError(
        `Failed to fetch agent card from ${url}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.A2A_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      throw new EvalancheError(
        `Agent card not found at ${url} (HTTP ${response.status})`,
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new EvalancheError(
        `Invalid JSON in agent card at ${url}`,
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    return this._validateAgentCard(data, url);
  }

  /**
   * Resolve an agent card from an ERC-8004 agent ID.
   * Chains: agentId → identity resolution → A2A endpoint → agent card.
   *
   * Requires an `InteropIdentityResolver` to be configured.
   */
  async resolveAgentCardFromERC8004(agentId: string): Promise<AgentCard> {
    if (!this._identity) {
      throw new EvalancheError(
        'InteropIdentityResolver required to resolve agent cards from ERC-8004 IDs',
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    const registration = await this._identity.resolveAgent(agentId);
    const a2aService = registration.services.find((s) => s.name === 'A2A');

    if (!a2aService) {
      throw new EvalancheError(
        `Agent ${agentId} has no A2A service endpoint registered`,
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    return this.fetchAgentCard(a2aService.endpoint);
  }

  /**
   * List skills from an agent card.
   * Convenience method that returns just the skills array.
   */
  listSkills(card: AgentCard): A2ASkill[] {
    return card.skills;
  }

  /**
   * Find a skill by ID or tag match.
   */
  findSkill(card: AgentCard, query: { id?: string; tag?: string }): A2ASkill | undefined {
    if (query.id) {
      return card.skills.find((s) => s.id === query.id);
    }
    if (query.tag) {
      const tag = query.tag.toLowerCase();
      return card.skills.find((s) => s.tags?.some((t) => t.toLowerCase() === tag));
    }
    return undefined;
  }

  // ── Task Lifecycle (Step 8.2) ──

  /**
   * Submit a task to an A2A agent.
   * Returns the created task with its ID and initial status.
   */
  async submitTask(baseUrl: string, options: SubmitTaskOptions): Promise<A2ATask> {
    const url = baseUrl.replace(/\/+$/, '') + '/tasks';

    const body = {
      skill_id: options.skillId,
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: options.input }],
        },
      ],
      metadata: options.metadata,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const finalUrl = this._applyAuth(url, headers, options.auth, options.authPlacement);

    let response: Response;
    try {
      response = await this._fetchFn(finalUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new EvalancheError(
        `Failed to submit A2A task to ${url}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.A2A_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new EvalancheError(
        `A2A task submission failed (HTTP ${response.status}): ${errorText}`,
        EvalancheErrorCode.A2A_TASK_FAILED,
      );
    }

    const data = await response.json() as Record<string, unknown>;
    return this._parseTask(data);
  }

  /**
   * Get the current status and artifacts of a task.
   */
  async getTask(baseUrl: string, taskId: string, auth?: string, authPlacement?: AuthPlacement): Promise<A2ATask> {
    const url = baseUrl.replace(/\/+$/, '') + `/tasks/${encodeURIComponent(taskId)}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    const finalUrl = this._applyAuth(url, headers, auth, authPlacement);

    let response: Response;
    try {
      response = await this._fetchFn(finalUrl, { headers });
    } catch (error) {
      throw new EvalancheError(
        `Failed to get A2A task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.A2A_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      throw new EvalancheError(
        `A2A task ${taskId} not found (HTTP ${response.status})`,
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    const data = await response.json() as Record<string, unknown>;
    return this._parseTask(data);
  }

  /**
   * Stream task updates via SSE.
   * Calls `onUpdate` for each status change, message, or artifact.
   * Returns an abort function to stop streaming.
   */
  async streamTask(
    baseUrl: string,
    taskId: string,
    onUpdate: TaskUpdateCallback,
    auth?: string,
    authPlacement?: AuthPlacement,
  ): Promise<{ abort: () => void }> {
    const url = baseUrl.replace(/\/+$/, '') + `/tasks/${encodeURIComponent(taskId)}/stream`;

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const finalUrl = this._applyAuth(url, headers, auth, authPlacement);

    const controller = new AbortController();

    let response: Response;
    try {
      response = await this._fetchFn(finalUrl, {
        headers,
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return { abort: () => {} };
      }
      throw new EvalancheError(
        `Failed to stream A2A task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.A2A_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok || !response.body) {
      throw new EvalancheError(
        `A2A task stream failed (HTTP ${response.status})`,
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    // Process SSE stream in background
    this._processSSEStream(response.body, onUpdate).catch(() => {
      // Stream ended or errored — silently stop
    });

    return { abort: () => controller.abort() };
  }

  /**
   * Cancel an in-progress task.
   */
  async cancelTask(baseUrl: string, taskId: string, auth?: string, authPlacement?: AuthPlacement): Promise<A2ATask> {
    const url = baseUrl.replace(/\/+$/, '') + `/tasks/${encodeURIComponent(taskId)}/cancel`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const finalUrl = this._applyAuth(url, headers, auth, authPlacement);

    let response: Response;
    try {
      response = await this._fetchFn(finalUrl, { method: 'POST', headers });
    } catch (error) {
      throw new EvalancheError(
        `Failed to cancel A2A task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        EvalancheErrorCode.A2A_ERROR,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      throw new EvalancheError(
        `A2A task cancellation failed (HTTP ${response.status})`,
        EvalancheErrorCode.A2A_TASK_FAILED,
      );
    }

    const data = await response.json() as Record<string, unknown>;
    return this._parseTask(data);
  }

  // ── Internal Helpers ──

  /** Apply auth credential to a URL and headers based on placement config */
  private _applyAuth(
    url: string,
    headers: Record<string, string>,
    auth?: string,
    placement?: AuthPlacement,
  ): string {
    if (!auth) return url;

    const location = placement?.in ?? 'header';
    const name = placement?.name ?? 'Authorization';

    if (location === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}${encodeURIComponent(name)}=${encodeURIComponent(auth)}`;
    }

    headers[name] = auth;
    return url;
  }

  /** Validate and type an agent card response */
  private _validateAgentCard(data: unknown, source: string): AgentCard {
    const card = data as Record<string, unknown>;

    if (!card || typeof card !== 'object') {
      throw new EvalancheError(`Invalid agent card from ${source}: not an object`, EvalancheErrorCode.A2A_ERROR);
    }

    if (typeof card.name !== 'string' || !card.name) {
      throw new EvalancheError(`Invalid agent card from ${source}: missing name`, EvalancheErrorCode.A2A_ERROR);
    }

    if (typeof card.url !== 'string' || !card.url) {
      throw new EvalancheError(`Invalid agent card from ${source}: missing url`, EvalancheErrorCode.A2A_ERROR);
    }

    if (!Array.isArray(card.skills)) {
      throw new EvalancheError(`Invalid agent card from ${source}: missing skills array`, EvalancheErrorCode.A2A_ERROR);
    }

    // Validate each skill has at minimum id and name
    for (const skill of card.skills) {
      const s = skill as Record<string, unknown>;
      if (typeof s.id !== 'string' || typeof s.name !== 'string') {
        throw new EvalancheError(`Invalid skill in agent card from ${source}: missing id or name`, EvalancheErrorCode.A2A_ERROR);
      }
    }

    return {
      name: card.name as string,
      description: (card.description as string) ?? '',
      url: card.url as string,
      version: card.version as string | undefined,
      provider: card.provider as AgentCard['provider'],
      authentication: card.authentication as AgentCard['authentication'],
      skills: card.skills as A2ASkill[],
      defaultInputModes: card.defaultInputModes as AgentCard['defaultInputModes'],
      defaultOutputModes: card.defaultOutputModes as AgentCard['defaultOutputModes'],
      supportsStreaming: card.supportsStreaming as boolean | undefined,
      supportsPushNotifications: card.supportsPushNotifications as boolean | undefined,
    };
  }

  /** Parse a task response into typed A2ATask */
  /** Parse and validate a task response — rejects malformed payloads instead of inventing defaults */
  private _parseTask(data: Record<string, unknown>): A2ATask {
    if (!data || typeof data !== 'object') {
      throw new EvalancheError('Invalid A2A task response: not an object', EvalancheErrorCode.A2A_ERROR);
    }

    if (typeof data.id !== 'string' || !data.id) {
      throw new EvalancheError('Invalid A2A task response: missing or empty "id"', EvalancheErrorCode.A2A_ERROR);
    }

    const validStatuses: A2ATaskStatus[] = ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'];
    if (typeof data.status !== 'string' || !validStatuses.includes(data.status as A2ATaskStatus)) {
      throw new EvalancheError(
        `Invalid A2A task response: invalid "status" "${String(data.status)}" (expected one of: ${validStatuses.join(', ')})`,
        EvalancheErrorCode.A2A_ERROR,
      );
    }

    if (data.messages !== undefined && !Array.isArray(data.messages)) {
      throw new EvalancheError('Invalid A2A task response: "messages" must be an array', EvalancheErrorCode.A2A_ERROR);
    }

    if (data.artifacts !== undefined && !Array.isArray(data.artifacts)) {
      throw new EvalancheError('Invalid A2A task response: "artifacts" must be an array', EvalancheErrorCode.A2A_ERROR);
    }

    return {
      id: data.id as string,
      status: data.status as A2ATaskStatus,
      messages: (data.messages as A2AMessage[]) ?? [],
      artifacts: (data.artifacts as A2AArtifact[]) ?? [],
      error: data.error as A2ATask['error'],
      metadata: data.metadata as Record<string, unknown> | undefined,
    };
  }

  /** Process an SSE stream body */
  private async _processSSEStream(body: ReadableStream<Uint8Array>, onUpdate: TaskUpdateCallback): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            try {
              const event = JSON.parse(jsonStr) as Record<string, unknown>;
              onUpdate({
                status: (event.status as A2ATaskStatus) ?? 'working',
                message: event.message as A2AMessage | undefined,
                artifact: event.artifact as A2AArtifact | undefined,
              });
            } catch {
              // Skip malformed SSE events
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
