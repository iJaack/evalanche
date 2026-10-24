/**
 * Strict Ed25519 checks for the verifier key and approval signatures.
 *
 * Node's crypto.verify accepts the identity point: a signature whose R is the
 * identity and whose S is 0 verifies every message under that key. Small-order
 * and non-canonical keys are rejected before they can be pinned. Signatures
 * must use a canonical R and a scalar S below the group order.
 */

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D = mod(-121665n * invert(121666n));

interface Point {
  X: bigint;
  Y: bigint;
  Z: bigint;
  T: bigint;
}

const IDENTITY: Point = { X: 0n, Y: 1n, Z: 1n, T: 0n };

function mod(n: bigint): bigint {
  const r = n % P;
  return r >= 0n ? r : r + P;
}

function invert(n: bigint): bigint {
  return modPow(n, P - 2n);
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function le(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = (n << 8n) + BigInt(bytes[i]);
  return n;
}

function add(p: Point, q: Point): Point {
  const A = mod(p.X * q.X);
  const B = mod(p.Y * q.Y);
  const C = mod(p.T * D * q.T);
  const Dd = mod(p.Z * q.Z);
  const E = mod((p.X + p.Y) * (q.X + q.Y) - A - B);
  const F = mod(Dd - C);
  const G = mod(Dd + C);
  const H = mod(B + A);
  return { X: mod(E * F), Y: mod(G * H), Z: mod(F * G), T: mod(E * H) };
}

function mul(point: Point, scalar: bigint): Point {
  let result = IDENTITY;
  for (let i = 255; i >= 0; i -= 1) {
    result = add(result, result);
    if ((scalar >> BigInt(i)) & 1n) result = add(result, point);
  }
  return result;
}

function isIdentity(point: Point): boolean {
  return mod(point.X) === 0n && mod(point.Y) === mod(point.Z);
}

function decompress(bytes: Uint8Array): Point | null {
  if (bytes.length !== 32) return null;
  const sign = (bytes[31] & 0x80) !== 0;
  const yBytes = Buffer.from(bytes);
  yBytes[31] &= 0x7f;
  const y = le(yBytes);
  if (y >= P) return null;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  let x = mod(u * modPow(v, 3n) * modPow(mod(u * modPow(v, 7n)), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 !== u) {
    if (vx2 !== mod(-u)) return null;
    x = mod(x * modPow(2n, (P - 1n) / 4n));
  }
  if (x === 0n && sign) return null;
  if ((x & 1n) !== (sign ? 1n : 0n)) x = mod(-x);
  const x2 = mod(x * x);
  if (mod(y2 - x2) !== mod(1n + D * x2 * y2)) return null;
  return { X: x, Y: y, Z: 1n, T: mod(x * y) };
}

export function ed25519PointError(bytes: Uint8Array): string | null {
  const point = decompress(bytes);
  if (!point) return 'non-canonical or off-curve Ed25519 point';
  if (isIdentity(mul(point, 8n))) return 'small-order Ed25519 point';
  if (!isIdentity(mul(point, L))) return 'Ed25519 point is not in the prime-order subgroup';
  return null;
}

export function ed25519SignatureError(bytes: Uint8Array): string | null {
  if (bytes.length !== 64) return 'Ed25519 signature must be 64 bytes';
  const R = bytes.subarray(0, 32);
  const point = decompress(R);
  if (!point) return 'non-canonical Ed25519 signature';
  if (isIdentity(mul(point, 8n))) return 'non-canonical Ed25519 signature';
  if (le(bytes.subarray(32)) >= L) return 'non-canonical Ed25519 signature';
  return null;
}
