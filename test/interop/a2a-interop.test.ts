/**
 * Interoperability with the official A2A JavaScript SDK (@a2a-js/sdk, protocol 1.0),
 * an implementation independent of this package, in both directions.
 */
import { randomUUID } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentCard, Message, Task, TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { A2AClient, A2AError } from '../../src/interop/a2a-client';
import { A2AServer, type A2ASkill } from '../../src/interop/a2a-server';
import { A2A_DEFAULT_TASK_TIMEOUT_MS, A2A_ERROR_CODES as E } from '../../src/interop/a2a-protocol';

const TOKEN = 'interop-token-0123456789abcdef0123456789abcdef';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

let aborted = false;
const skills: A2ASkill[] = [
  { id: 'echo', name: 'Echo', description: 'Echoes text', tags: ['test'], handler: ({ text }) => `echo: ${text}` },
  {
    id: 'slow',
    name: 'Slow',
    description: 'Runs until aborted',
    tags: ['test'],
    handler: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      });
    }),
  },
];

async function startEvalanche(): Promise<A2AServer> {
  aborted = false;
  const server = new A2AServer({
    name: 'evalanche-agent',
    description: 'Evalanche test agent',
    version: '1.0.0',
    auth: { tokens: [{ token: TOKEN, principal: 'sdk-client', scopes: ['skill:*'] }] },
    skills,
  });
  await server.listen(0);
  closers.push(() => server.close());
  return server;
}

const sdkMessage = (text: string, skillId: string) =>
  Message.fromJSON({ messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], metadata: { skillId } });

describe('official @a2a-js/sdk client -> Evalanche A2AServer', () => {
  const auth = { serviceParameters: { Authorization: `Bearer ${TOKEN}` } };

  it('discovers the card and runs submit, get and cancel', async () => {
    const server = await startEvalanche();
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] })
      .createFromUrl(new URL(server.url!).origin);

    const sent = await client.sendMessage({ tenant: '', message: sdkMessage('hello', 'echo') }, auth);
    expect('messageId' in sent).toBe(false);
    const task = Task.toJSON(sent as Task) as Record<string, any>;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts[0].parts).toEqual([{ text: 'echo: hello' }]);

    const got = Task.toJSON(await client.getTask({ tenant: '', id: task.id }, auth)) as Record<string, any>;
    expect(got.id).toBe(task.id);
    expect(got.status.state).toBe('TASK_STATE_COMPLETED');

    const running = await client.sendMessage({
      tenant: '',
      message: sdkMessage('wait', 'slow'),
      configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true, historyLength: undefined, taskPushNotificationConfig: undefined },
    }, auth);
    expect((running as Task).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    const canceled = await client.cancelTask({ tenant: '', id: (running as Task).id, metadata: undefined }, auth);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(aborted).toBe(true);
  });

  it('is refused without valid credentials and gets standard task errors', async () => {
    const server = await startEvalanche();
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory()] })
      .createFromUrl(new URL(server.url!).origin);
    await expect(client.sendMessage({ tenant: '', message: sdkMessage('x', 'echo') })).rejects.toThrow(/401/);
    await expect(client.sendMessage(
      { tenant: '', message: sdkMessage('x', 'echo') },
      { serviceParameters: { Authorization: 'Bearer INVALID-CREDENTIAL' } },
    )).rejects.toThrow(/401/);
    await expect(client.getTask({ tenant: '', id: 'missing' }, auth)).rejects.toMatchObject({ name: 'TaskNotFoundError' });
  });
});

/** The official SDK server, mounted on node:http without Express. */
async function startSdkServer(): Promise<{ url: string; requests: Array<Record<string, string | undefined>> }> {
  const contexts = new Map<string, string>();
  const executor: AgentExecutor = {
    async execute(context, bus) {
      const text = context.userMessage.parts.map((part) => (part.content?.$case === 'text' ? part.content.value : '')).join('');
      contexts.set(context.taskId, context.contextId);
      const done = text !== 'wait';
      bus.publish({
        kind: 'task',
        data: Task.fromJSON({
          id: context.taskId,
          contextId: context.contextId,
          status: { state: done ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
          artifacts: done ? [{ artifactId: 'a1', name: 'result', parts: [{ text: `sdk echo: ${text}` }] }] : [],
          history: [Message.toJSON(context.userMessage)],
        }),
      });
      if (done) bus.finished();
    },
    async cancelTask(taskId, bus) {
      bus.publish({
        kind: 'statusUpdate',
        data: {
          taskId,
          contextId: contexts.get(taskId) ?? '',
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
          metadata: undefined,
        },
      });
      bus.finished();
    },
  };
  const requests: Array<Record<string, string | undefined>> = [];
  let url = '';
  const card = () => AgentCard.fromJSON({
    name: 'sdk-agent',
    description: 'Official SDK agent',
    version: '1.0.0',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'echo', name: 'Echo', description: 'Echoes text', tags: ['test'] }],
  });
  const http: Server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(AgentCard.toJSON(card())));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ authorization: req.headers.authorization, version: req.headers['a2a-version'] as string | undefined });
    const response = await handler.handle(body, new ServerCallContext({ requestedVersion: req.headers['a2a-version'] as string }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/rpc`;
  const handler = new JsonRpcTransportHandler(new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor));
  closers.push(() => new Promise((resolve) => { http.close(() => resolve()); http.closeAllConnections(); }));
  return { url, requests };
}

describe('Evalanche A2AClient -> official @a2a-js/sdk server', () => {
  it('runs submit, get and cancel against the SDK server', async () => {
    const sdk = await startSdkServer();
    const client = new A2AClient({ url: new URL(sdk.url).origin, token: TOKEN });

    const card = await client.getAgentCard();
    expect(card.name).toBe('sdk-agent');

    const { task } = await client.sendMessage({ text: 'hello', skillId: 'echo' });
    expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task?.artifacts?.[0].parts).toEqual([{ text: 'sdk echo: hello' }]);
    expect((await client.getTask(task!.id)).status.state).toBe('TASK_STATE_COMPLETED');

    const running = await client.sendMessage({ text: 'wait', returnImmediately: true });
    expect(running.task?.status.state).toBe('TASK_STATE_WORKING');
    expect((await client.cancelTask(running.task!.id)).status.state).toBe('TASK_STATE_CANCELED');

    await expect(client.cancelTask(task!.id)).rejects.toMatchObject({ rpcCode: E.TASK_NOT_CANCELABLE });
    await expect(client.getTask('missing')).rejects.toMatchObject({ rpcCode: E.TASK_NOT_FOUND });
    expect(sdk.requests.every((r) => r.version === '1.0' && r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('Evalanche A2AClient', () => {
  it('maps authentication and protocol failures to A2AError', async () => {
    const server = await startEvalanche();
    const anonymous = new A2AClient({ url: new URL(server.url!).origin });
    await expect(anonymous.sendMessage({ text: 'x', skillId: 'echo' })).rejects.toMatchObject({ httpStatus: 401 });
    const client = new A2AClient({ url: new URL(server.url!).origin, token: TOKEN });
    await expect(client.sendMessage({ text: 'x' })).rejects.toBeInstanceOf(A2AError);
    await expect(client.sendMessage({ text: 'x' })).rejects.toMatchObject({ rpcCode: E.INVALID_PARAMS });
    const { task } = await client.sendMessage({ data: { n: 1 }, skillId: 'echo' });
    expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('waits past the server task deadline and receives the failed task', async () => {
    const policy = (client: A2AClient) => (client as unknown as { policy(url: URL): { timeoutMs: number } }).policy(new URL('http://127.0.0.1'));
    expect(policy(new A2AClient({ url: 'http://127.0.0.1' })).timeoutMs).toBe(A2A_DEFAULT_TASK_TIMEOUT_MS + 10_000);
    const server = await startEvalanche();
    expect((server as unknown as { limits: { taskTimeoutMs: number } }).limits.taskTimeoutMs).toBe(A2A_DEFAULT_TASK_TIMEOUT_MS);

    const quick = new A2AServer({
      name: 'deadline-agent',
      description: 'Short task deadline',
      version: '1.0.0',
      auth: { tokens: [{ token: TOKEN, principal: 'sdk-client', scopes: ['skill:*'] }] },
      skills: [skills[1]],
      limits: { taskTimeoutMs: 100 },
    });
    await quick.listen(0);
    closers.push(() => quick.close());
    const client = new A2AClient({ url: new URL(quick.url!).origin, token: TOKEN, timeoutMs: 1_000 });
    const { task } = await client.sendMessage({ text: 'wait' });
    expect(task?.status.state).toBe('TASK_STATE_FAILED');
    expect(task?.status.message?.parts).toEqual([{ text: 'Task timed out' }]);
  });

  it('will not send its token to an endpoint on another origin', async () => {
    const sdk = await startSdkServer();
    const decoy = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'decoy', supportedInterfaces: [{ url: sdk.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }] }));
    });
    await new Promise<void>((resolve) => decoy.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => decoy.close(() => resolve())));
    const origin = `http://127.0.0.1:${(decoy.address() as AddressInfo).port}`;

    await expect(new A2AClient({ url: origin, token: TOKEN }).sendMessage({ text: 'x' })).rejects.toThrow(/another origin/);
    expect(sdk.requests).toHaveLength(0);
    const { task } = await new A2AClient({ url: origin }).sendMessage({ text: 'hi' });
    expect(task?.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses agents without a 1.0 JSON-RPC interface', async () => {
    const legacy = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'legacy', protocolVersion: '0.3', url: 'http://127.0.0.1/a2a', supportedInterfaces: [] }));
    });
    await new Promise<void>((resolve) => legacy.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => legacy.close(() => resolve())));
    const client = new A2AClient({ url: `http://127.0.0.1:${(legacy.address() as AddressInfo).port}` });
    await expect(client.getAgentCard()).rejects.toThrow(/A2A 1.0 JSON-RPC/);
  });

  it('requires https for remote hosts and can block private networks', () => {
    expect(() => new A2AClient({ url: 'http://agent.example' })).toThrow(/protocol/);
    expect(() => new A2AClient({ url: 'https://127.0.0.1', blockPrivateNetwork: true })).toThrow(/Blocked/);
    expect(() => new A2AClient({ url: 'https://[fd00::1]', blockPrivateNetwork: true })).toThrow(/Blocked/);
    expect(() => new A2AClient({ url: 'not a url' })).toThrow(/invalid url/);
  });
});
