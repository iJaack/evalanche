import { describe, expect, it, vi } from 'vitest';
import { PolymarketCli as RootPolymarketCli } from '../../src';
import { PolymarketCli, type PolymarketCliRunner } from '../../src/polymarket/cli';

describe('PolymarketCli', () => {
  it('is exported from the package root', () => {
    expect(RootPolymarketCli).toBe(PolymarketCli);
  });

  it('forces JSON output and passes private key through a minimal environment', async () => {
    const runner = vi.fn<PolymarketCliRunner>(async () => ({
      stdout: '{"ok":true}\n',
      stderr: '',
    }));
    const cli = new PolymarketCli({
      binary: '/usr/local/bin/polymarket',
      privateKey: 'abc123',
      signatureType: 'proxy',
      runner,
    });

    await expect(cli.orderBook('123')).resolves.toEqual({ ok: true });

    expect(runner).toHaveBeenCalledWith(
      '/usr/local/bin/polymarket',
      ['-o', 'json', 'clob', 'book', '123'],
      expect.objectContaining({
        env: expect.objectContaining({
          POLYMARKET_PRIVATE_KEY: '0xabc123',
          POLYMARKET_SIGNATURE_TYPE: 'proxy',
        }),
      }),
    );
    const env = runner.mock.calls[0]?.[2].env ?? {};
    expect(env.EVALANCHE_MCP_HTTP_TOKEN).toBeUndefined();
    expect(env.AGENT_PRIVATE_KEY).toBeUndefined();
    expect(Object.keys(env).some((key) => key.startsWith('npm_'))).toBe(false);
  });

  it('never puts the private key in argv for authenticated commands', async () => {
    const runner = vi.fn<PolymarketCliRunner>(async () => ({
      stdout: '{"orderID":"order-1","status":"matched"}',
      stderr: '',
    }));
    const cli = new PolymarketCli({ privateKey: '0xsecret', runner });

    await cli.marketOrder({ tokenId: '42', side: 'buy', amount: '5' });

    const argv = runner.mock.calls[0]?.[1] ?? [];
    expect(argv.join(' ')).not.toContain('secret');
    expect(argv).toEqual([
      '-o',
      'json',
      'clob',
      'market-order',
      '--token',
      '42',
      '--side',
      'buy',
      '--amount',
      '5',
      '--order-type',
      'FOK',
    ]);
  });

  it('redacts private keys from subprocess errors', async () => {
    const runner = vi.fn<PolymarketCliRunner>(async () => {
      const error = new Error('failed with 0xsecret');
      Object.assign(error, { stderr: 'bad 0xsecret' });
      throw error;
    });
    const cli = new PolymarketCli({ privateKey: '0xsecret', runner });

    await expect(cli.approveSet()).rejects.toThrow('[REDACTED_POLYMARKET_PRIVATE_KEY]');
    await expect(cli.approveSet()).rejects.not.toThrow('0xsecret');
  });

  it('fails authenticated commands when no signer private key is available', async () => {
    const runner = vi.fn<PolymarketCliRunner>();
    const cli = new PolymarketCli({ runner });

    await expect(cli.approveSet()).rejects.toThrow('requires a signer private key');
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports a missing official CLI binary clearly', async () => {
    const runner = vi.fn<PolymarketCliRunner>(async () => {
      const error = new Error('spawn polymarket ENOENT');
      Object.assign(error, { code: 'ENOENT' });
      throw error;
    });
    const cli = new PolymarketCli({ runner });

    await expect(cli.orderBook('1')).rejects.toThrow('Official Polymarket CLI binary not found');
  });

  it('fails closed on non-JSON output', async () => {
    const runner = vi.fn<PolymarketCliRunner>(async () => ({
      stdout: 'Question Price\nWill it rain? 52c',
      stderr: '',
    }));
    const cli = new PolymarketCli({ runner });

    await expect(cli.orderBook('1')).rejects.toThrow('Official Polymarket CLI failed');
  });
});
