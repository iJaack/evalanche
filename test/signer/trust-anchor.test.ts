/**
 * A root-owned trust anchor stops parent ownership checks.
 * A uid 1000 parent above the anchor is allowed. A symlink is not.
 * A box-owned file inside the anchor is still refused.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSignerStateDirectory, readSecureFile } from '../../src/signer/secure-path';

const linux = process.platform === 'linux';

function asRoot(args: string[]): void {
  const cmd = (process.getuid?.() ?? -1) === 0 ? args : ['sudo', '-n', ...args];
  const result = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${cmd.join(' ')} failed`);
  }
}

describe.skipIf(!linux)('signer trust anchor', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) asRoot(['rm', '-rf', root]);
    }
  });

  async function layout() {
    const root = await mkdtemp(join(tmpdir(), 'anchor-'));
    roots.push(root);
    const parent = join(root, 'userparent');
    const anchor = join(parent, 'anchor');
    const state = join(anchor, 'state');
    const config = join(anchor, 'config.json');
    await mkdir(state, { recursive: true });
    await chmod(parent, 0o755);
    await chmod(state, 0o700);
    await writeFile(config, 'ok\n');
    const euid = process.geteuid?.() ?? process.getuid?.() ?? 1000;
    if (euid === 0) asRoot(['chown', '1000:1000', parent]);
    asRoot(['chown', '0:0', anchor, config]);
    asRoot(['chmod', '755', anchor]);
    asRoot(['chmod', '644', config]);
    if (euid === 0) {
      asRoot(['chown', '0:0', state]);
      asRoot(['chmod', '700', state]);
    }
    return { root, parent, anchor, state, config, euid };
  }

  it('accepts a root-owned anchor under a uid 1000 parent and still refuses a box-owned file', async () => {
    const box = await layout();
    await expect(readSecureFile(box.config)).rejects.toThrow(/owned by root/);
    await expect(readSecureFile(box.config, { trustAnchor: box.anchor })).resolves.toBe('ok\n');
    await expect(assertSignerStateDirectory(box.state, { trustAnchor: box.anchor })).resolves.toBeUndefined();
    await expect(assertSignerStateDirectory(box.state)).rejects.toThrow(/owned by root/);

    const planted = join(box.anchor, 'planted.json');
    const staged = join(box.root, 'planted.json');
    await writeFile(staged, 'box\n');
    asRoot(['cp', staged, planted]);
    asRoot(['chown', '1000:1000', planted]);
    await expect(readSecureFile(planted, { trustAnchor: box.anchor })).rejects.toThrow(/owned by root/);
  });

  it('refuses a symlink above the anchor, a world-writable anchor, and a path outside it', async () => {
    const box = await layout();
    const moved = join(box.root, 'moved-anchor');
    asRoot(['mv', box.anchor, moved]);
    await symlink(moved, box.anchor);
    await expect(readSecureFile(join(box.anchor, 'config.json'), { trustAnchor: box.anchor })).rejects.toThrow(/symlink/);

    await rm(box.anchor);
    asRoot(['mv', moved, box.anchor]);
    asRoot(['chmod', '777', box.anchor]);
    await expect(readSecureFile(box.config, { trustAnchor: box.anchor })).rejects.toThrow(/owned by root/);
    asRoot(['chmod', '755', box.anchor]);
    await expect(readSecureFile(join(box.root, 'elsewhere.json'), { trustAnchor: box.anchor })).rejects.toThrow(/outside the trust anchor/);
  });
});
