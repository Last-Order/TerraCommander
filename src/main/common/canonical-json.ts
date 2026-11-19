import { createHash } from 'node:crypto';
import type { JsonValue } from '../../shared/json';

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const properties = Object.keys(value)
    .sort()
    .map((key) => {
      const encodedKey = JSON.stringify(key);
      const encodedValue = canonicalJson(value[key] ?? null);
      return `${encodedKey}:${encodedValue}`;
    });

  return `{${properties.join(',')}}`;
}

export function jsonFingerprint(value: JsonValue): string {
  // Equivalent configuration objects must bind identically regardless of property insertion order.
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
