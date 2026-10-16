#!/usr/bin/env node
/**
 * Copy the pinned Linux lock helper next to the bundled signer entries.
 * The signer hashes this file before exec. It is never compiled at runtime.
 */
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const source = 'src/signer/helpers/flock-linux-x64';
const destinations = [
  'dist/helpers/flock-linux-x64',
  'dist/signer/helpers/flock-linux-x64',
];

for (const destination of destinations) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}
