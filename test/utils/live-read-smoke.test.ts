import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runLiveReadSmoke } from '../../scripts/live-read-smoke.mjs';

let server: Server;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('live read smoke', () => {
  it('checks real HTTP responses and reports wrong chain, HTTP errors, invalid JSON and timeouts', async () => {
    const methods: string[] = [];
    server = createServer((req, res) => {
      methods.push(req.method!);
      if (req.url === '/hang') return;
      if (req.url === '/error') { res.writeHead(429); res.end('secret provider response'); return; }
      res.end(req.url === '/invalid' ? 'bad JSON' : JSON.stringify({ result: req.url === '/ok' ? '0xa86a' : '0x1' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const result = await runLiveReadSmoke({ timeoutMs: 300, checks: ['ok', 'wrong', 'error', 'invalid', 'hang'].map((name) => ({
      name, url: `http://127.0.0.1:${port}/${name}`, validate: (data: any) => data.result === '0xa86a',
    })) });
    expect(result.ok).toBe(false);
    expect(result.checks.map((check: any) => check.ok)).toEqual([true, false, false, false, false]);
    expect(result.checks[2]).toMatchObject({ httpStatus: 429, reason: 'HTTP 429' });
    expect(result.checks[3].reason).toBe('Invalid JSON');
    expect(result.checks[4].reason).toContain('timeout');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(new Set(methods)).toEqual(new Set(['GET']));
    expect(result.checkedAt).toMatch(/^\d{4}-/);
  });
});
