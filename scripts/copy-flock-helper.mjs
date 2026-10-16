#!/usr/bin/env node
/**
 * Copy the pinned Linux lock helper next to the bundled signer entries.
 * The signer hashes this file before exec. It is never compiled at runtime.
 */
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const source = 'src/signer/helpers/flock-linux-x64';
const destination = 'dist/helpers/flock-linux-x64';
// Older builds copied a second helper next to the CLI and blew the tarball limit.
const stale = 'dist/signer/helpers/flock-linux-x64';

await rm(stale, { force: true });
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
await chmod(destination, 0o755);
