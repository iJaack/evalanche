import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let offlineFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  offlineFetch = vi.fn(() => { throw new Error('offline PR2 pending test: fetch forbidden'); }); vi.stubGlobal('fetch', offlineFetch);
});
afterEach(() => { try { expect(offlineFetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });

describe('PR2 pending Giacomo decisions and custody implementation evidence', () => {
  it.todo('final per-mint and native tokenCaps: explicit owner-approved raw-unit caps');
  it.todo('key custody init command: 0600 file, O_EXCL, no symlinks, checked descriptors, file/directory fsync, only pubkey printed');
  it.todo('age-encrypted escrow export without plaintext secret, seed or key material in logs');
  it.todo('restore refuses a derived pubkey mismatch and never regenerates a key');
  it.todo('startup rejects EVALANCHE_SIGNER_SOLANA_SECRET_KEY without echoing its value');
  it.todo('native node:crypto Ed25519 treasury signing vector with a runtime-only key');
});
