import { expect, it } from 'vitest';
import { HDNodeWallet, SigningKey, sha256 } from 'ethers';
import { createAvalancheProvider } from '../../src/avalanche/provider';
import { createAvalancheSigner } from '../../src/avalanche/signer';

it('derives stable Avalanche addresses and produces a verifiable offline P-chain signature', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const signer = createAvalancheSigner(mnemonic, await createAvalancheProvider('avalanche'));
  expect(signer.getAddressEVM().toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  expect(signer.getCurrentAddress('P')).toBe('P-avax1yljhuvjkmtu0y5ls6kf4exsdd8gea9mp8jd32r');
  const buffer = Buffer.from('Evalanche offline compatibility check');
  const signed = await signer.signXPTransaction(buffer);
  const key = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/9000'/0'/0/0");
  expect(SigningKey.recoverPublicKey(sha256(buffer), signed)).toBe(key.signingKey.publicKey);
});
