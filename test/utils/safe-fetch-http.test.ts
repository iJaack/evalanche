import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFetch } from '../../src/utils/safe-fetch';
import { EvalancheErrorCode } from '../../src/utils/errors';

let server: Server;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve() {
  server = createServer((req, res) => {
    if (req.url === '/stall') {
      res.writeHead(200);
      res.flushHeaders();
      return;
    }
    if (req.url === '/large') {
      res.write('0123456789');
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// Bound the reproduction too, so a broken request cannot stall the test runner.
async function boundedRead(read: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([read, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Body read never settled')), 800);
    })]);
  } finally {
    clearTimeout(timer!);
  }
}

describe('safeFetch with real HTTP bodies', () => {
  it('keeps the request deadline active after headers arrive', async () => {
    const url = await serve();
    const response = await safeFetch(`${url}/stall`, { allowHttp: true, timeoutMs: 200 });
    await expect(boundedRead(response.text())).rejects.toMatchObject({ code: EvalancheErrorCode.NETWORK_ERROR });
  });

  it('honors caller cancellation after headers arrive', async () => {
    const url = await serve();
    const controller = new AbortController();
    const response = await safeFetch(`${url}/stall`, { allowHttp: true, signal: controller.signal });
    const reading = boundedRead(response.json());
    controller.abort();
    await expect(reading).rejects.toMatchObject({ code: EvalancheErrorCode.NETWORK_ERROR });
  });

  it('rejects an already cancelled request', async () => {
    const url = await serve();
    const controller = new AbortController();
    controller.abort();
    await expect(safeFetch(url, { allowHttp: true, signal: controller.signal })).rejects.toMatchObject({
      code: EvalancheErrorCode.NETWORK_ERROR,
    });
  });

  it('enforces byte limits without content-length and releases the reader', async () => {
    const url = await serve();
    const response = await safeFetch(`${url}/large`, { allowHttp: true, maxBytes: 4 });
    await expect(response.arrayBuffer()).rejects.toThrow('Response too large');
    expect(response.body?.locked).toBe(false);
  });

  it('returns valid JSON and retains completed body data after the deadline', async () => {
    const url = await serve();
    const response = await safeFetch(url, { allowHttp: true, timeoutMs: 200 });
    expect(await response.json()).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await response.text()).toBe('{"ok":true}');
  });
});
