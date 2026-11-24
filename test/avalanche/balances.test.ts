import { describe, expect, it } from 'vitest';
import { bytesToHex } from 'viem';
import { mnemonicToAccount, mnemonicsToAvalancheAccount, privateKeyToAvalancheAccount } from '@avalanche-sdk/client/accounts';
import { AVAX_ASSET_IDS, parseStakedAvax, sumAvaxUtxos } from '../../src/avalanche/provider';
import { getNetworkConfig } from '../../src/utils/networks';

// A real Fuji P-Chain UTXO (platform.getUTXOs, hex encoding) holding 4,983,554 nAVAX.
const FUJI_UTXO = '0x0000da40b5fd62cd77af8b2bd46f31493b8167c1c4fa2632c6ace16efbb0984f11ee000000003d9bdac0ed1d761330cf680efdeb1a42159eb387d6d2950c96f7d28f61bbe2aa0000000700000000004c0b0200000000000000000000000100000001d0d813480bcd7965bd9a92955a083a7ab3d9984746dbc916';
const FUJI_AVAX = AVAX_ASSET_IDS.fuji;

describe('UTXO balances', () => {
  it('decodes a real P-Chain UTXO', () => {
    expect(sumAvaxUtxos([FUJI_UTXO], 'P', FUJI_AVAX)).toBe(4_983_554n);
  });

  it('counts a UTXO once even if a page repeats it', () => {
    expect(sumAvaxUtxos([FUJI_UTXO, FUJI_UTXO], 'P', FUJI_AVAX)).toBe(4_983_554n);
  });

  it('ignores other assets', () => {
    expect(sumAvaxUtxos([FUJI_UTXO], 'P', AVAX_ASSET_IDS.avalanche)).toBe(0n);
  });

  it('includes stakeable-locked outputs and skips outputs without an amount', () => {
    const decoded: Record<string, { getAssetId(): string; output: unknown }> = {
      plain: { getAssetId: () => FUJI_AVAX, output: { amount: () => 10n } },
      locked: { getAssetId: () => FUJI_AVAX, output: { transferOut: { amount: () => 5n } } },
      odd: { getAssetId: () => FUJI_AVAX, output: {} },
    };
    expect(sumAvaxUtxos(['plain', 'locked', 'odd'], 'P', FUJI_AVAX, (hex) => decoded[hex])).toBe(15n);
  });
});

describe('staked AVAX from the Data API', () => {
  it('sums current and pending stake for AVAX only', () => {
    const body = {
      balances: {
        unlockedUnstaked: [{ assetId: FUJI_AVAX, amount: '999' }],
        unlockedStaked: [{ assetId: FUJI_AVAX, amount: '100' }],
        lockedStaked: [{ assetId: FUJI_AVAX, amount: '20' }, { assetId: 'other', amount: '7' }],
        pendingStaked: [{ assetId: FUJI_AVAX, amount: '3' }],
      },
    };
    expect(parseStakedAvax(body, FUJI_AVAX)).toBe(123n);
  });

  it('reads empty or missing stake lists as zero', () => {
    expect(parseStakedAvax({ balances: { unlockedStaked: [] } }, FUJI_AVAX)).toBe(0n);
  });

  it('rejects a malformed response instead of reporting zero', () => {
    expect(() => parseStakedAvax({}, FUJI_AVAX)).toThrow(/Invalid P-Chain balances/);
    expect(() => parseStakedAvax({ balances: { lockedStaked: 'x' } }, FUJI_AVAX)).toThrow(/lockedStaked/);
    expect(() => parseStakedAvax({ balances: { lockedStaked: [{ assetId: FUJI_AVAX, amount: 'abc' }] } }, FUJI_AVAX)).toThrow();
  });
});

describe('Fuji defaults and keys', () => {
  it('uses the official Fuji C-Chain RPC by default', () => {
    expect(getNetworkConfig('fuji').rpcUrl).toBe('https://api.avax-test.network/ext/bc/C/rpc');
  });

  it('derives the EVM signing key that owns the account EVM address', () => {
    const mnemonic = 'test test test test test test test test test test test junk';
    const evmKey = mnemonicToAccount(mnemonic).getHdKey().privateKey!;
    const signing = privateKeyToAvalancheAccount(bytesToHex(evmKey));
    expect(signing.getEVMAddress()).toBe(mnemonicsToAvalancheAccount(mnemonic).getEVMAddress());
  });
});
