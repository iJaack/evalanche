/** Bitcoin-alphabet base58 for Solana's public 32-byte values. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode bytes, preserving each leading zero as a leading "1". */
export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }
  return encoded;
}

/** Decode only canonical base58 encodings of exactly 32 bytes. */
export function decodeBase58(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) {
    throw new Error('base58 public key or blockhash must encode 32 bytes');
  }
  let number = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('Invalid base58 character');
    number = number * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (number > 0n) {
    body.push(Number(number & 255n));
    number >>= 8n;
  }
  let zeros = 0;
  while (value[zeros] === '1') zeros += 1;
  const decoded = Uint8Array.from([...new Array<number>(zeros).fill(0), ...body.reverse()]);
  if (decoded.length !== 32 || encodeBase58(decoded) !== value) {
    throw new Error('Non-canonical base58 public key or blockhash; expected 32 bytes');
  }
  return decoded;
}
