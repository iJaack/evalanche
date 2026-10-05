#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, latestAuditSummary, maybeWriteJson, parseArgs, readJson } from './release-helpers.mjs';

const run = promisify(execFile);

export async function checkConsumerInstall({ packJsonFile, out } = {}) {
  const packPath = path.resolve(DEFAULT_ROOT, packJsonFile);
  const [pack] = await readJson(packPath);
  const archive = path.join(path.dirname(packPath), pack.filename);
  const { stdout: recipe } = await run('tar', ['-xOf', archive, 'package/security-overrides.json']);
  const overrides = JSON.parse(recipe);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'evalanche-consumer-'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const checks = [];
  try {
    for (const mode of ['plain', 'full', 'omit-optional']) {
      const cwd = path.join(temp, mode);
      await fs.mkdir(cwd);
      await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({
        name: 'evalanche-consumer-check', private: true, ...(mode === 'plain' ? {} : { overrides }),
      }));
      const options = { cwd, timeout: 180_000, maxBuffer: 10_000_000 };
      const install = await run(npm, ['install', archive, '--ignore-scripts', '--omit=dev', ...(mode === 'omit-optional' ? ['--omit=optional'] : [])], options);
      await fs.writeFile(path.join(path.dirname(packPath), `consumer-install-${mode}.log`), install.stdout + install.stderr);
      // Resolve from the consumer directory; no repository overrides or node_modules.
      const smoke = await run(process.execPath, ['--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        import assert from 'node:assert/strict';
        import { Evalanche } from 'evalanche';
        const require = createRequire(process.cwd() + '/package.json');
        assert.equal(typeof require('evalanche').Evalanche, 'function');
        const agent = new Evalanche({ privateKey: '0x' + '1'.repeat(64), network: 'avalanche' });
        assert.equal(agent.getChainInfo().id, 43114);
        const pkgRequire = createRequire(require.resolve('evalanche'));
        assert.throws(() => pkgRequire.resolve('@dydxprotocol/v4-client-js'), { code: 'MODULE_NOT_FOUND' });
        assert.throws(() => pkgRequire.resolve('@avalabs/core-wallets-sdk'), { code: 'MODULE_NOT_FOUND' });
        assert.throws(() => pkgRequire.resolve('@hpke/core'), { code: 'MODULE_NOT_FOUND' });
        const multi = new Evalanche({
          mnemonic: 'test test test test test test test test test test test junk',
          network: 'avalanche',
          multiVM: true,
        });
        const pChain = await multi.pChain();
        assert.equal(pChain.getAddress(), 'P-avax1yljhuvjkmtu0y5ls6kf4exsdd8gea9mp8jd32r');
        const accounts = pkgRequire('@avalanche-sdk/client/accounts');
        const avalancheAccount = accounts.mnemonicsToAvalancheAccount('test test test test test test test test test test test junk');
        const signature = await avalancheAccount.xpAccount.signTransaction(Buffer.from('evalanche offline smoke'));
        assert.equal(signature.length, 132);
        console.log('ESM, CJS, Avalanche boot and signing, legacy Core/HPKE absence, and dYdX removal checks passed');
      `], options);
      let auditOutput;
      try { auditOutput = (await run(npm, ['audit', '--omit=dev', '--json', ...(mode === 'omit-optional' ? ['--omit=optional'] : [])], options)).stdout; }
      catch (error) { if (error.code !== 1 || !error.stdout) throw error; auditOutput = error.stdout; }
      const audit = JSON.parse(auditOutput);
      const counts = latestAuditSummary(audit);
      await fs.writeFile(path.join(path.dirname(packPath), `consumer-audit-${mode}.json`), JSON.stringify(audit, null, 2));
      checks.push({ mode, ok: counts.critical === 0 && counts.high === 0,
        auditGate: 'zero high/critical required',
        audit: counts, smoke: smoke.stdout.trim() });
    }
    const result = { ok: checks.every((check) => check.ok), checkedAt: new Date().toISOString(), filename: pack.filename, checks };
    await maybeWriteJson(out, result);
    if (!result.ok) throw new Error('Consumer package contains high or critical advisories');
    return result;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  checkConsumerInstall({ packJsonFile: args['pack-json'], out: args.out })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
