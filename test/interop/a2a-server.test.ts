import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { A2AServer, A2ASkillError, type A2AServerOptions, type A2ASkill } from '../../src/interop/a2a-server';
import { A2A_ERROR_CODES as E } from '../../src/interop/a2a-protocol';

const DESK = 'desk-token-0123456789abcdef0123456789abcdef';
const OTHER = 'other-token-0123456789abcdef0123456789abcde';
const SIGNER = 'signer-token-0123456789abcdef0123456789abcd';
const SPENDER = 'spender-token-0123456789abcdef0123456789abc';
const TREASURY = 'treasury-token-0123456789abcdef0123456789ab';

let calls = 0;
let aborted = false;
const echo: A2ASkill = {
  id: 'echo',
  name: 'Echo',
  description: 'Echoes the text back',
  tags: ['test'],
  handler: ({ text, data }) => {
    calls++;
    return data.length ? { text: `echo: ${text}`, data: data[0] } : `echo: ${text}`;
  },
};
const slow: A2ASkill = {
  id: 'slow',
  name: 'Slow',
  description: 'Runs until aborted',
  handler: ({ signal }) => new Promise((_resolve, reject) => {
    calls++;
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    });
  }),
};

const servers: A2AServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  calls = 0;
  aborted = false;
});

function options(overrides: Partial<A2AServerOptions> = {}): A2AServerOptions {
  return {
    name: 'test-agent',
    description: 'Test agent',
    version: '0.0.1',
    auth: {
      tokens: [
        { token: DESK, principal: 'desk', scopes: ['skill:echo', 'skill:slow'] },
        { token: OTHER, principal: 'other', scopes: ['skill:*'] },
      ],
    },
    skills: [echo],
    ...overrides,
  };
}

async function start(overrides: Partial<A2AServerOptions> = {}): Promise<A2AServer> {
  const server = new A2AServer(options(overrides));
  servers.push(server);
  await server.listen(0);
  return server;
}

interface RpcOptions {
  token?: string | null;
  version?: string | null;
  contentType?: string;
  raw?: string;
}

async function rpc(server: A2AServer, method: string, params?: unknown, opts: RpcOptions = {}) {
  const headers: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/json' };
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? DESK}`;
  if (opts.version !== null) headers['A2A-Version'] = opts.version ?? '1.0';
  const res = await fetch(server.url!, {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify({ jsonrpc: '2.0', id: 7, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: JSON.parse(text) };
}

const userMessage = (text = 'hello', metadata?: Record<string, unknown>) => ({
  messageId: randomUUID(),
  role: 'ROLE_USER',
  parts: [{ text }],
  ...(metadata ? { metadata } : {}),
});

describe('A2AServer agent card', () => {
  it('serves a 1.0 JSON-RPC card without credentials and without secrets', async () => {
    const server = await start();
    const origin = new URL(server.url!).origin;
    const res = await fetch(`${origin}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const card = JSON.parse(raw);
    expect(card).toMatchObject({
      name: 'test-agent',
      version: '0.0.1',
      supportedInterfaces: [{ url: server.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      skills: [{ id: 'echo', name: 'Echo', description: 'Echoes the text back', tags: ['test'] }],
    });
    expect(raw).not.toContain(DESK);
    expect(raw).not.toContain('desk');
  });

  it('binds to loopback by default', async () => {
    const server = await start();
    expect(new URL(server.url!).hostname).toBe('127.0.0.1');
  });
});

describe('A2AServer authentication', () => {
  it('rejects missing and invalid credentials before running anything', async () => {
    const server = await start();
    for (const token of [null, 'INVALID-CREDENTIAL', `${DESK}x`, DESK.slice(0, -1)]) {
      const res = await rpc(server, 'SendMessage', { message: userMessage() }, { token });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="a2a"');
      expect(JSON.stringify(res.body)).not.toContain(DESK);
    }
    const basic = await fetch(server.url!, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`desk:${DESK}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(basic.status).toBe(401);
    expect(calls).toBe(0);
  });

  it('uses a custom verifier and fails closed when it throws', async () => {
    const server = await start({
      auth: {
        verify: (token) => {
          if (token === 'boom') throw new Error('verifier down');
          return token === 'good' ? { id: 'jwt-user', scopes: ['skill:echo'] } : null;
        },
      },
    });
    expect((await rpc(server, 'SendMessage', { message: userMessage() }, { token: 'bad' })).status).toBe(401);
    expect((await rpc(server, 'SendMessage', { message: userMessage() }, { token: 'boom' })).status).toBe(401);
    expect(calls).toBe(0);
    const ok = await rpc(server, 'SendMessage', { message: userMessage() }, { token: 'good' });
    expect(ok.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(calls).toBe(1);
  });
});

describe('A2AServer authorization', () => {
  const sign: A2ASkill = { id: 'sign', name: 'Sign', description: 'Signs', permissions: ['sign'], handler: () => 'signed' };
  const pay: A2ASkill = { id: 'pay', name: 'Pay', description: 'Pays', permissions: ['spend'], handler: () => 'paid' };
  const auth = {
    tokens: [
      { token: DESK, principal: 'desk', scopes: ['skill:echo'] },
      { token: SIGNER, principal: 'signer', scopes: ['skill:*', 'sign'] },
      { token: SPENDER, principal: 'spender', scopes: ['skill:*', 'spend'] },
      { token: TREASURY, principal: 'treasury', scopes: ['skill:sign', 'skill:pay', 'sign', 'spend'] },
    ],
  };
  const send = (server: A2AServer, skillId: string, token: string) =>
    rpc(server, 'SendMessage', { message: userMessage('go', { skillId }) }, { token });

  it('requires the skill scope and each privileged permission separately', async () => {
    const server = await start({ auth, skills: [echo, sign, pay] });
    const denied = await send(server, 'sign', DESK);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer error="insufficient_scope", scope="skill:sign sign"');
    expect((await send(server, 'pay', SIGNER)).status).toBe(403);
    expect((await send(server, 'sign', SPENDER)).status).toBe(403);
    expect((await send(server, 'sign', SIGNER)).body.result.task.artifacts[0].parts).toEqual([{ text: 'signed' }]);
    expect((await send(server, 'pay', SPENDER)).body.result.task.artifacts[0].parts).toEqual([{ text: 'paid' }]);
    expect((await send(server, 'echo', TREASURY)).status).toBe(403);
    expect((await send(server, 'pay', TREASURY)).status).toBe(200);
  });

  it('only runs registered skills and needs a skill id when there are several', async () => {
    const server = await start({ skills: [echo, slow] });
    const missing = await rpc(server, 'SendMessage', { message: userMessage() });
    expect(missing.body.error.code).toBe(E.INVALID_PARAMS);
    const unknown = await rpc(server, 'SendMessage', { message: userMessage('x', { skillId: 'get_balance' }) });
    expect(unknown.body.error).toEqual({ code: E.INVALID_PARAMS, message: 'Unknown skill' });
    const viaRequest = await rpc(server, 'SendMessage', { message: userMessage('hi'), metadata: { skillId: 'echo' } });
    expect(viaRequest.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(calls).toBe(1);
  });

  it('hides tasks from other principals', async () => {
    const server = await start();
    const sent = await rpc(server, 'SendMessage', { message: userMessage() });
    const id = sent.body.result.task.id;
    expect((await rpc(server, 'GetTask', { id }, { token: OTHER })).body.error.code).toBe(E.TASK_NOT_FOUND);
    expect((await rpc(server, 'CancelTask', { id }, { token: OTHER })).body.error.code).toBe(E.TASK_NOT_FOUND);
    expect((await rpc(server, 'GetTask', { id })).body.result.id).toBe(id);
  });
});

describe('A2AServer tasks', () => {
  it('submits, completes and reads back a task', async () => {
    const server = await start();
    const message = userMessage('hello', { trace: 'a' });
    const sent = await rpc(server, 'SendMessage', { message });
    expect(sent.status).toBe(200);
    expect(sent.body.id).toBe(7);
    const task = sent.body.result.task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(Date.parse(task.status.timestamp)).not.toBeNaN();
    expect(task.artifacts).toEqual([{ artifactId: expect.any(String), name: 'result', parts: [{ text: 'echo: hello' }] }]);
    expect(task.history).toEqual([{ ...message, taskId: task.id, contextId: task.contextId }]);

    const got = await rpc(server, 'GetTask', { id: task.id });
    expect(got.body.result).toEqual(task);
    const noHistory = await rpc(server, 'GetTask', { id: task.id, historyLength: 0 });
    expect(noHistory.body.result.history).toBeUndefined();
  });

  it('returns data parts and keeps the caller context id', async () => {
    const server = await start();
    const message = { ...userMessage('payload'), contextId: 'ctx-1', parts: [{ text: 'payload' }, { data: { amount: 1 } }] };
    const sent = await rpc(server, 'SendMessage', { message });
    expect(sent.body.result.task.contextId).toBe('ctx-1');
    expect(sent.body.result.task.artifacts[0].parts).toEqual([
      { text: 'echo: payload' },
      { data: { amount: 1 }, mediaType: 'application/json' },
    ]);
  });

  it('converts results to the output modes the caller accepts', async () => {
    const server = await start();
    const send = (acceptedOutputModes: string[]) => rpc(server, 'SendMessage', {
      message: { ...userMessage('p'), parts: [{ text: 'p' }, { data: { amount: 1 } }] },
      configuration: { acceptedOutputModes },
    }).then((res) => res.body.result.task.artifacts[0].parts);
    expect(await send(['text/plain'])).toEqual([{ text: 'echo: p' }, { text: '{"amount":1}' }]);
    expect(await send(['application/*'])).toEqual([
      { data: 'echo: p', mediaType: 'application/json' },
      { data: { amount: 1 }, mediaType: 'application/json' },
    ]);
    expect(await send(['*/*'])).toEqual([{ text: 'echo: p' }, { data: { amount: 1 }, mediaType: 'application/json' }]);
  });

  it('keeps part media types, file names and metadata', async () => {
    let seen: unknown;
    const inspect: A2ASkill = { id: 'inspect', name: 'Inspect', description: 'Reads parts', handler: ({ message }) => { seen = message.parts; return 'ok'; } };
    const server = await start({ skills: [inspect], auth: { tokens: [{ token: DESK, principal: 'desk', scopes: ['skill:inspect'] }] } });
    const parts = [
      { text: 'hi', mediaType: 'text/markdown', metadata: { lang: 'en' } },
      { data: { a: 1 }, mediaType: 'application/vnd.quote+json', filename: 'quote.json' },
    ];
    const sent = await rpc(server, 'SendMessage', { message: { ...userMessage(), parts } });
    expect(seen).toEqual(parts);
    expect(sent.body.result.task.history[0].parts).toEqual(parts);
  });

  it('keeps message reference task ids and extensions', async () => {
    let seen: unknown;
    const inspect: A2ASkill = { id: 'inspect', name: 'Inspect', description: 'Reads the message', handler: ({ message }) => { seen = message; return 'ok'; } };
    const server = await start({ skills: [inspect], auth: { tokens: [{ token: DESK, principal: 'desk', scopes: ['skill:inspect'] }] } });
    const extra = { referenceTaskIds: ['task-1', 'task-2'], extensions: ['https://example.com/a2a/ext/v1'] };
    const sent = await rpc(server, 'SendMessage', { message: { ...userMessage(), ...extra } });
    expect(seen).toMatchObject(extra);
    expect(sent.body.result.task.history[0]).toMatchObject(extra);
  });

  it('cancels running work through the abort signal', async () => {
    const server = await start({ skills: [slow] });
    const sent = await rpc(server, 'SendMessage', { message: userMessage(), configuration: { returnImmediately: true } });
    const id = sent.body.result.task.id;
    expect(sent.body.result.task.status.state).toBe('TASK_STATE_WORKING');

    const canceled = await rpc(server, 'CancelTask', { id });
    expect(canceled.body.result.status.state).toBe('TASK_STATE_CANCELED');
    expect(aborted).toBe(true);
    expect((await rpc(server, 'GetTask', { id })).body.result.status.state).toBe('TASK_STATE_CANCELED');
    expect((await rpc(server, 'CancelTask', { id })).body.result.status.state).toBe('TASK_STATE_CANCELED');
  });

  it('refuses to cancel a completed task', async () => {
    const server = await start();
    const id = (await rpc(server, 'SendMessage', { message: userMessage() })).body.result.task.id;
    expect((await rpc(server, 'CancelTask', { id })).body.error.code).toBe(E.TASK_NOT_CANCELABLE);
  });

  it('discards a result that arrives after cancellation', async () => {
    let release!: (value: string) => void;
    const late: A2ASkill = { id: 'late', name: 'Late', description: 'Ignores abort', handler: () => new Promise((resolve) => { release = resolve; }) };
    const server = await start({ skills: [late], auth: { tokens: [{ token: DESK, principal: 'desk', scopes: ['skill:late'] }] } });
    const id = (await rpc(server, 'SendMessage', { message: userMessage(), configuration: { returnImmediately: true } })).body.result.task.id;
    await rpc(server, 'CancelTask', { id });
    release('too late');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const task = (await rpc(server, 'GetTask', { id })).body.result;
    expect(task.status.state).toBe('TASK_STATE_CANCELED');
    expect(task.artifacts).toBeUndefined();
  });

  it('fails and aborts a task that exceeds its deadline', async () => {
    const server = await start({ skills: [slow], limits: { taskTimeoutMs: 50 } });
    const sent = await rpc(server, 'SendMessage', { message: userMessage() });
    const task = sent.body.result.task;
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(task.status.message.parts).toEqual([{ text: 'Task timed out' }]);
    expect(task.status.message.role).toBe('ROLE_AGENT');
    expect(aborted).toBe(true);
  });

  it('reports handler errors without leaking their details', async () => {
    const leaky: A2ASkill = { id: 'leaky', name: 'Leaky', description: 'Throws', handler: () => { throw new Error('rpc key sk-live-123'); } };
    const polite: A2ASkill = { id: 'polite', name: 'Polite', description: 'Throws safely', handler: () => { throw new A2ASkillError('amount must be positive'); } };
    const server = await start({ skills: [leaky, polite], auth: { tokens: [{ token: DESK, principal: 'desk', scopes: ['skill:*'] }] } });
    const leak = await rpc(server, 'SendMessage', { message: userMessage('x', { skillId: 'leaky' }) });
    expect(leak.body.result.task.status.state).toBe('TASK_STATE_FAILED');
    expect(JSON.stringify(leak.body)).not.toContain('sk-live');
    expect(leak.body.result.task.status.message.parts).toEqual([{ text: 'Skill execution failed' }]);
    const safe = await rpc(server, 'SendMessage', { message: userMessage('x', { skillId: 'polite' }) });
    expect(safe.body.result.task.status.message.parts).toEqual([{ text: 'amount must be positive' }]);
  });

  it('rejects messages that try to continue a task', async () => {
    const server = await start();
    const res = await rpc(server, 'SendMessage', { message: { ...userMessage(), taskId: 'abc' } });
    expect(res.body.error.code).toBe(E.UNSUPPORTED_OPERATION);
    expect(calls).toBe(0);
  });
});

describe('A2AServer resource bounds', () => {
  it('refuses tasks beyond the concurrency limit until a slot frees', async () => {
    const server = await start({ skills: [slow], limits: { maxConcurrentTasks: 1, maxRetainedTasks: 3 } });
    const first = await rpc(server, 'SendMessage', { message: userMessage(), configuration: { returnImmediately: true } });
    const busy = await rpc(server, 'SendMessage', { message: userMessage(), configuration: { returnImmediately: true } });
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('1');
    await rpc(server, 'CancelTask', { id: first.body.result.task.id });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await rpc(server, 'SendMessage', { message: userMessage(), configuration: { returnImmediately: true } });
    expect(next.status).toBe(200);
  });

  it('keeps a slot taken while a timed-out handler is still running', async () => {
    const stuck: A2ASkill = { id: 'stuck', name: 'Stuck', description: 'Never returns', handler: () => new Promise(() => undefined) };
    const server = await start({
      skills: [stuck],
      auth: { tokens: [{ token: DESK, principal: 'desk', scopes: ['skill:stuck'] }] },
      limits: { maxConcurrentTasks: 1, maxRetainedTasks: 2, taskTimeoutMs: 20 },
    });
    expect((await rpc(server, 'SendMessage', { message: userMessage() })).body.result.task.status.state).toBe('TASK_STATE_FAILED');
    expect((await rpc(server, 'SendMessage', { message: userMessage() })).status).toBe(429);
  });

  it('evicts the oldest finished tasks beyond the retention cap', async () => {
    const server = await start({ limits: { maxConcurrentTasks: 1, maxRetainedTasks: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await rpc(server, 'SendMessage', { message: userMessage() })).body.result.task.id);
    expect((await rpc(server, 'GetTask', { id: ids[0] })).body.error.code).toBe(E.TASK_NOT_FOUND);
    expect((await rpc(server, 'GetTask', { id: ids[2] })).body.result.id).toBe(ids[2]);
  });

  it('lets reads leave a full store alone', async () => {
    const server = await start({ limits: { maxConcurrentTasks: 1, maxRetainedTasks: 2 } });
    const first = (await rpc(server, 'SendMessage', { message: userMessage() })).body.result.task.id;
    const second = (await rpc(server, 'SendMessage', { message: userMessage() })).body.result.task.id;
    for (let i = 0; i < 3; i++) {
      expect((await rpc(server, 'GetTask', { id: first })).body.result.id).toBe(first);
      expect((await rpc(server, 'CancelTask', { id: second })).body.error.code).toBe(E.TASK_NOT_CANCELABLE);
    }
    expect((await rpc(server, 'GetTask', { id: second })).body.result.id).toBe(second);
  });

  it('forgets finished tasks after the retention period', async () => {
    const server = await start({ limits: { taskRetentionMs: 20 } });
    const id = (await rpc(server, 'SendMessage', { message: userMessage() })).body.result.task.id;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await rpc(server, 'GetTask', { id })).body.error.code).toBe(E.TASK_NOT_FOUND);
  });

  it('rejects oversized bodies without running the skill', async () => {
    const server = await start({ limits: { maxBodyBytes: 512 } });
    const res = await rpc(server, 'SendMessage', { message: userMessage('x'.repeat(1_000)) });
    expect(res.status).toBe(413);
    expect(calls).toBe(0);
  });

  it('limits the number of parts', async () => {
    const server = await start({ limits: { maxParts: 2 } });
    const res = await rpc(server, 'SendMessage', { message: { ...userMessage(), parts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] } });
    expect(res.body.error.code).toBe(E.INVALID_PARAMS);
    expect(calls).toBe(0);
  });
});

describe('A2AServer malformed requests', () => {
  const cases: Array<[string, RpcOptions & { method?: string; params?: unknown }, number]> = [
    ['invalid JSON', { raw: '{"jsonrpc":' }, E.PARSE_ERROR],
    ['batch request', { raw: '[]' }, E.INVALID_REQUEST],
    ['missing jsonrpc', { raw: JSON.stringify({ id: 1, method: 'GetTask', params: { id: 'x' } }) }, E.INVALID_REQUEST],
    ['notification without id', { raw: JSON.stringify({ jsonrpc: '2.0', method: 'GetTask', params: { id: 'x' } }) }, E.INVALID_REQUEST],
    ['unknown method', { method: 'DoSomething', params: {} }, E.METHOD_NOT_FOUND],
    ['A2A 0.3 method', { method: 'message/send', params: { message: userMessage() } }, E.METHOD_NOT_FOUND],
    ['params not an object', { method: 'GetTask', params: ['x'] }, E.INVALID_PARAMS],
    ['missing message', { method: 'SendMessage', params: {} }, E.INVALID_PARAMS],
    ['missing messageId', { method: 'SendMessage', params: { message: { role: 'ROLE_USER', parts: [{ text: 'x' }] } } }, E.INVALID_PARAMS],
    ['agent role', { method: 'SendMessage', params: { message: { ...userMessage(), role: 'ROLE_AGENT' } } }, E.INVALID_PARAMS],
    ['lowercase role', { method: 'SendMessage', params: { message: { ...userMessage(), role: 'user' } } }, E.INVALID_PARAMS],
    ['empty parts', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [] } } }, E.INVALID_PARAMS],
    ['part with two kinds', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [{ text: 'a', data: 1 }] } } }, E.INVALID_PARAMS],
    ['part metadata not an object', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [{ text: 'a', metadata: 'x' }] } } }, E.INVALID_PARAMS],
    ['non-string filename', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [{ data: 1, filename: 2 }] } } }, E.INVALID_PARAMS],
    ['referenceTaskIds not a list', { method: 'SendMessage', params: { message: { ...userMessage(), referenceTaskIds: 'task-1' } } }, E.INVALID_PARAMS],
    ['empty extension', { method: 'SendMessage', params: { message: { ...userMessage(), extensions: [''] } } }, E.INVALID_PARAMS],
    ['too many reference ids', { method: 'SendMessage', params: { message: { ...userMessage(), referenceTaskIds: Array(33).fill('t') } } }, E.INVALID_PARAMS],
    ['non-string text', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [{ text: 5 }] } } }, E.INVALID_PARAMS],
    ['url part', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [{ url: 'https://x' }] } } }, E.CONTENT_TYPE_NOT_SUPPORTED],
    ['raw part', { method: 'SendMessage', params: { message: { ...userMessage(), parts: [{ raw: 'AAAA' }] } } }, E.CONTENT_TYPE_NOT_SUPPORTED],
    ['unsupported output mode', { method: 'SendMessage', params: { message: userMessage(), configuration: { acceptedOutputModes: ['image/png'] } } }, E.CONTENT_TYPE_NOT_SUPPORTED],
    ['bad returnImmediately', { method: 'SendMessage', params: { message: userMessage(), configuration: { returnImmediately: 'yes' } } }, E.INVALID_PARAMS],
    ['negative historyLength', { method: 'GetTask', params: { id: 'x', historyLength: -1 } }, E.INVALID_PARAMS],
    ['missing task id', { method: 'GetTask', params: {} }, E.INVALID_PARAMS],
    ['unknown task', { method: 'GetTask', params: { id: 'nope' } }, E.TASK_NOT_FOUND],
    ['streaming', { method: 'SendStreamingMessage', params: { message: userMessage() } }, E.UNSUPPORTED_OPERATION],
    ['list tasks', { method: 'ListTasks', params: {} }, E.UNSUPPORTED_OPERATION],
    ['push config', { method: 'CreateTaskPushNotificationConfig', params: {} }, E.PUSH_NOTIFICATION_NOT_SUPPORTED],
    ['extended card', { method: 'GetExtendedAgentCard' }, E.EXTENDED_CARD_NOT_CONFIGURED],
  ];

  it.each(cases)('%s', async (_name, { method = 'SendMessage', params, ...opts }, code) => {
    const server = await start();
    const res = await rpc(server, method, params, opts);
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error.code).toBe(code);
    expect(calls).toBe(0);
  });

  it('requires A2A-Version 1.0', async () => {
    const server = await start();
    for (const version of [null, '0.3', '2.0', '1.1']) {
      const res = await rpc(server, 'SendMessage', { message: userMessage() }, { version });
      expect(res.body.error.code).toBe(E.VERSION_NOT_SUPPORTED);
    }
    expect(calls).toBe(0);
    const viaQuery = await fetch(`${server.url}?A2A-Version=1.0`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DESK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: userMessage() } }),
    });
    expect((await viaQuery.json()).result.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('rejects other content types, methods and paths', async () => {
    const server = await start();
    expect((await rpc(server, 'SendMessage', { message: userMessage() }, { contentType: 'text/plain' })).status).toBe(415);
    expect((await fetch(server.url!, { headers: { Authorization: `Bearer ${DESK}` } })).status).toBe(405);
    expect((await fetch(new URL('/tasks', server.url).toString(), { method: 'POST', headers: { Authorization: `Bearer ${DESK}` } })).status).toBe(404);
    expect(calls).toBe(0);
  });
});

describe('A2AServer configuration', () => {
  it('refuses unsafe or incomplete configuration', () => {
    const bad: Array<Partial<A2AServerOptions>> = [
      { auth: undefined as never },
      { auth: { tokens: [] } },
      { auth: { tokens: [{ token: 'short', principal: 'p', scopes: [] }] } },
      { auth: { tokens: [{ token: DESK, principal: 'a', scopes: [] }, { token: DESK, principal: 'b', scopes: [] }] } },
      { auth: { tokens: [{ token: DESK, principal: 'a', scopes: [] }], verify: () => null } as never },
      { skills: [] },
      { skills: [echo, echo] },
      { skills: [{ ...echo, id: 'bad id' }] },
      { skills: [{ ...echo, permissions: ['admin' as never] }] },
      { host: '0.0.0.0' },
      { host: '0.0.0.0', allowRemote: true },
      { host: '0.0.0.0', allowRemote: true, publicUrl: 'http://agent.example/a2a' },
      { limits: { maxConcurrentTasks: 10, maxRetainedTasks: 10 } },
      { limits: { taskTimeoutMs: 0 } },
    ];
    for (const overrides of bad) expect(() => new A2AServer(options(overrides)), JSON.stringify(overrides)).toThrow(/A2A server/);
  });

  it('allows remote exposure only with explicit opt-in and an https public URL', () => {
    const server = new A2AServer(options({ host: '0.0.0.0', allowRemote: true, publicUrl: 'https://agent.example/a2a' }));
    expect(server.getAgentCard().supportedInterfaces[0].url).toBe('https://agent.example/a2a');
  });
});

// Mirrors the reproduction in docs/reviews/A2A_PR10_REVIEW.md.
describe('A2A PR #10 review reproduction', () => {
  it('rejects an invalid bearer credential and answers standard requests', async () => {
    const server = await start();
    const invalid = await rpc(server, 'SendMessage', { message: userMessage() }, { token: 'INVALID-CREDENTIAL' });
    expect(invalid.status).toBe(401);
    expect(calls).toBe(0);

    const standard = await rpc(server, 'SendMessage', { message: userMessage('standard') });
    expect(standard.status).toBe(200);
    expect(standard.body.result.task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(calls).toBe(1);
  });
});
