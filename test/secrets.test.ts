import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileAsync = vi.fn();

vi.mock('child_process', () => ({ execFile: (...args: any[]) => execFileAsync(...args) }));
vi.mock('util', () => ({ promisify: () => execFileAsync }));

describe('resolveAgentSecrets', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.AGENT_PRIVATE_KEY;
    delete process.env.AGENT_MNEMONIC;
  });

  it('parses secret refs', async () => {
    const mod = await import('../src/secrets');
    expect(mod.parseSecretRef('@secret:eva-wallet-key')).toBe('eva-wallet-key');
    expect(mod.parseSecretRef('0xabc')).toBeNull();
  });

  it('returns env source for plain env vars', async () => {
    process.env.AGENT_PRIVATE_KEY = '0xabc';
    const mod = await import('../src/secrets');
    await expect(mod.resolveAgentSecrets()).resolves.toEqual({ privateKey: '0xabc', mnemonic: undefined, source: 'env' });
  });

  it('resolves OpenClaw secret refs when available', async () => {
    process.env.AGENT_PRIVATE_KEY = '@secret:wallet-key';
    execFileAsync
      .mockResolvedValueOnce({ stdout: '1.0.0' })
      .mockResolvedValueOnce({ stdout: '0xresolved' });
    const mod = await import('../src/secrets');
    await expect(mod.resolveAgentSecrets()).resolves.toEqual({ privateKey: '0xresolved', mnemonic: undefined, source: 'openclaw-secrets' });
  });

  it('falls back to keystore when secret ref cannot be resolved', async () => {
    process.env.AGENT_PRIVATE_KEY = '@secret:wallet-key';
    execFileAsync.mockRejectedValue(new Error('missing'));
    const mod = await import('../src/secrets');
    await expect(mod.resolveAgentSecrets()).resolves.toEqual({ source: 'keystore' });
  });

  it('falls back to macOS keychain when env vars are absent', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    execFileAsync.mockResolvedValueOnce({ stdout: '0xkeychain' });

    try {
      const mod = await import('../src/secrets');
      await expect(mod.resolveAgentSecrets()).resolves.toEqual({
        privateKey: '0xkeychain',
        source: 'keychain',
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
