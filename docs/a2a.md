# A2A 1.0 (JSON-RPC)

`A2AServer` and `A2AClient` implement the [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/) over the JSON-RPC binding. They replace closed PR #10 and address the blockers and acceptance criteria in [the review](reviews/A2A_PR10_REVIEW.md).

## Server

```ts
import { A2AServer, A2ASkillError } from 'evalanche';

const server = new A2AServer({
  name: 'quote-agent',
  description: 'Quotes swaps on Avalanche',
  version: '1.0.0',
  auth: {
    tokens: [
      { token: process.env.DESK_TOKEN!, principal: 'desk', scopes: ['skill:quote'] },
      { token: process.env.TREASURY_TOKEN!, principal: 'treasury', scopes: ['skill:*', 'spend'] },
    ],
  },
  skills: [
    {
      id: 'quote',
      name: 'Quote',
      description: 'Quote a swap',
      handler: async ({ text, signal }) => quote(text, { signal }),
    },
    {
      id: 'pay',
      name: 'Pay',
      description: 'Pay an invoice from the treasury',
      permissions: ['spend'],
      handler: async ({ data, signal }) => {
        if (!isInvoice(data[0])) throw new A2ASkillError('invalid invoice');
        return { data: await pay(data[0], { signal }) };
      },
    },
  ],
});

await server.listen(4100);
// JSON-RPC endpoint: http://127.0.0.1:4100/a2a
// Agent card:        http://127.0.0.1:4100/.well-known/agent-card.json
```

Protocol:
- Advertises one interface: `protocolBinding: "JSONRPC"`, `protocolVersion: "1.0"`.
- Implements `SendMessage` (blocking by default, or `configuration.returnImmediately`), `GetTask` (with `historyLength`) and `CancelTask`.
- Requests must carry `A2A-Version: 1.0`, as a header or query parameter. A missing version means 0.3, which is refused with `VersionNotSupportedError` (-32009).
- Streaming, `ListTasks`, push notifications and the extended card are not offered. Each returns its standard A2A error.
- Accepts text and data parts, keeping their `mediaType`, `filename` and `metadata`. Messages keep `metadata`, `referenceTaskIds` and `extensions` (up to 32 entries each). URL and raw parts return `ContentTypeNotSupportedError`.
- Results follow `configuration.acceptedOutputModes`. When the caller accepts only `text/plain`, data comes back as JSON text. When it accepts only `application/json`, text comes back as a JSON string.
- `message.metadata.skillId` (or `metadata.skillId` on the request) selects the skill. It can be omitted when only one skill is registered.

Security:
- **Credentials.** Every JSON-RPC request is authenticated before any parsing or task creation. Static tokens need at least 32 characters and are compared by SHA-256 digest with `timingSafeEqual`. For JWT or other schemes, use `auth: { verify }`. A verifier that throws rejects the request. Missing and invalid credentials get HTTP 401 with `WWW-Authenticate: Bearer`. Tokens never appear in the agent card or in errors.
- **Capabilities.** Only registered skills can run. A caller needs `skill:<id>` (or `skill:*`). A skill that declares `permissions: ['sign']` or `['spend']` also needs those scopes, granted separately, so `skill:*` alone never signs or spends. Missing scopes get HTTP 403 with `insufficient_scope`.
- **Exposure.** The server binds to `127.0.0.1`. Any other host needs `allowRemote: true` and an `https` `publicUrl`, with TLS terminated in front of the server.
- **Task isolation.** Tasks are visible only to the principal that created them. Other callers get `TaskNotFoundError`.
- **Errors.** Handler errors are reported as `Skill execution failed`. Only messages thrown as `A2ASkillError` reach the caller.
- The MCP server does not start A2A listeners. Skills, and any signing or spending they do, are wired in code.

Limits (all configurable through `limits`):

| Limit | Default | When exceeded |
| --- | --- | --- |
| `maxBodyBytes` | 64 KiB | HTTP 413 |
| `requestTimeoutMs` | 10 s to receive a request | connection closed |
| `taskTimeoutMs` | 30 s | handler aborted, task `TASK_STATE_FAILED` |
| `maxConcurrentTasks` | 4 running handlers | HTTP 429 with `Retry-After` |
| `maxRetainedTasks` | 100 | oldest finished tasks evicted when a new task starts |
| `taskRetentionMs` | 10 min | finished tasks forgotten |
| `maxParts` | 16 per message | `InvalidParams` |

Cancellation aborts the handler's `signal`, and any result that arrives afterwards is discarded. A handler counts against `maxConcurrentTasks` until it actually returns, so handlers must stop when `signal` fires.

## Client

```ts
import { A2AClient } from 'evalanche';

const agent = new A2AClient({ url: 'https://agent.example', token: process.env.AGENT_TOKEN });
const { task } = await agent.sendMessage({ text: 'quote 1 AVAX to USDC', skillId: 'quote' });
const later = await agent.getTask(task!.id);
await agent.cancelTask(task!.id);
```

- Reads `/.well-known/agent-card.json` and picks the first `JSONRPC` interface with protocol version 1.0.
- Sends the token only when the endpoint has the same origin as the card.
- Waits up to 40 s per request by default (`timeoutMs`), 10 s past the server's default 30 s task deadline, so a blocking `sendMessage` receives a timed-out task as `TASK_STATE_FAILED` rather than a network error.
- Uses `safeFetch`: https only (plain http is allowed only for loopback, unless `allowHttp` is set), no redirects, and a timeout and response-size cap on every request. Set `blockPrivateNetwork` for URLs that come from untrusted input; it refuses private IPv4 and IPv6 hosts, including unique-local, link-local and IPv4-mapped addresses.
- Calls throw `A2AError` with `rpcCode` (JSON-RPC error code) and `httpStatus`. Transport failures (unreachable host, timeout, oversized or refused response) are `A2AError` too, with the original error as `underlying`. The constructor throws `EvalancheError` for an invalid or refused URL.

## Interoperability

`test/interop/a2a-interop.test.ts` exchanges messages with the official A2A JavaScript SDK (`@a2a-js/sdk` 1.3.0, protocol 1.0), a test-only dev dependency, in both directions:
- the SDK's `ClientFactory` discovers an `A2AServer` card, then runs submit, get and cancel, and is refused without valid credentials;
- `A2AClient` runs submit, get and cancel against the SDK's `DefaultRequestHandler` and `JsonRpcTransportHandler`.

`test/interop/a2a-server.test.ts` covers card discovery, invalid authentication, authorization, malformed payloads, version negotiation, cancellation, timeouts, limits and configuration. It also includes the review's reproduction.
