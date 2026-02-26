import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentKeystore } from '../../src/wallet/keystore';
import { Evalanche } from '../../src/agent';

describe('AgentKeystore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'evalanche-keystore-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should generate and persist a new wallet on first init', async () => {
    const store = new AgentKeystore({ dir: tempDir });
    const result = await store.init();

    expect(result.isNew).toBe(true);
    expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.keystorePath).toContain(tempDir);
  });

  it('should load existing wallet on subsequent init', async () => {
    const store = new AgentKeystore({ dir: tempDir });

    const first = await store.init();
    expect(first.isNew).toBe(true);

    const second = await store.init();
    expect(second.isNew).toBe(false);
    expect(second.address).toBe(first.address);
  });

  it('should encrypt at rest — keystore file is not plaintext', async () => {
    const store = new AgentKeystore({ dir: tempDir });
    await store.init();

    const { readFile } = await import('fs/promises');
    const contents = await readFile(join(tempDir, 'agent.json'), 'utf-8');
    const parsed = JSON.parse(contents);

    // ethers v6 keystore format uses capital-C 'Crypto'
    expect(parsed).toHaveProperty('Crypto');
    expect(parsed).toHaveProperty('version', 3);
    // Should NOT contain plaintext mnemonic or key
    expect(contents).not.toContain('test test test');
  });

  it('should load and decrypt correctly', async () => {
    const store = new AgentKeystore({ dir: tempDir });
    await store.init();

    const wallet = await store.load();
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(wallet.privateKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('should export mnemonic for backup', async () => {
    const store = new AgentKeystore({ dir: tempDir });
    await store.init();

    const mnemonic = await store.exportMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(12);
  });

  it('should support custom filename', async () => {
    const store = new AgentKeystore({ dir: tempDir, filename: 'myagent.json' });
    const result = await store.init();

    expect(result.keystorePath).toContain('myagent.json');

    const { access } = await import('fs/promises');
    await expect(access(join(tempDir, 'myagent.json'))).resolves.toBeUndefined();
  });

  it('should set restrictive file permissions (0o600)', async () => {
    const store = new AgentKeystore({ dir: tempDir });
    await store.init();

    const { stat } = await import('fs/promises');
    const keystoreStat = await stat(join(tempDir, 'agent.json'));
    const entropyStat = await stat(join(tempDir, '.agent.json.entropy'));

    // Check owner-only read/write (0o600 = 33152 in decimal, mode & 0o777 = 0o600)
    expect(keystoreStat.mode & 0o777).toBe(0o600);
    expect(entropyStat.mode & 0o777).toBe(0o600);
  });
});

describe('Evalanche.boot()', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'evalanche-boot-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should boot a new agent autonomously', async () => {
    const { agent, keystore } = await Evalanche.boot({
      network: 'fuji',
      keystore: { dir: tempDir },
    });

    expect(keystore.isNew).toBe(true);
    expect(agent.address).toBe(keystore.address);
    expect(agent.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(agent.provider).toBeDefined();
  });

  it('should reload the same agent on second boot', async () => {
    const { agent: first } = await Evalanche.boot({
      network: 'fuji',
      keystore: { dir: tempDir },
    });

    const { agent: second, keystore } = await Evalanche.boot({
      network: 'fuji',
      keystore: { dir: tempDir },
    });

    expect(keystore.isNew).toBe(false);
    expect(second.address).toBe(first.address);
  });

  it('should support signing after boot', async () => {
    const { agent } = await Evalanche.boot({
      network: 'fuji',
      keystore: { dir: tempDir },
    });

    const sig = await agent.signMessage('hello from autonomous agent');
    expect(sig).toMatch(/^0x/);
    expect(sig.length).toBe(132); // 65 bytes hex-encoded + 0x
  });
});
