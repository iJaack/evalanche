/**
 * RFC 8785 JSON Canonicalization Scheme, restricted to the values the signer
 * accepts: NFC strings, safe integers, and objects without prototype keys.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function canonicalJson(value: unknown): string {
  return jcs(value);
}

function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return jcsNumber(value);
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) {
    return `[${value.map((entry) => jcs(entry)).join(',')}]`;
  }
  if (typeof value === 'object') return jcsObject(value as Record<string, unknown>);
  throw new Error('Canonical JSON rejected an unsupported value');
}

function jcsNumber(value: number): string {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
    throw new Error('Canonical JSON rejected a non-integer number; money and nonce must be decimal strings');
  }
  if (Object.is(value, -0)) return '0';
  return JSON.stringify(value);
}

function jcsObject(value: Record<string, unknown>): string {
  const names = Object.getOwnPropertyNames(value);
  for (const key of names) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Forbidden key ${key}`);
    }
  }
  const parts: string[] = [];
  for (const key of names.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) continue;
    parts.push(`${jcs(key)}:${jcs(descriptor.value)}`);
  }
  return `{${parts.join(',')}}`;
}
