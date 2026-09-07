# A2A PR #10 release review

Reviewed on 2026-09-07 against contribution commit `38bab5c066994dc2bdfac95c36d4765bfbbd57ce`.

Decision: do not merge this contribution into the reliability release.

## Confirmed blockers

1. **Credential verification is absent.** `A2AServer._checkAuth` accepts any non-empty configured header or the mere presence of a query parameter. A local client/server test submitted a task with `Bearer INVALID-CREDENTIAL` and observed the handler execute. Authentication configuration does not include a verifier or expected credential.
2. **MCP exposes capabilities without authentication.** The proposed `a2a_serve` starts a listener on port 3100 without authentication or an explicit loopback bind. Its handlers include wallet signing and paid requests. The server defaults must deny unauthenticated capability execution.
3. **The transport is not standard A2A.** A standard JSON-RPC `message/send` request to the advertised endpoint returned HTTP 404 in the local test. The PR uses custom `/tasks` requests, string task statuses and custom artifacts. Successful exchange between this PR's own client and server does not certify interoperability. Compare the [A2A 0.3 specification](https://a2a-protocol.org/v0.3.0/specification/) and [1.0 migration guide](https://a2a-protocol.org/latest/whats-new-v1/); choose and advertise a supported version explicitly.

## Acceptance criteria for a replacement

- Use a versioned standard binding and validate interoperability with an independent A2A implementation.
- Verify credentials before task creation; reject invalid and missing credentials. Keep secret values out of agent cards and errors.
- Bind to loopback by default and require explicit configuration for remote exposure.
- Expose an explicit capability allowlist, with separate authorization for signing and spending.
- Bound request bodies, request duration, retained tasks and concurrency; cancel work rather than only changing a task label.
- Cover card discovery, submit/get/cancel, invalid authentication, malformed payloads and independent client/server exchange with regression tests.

## Reproduction

Use a detached checkout of PR #10. Register an in-memory echo handler with a counter and authentication `{ type: 'bearer' }`, then listen on an ephemeral port. Submit via `A2AClient.submitTask` with `auth: 'Bearer INVALID-CREDENTIAL'`: the counter increments. POST a JSON-RPC `message/send` request with a valid standard message envelope to the advertised URL: HTTP 404. Close the server. No wallet or external service is involved.

The review exercised only a local echo handler. No signing, payment or public server was used. The PR remains unmerged; no A2A execution support is claimed in this release.
