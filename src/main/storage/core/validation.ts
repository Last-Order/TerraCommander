import { createHash } from 'node:crypto';
import { z } from 'zod';
import { operations, storageLabelKeys, type JsonValue } from '../../../shared/storage/models';
import { StorageError } from './errors';

const identifier = z.string().min(1);

// Byte counts cross JSON boundaries, so values must remain exactly representable as numbers.
export const byteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Adapter results: references and metadata retain native values without path normalization.
export const entryRefSchema = z.strictObject({
  connectionId: identifier,
  spaceId: identifier,
  locator: z.string(),
});
export const capabilitySchema = z.strictObject({
  support: z.enum(['supported', 'unsupported', 'unknown']),
  guarantees: z
    .strictObject({ atomic: z.boolean().optional(), durableRecovery: z.boolean().optional() })
    .optional(),
});
export const capabilitiesSchema = z.partialRecord(z.enum(operations), capabilitySchema);
export const entrySchema = z.strictObject({
  ref: entryRefSchema,
  name: z.string(),
  kind: z.enum(['file', 'directory', 'link', 'other']),
  size: byteCountSchema.optional(),
  modifiedAt: z.iso.datetime({ offset: true }).optional(),
  revision: identifier.optional(),
  mediaType: identifier.optional(),
  checksums: z.array(z.strictObject({ algorithm: identifier, value: identifier })).optional(),
  capabilities: capabilitiesSchema,
});
export const spaceSchema = z.strictObject({
  id: identifier,
  connectionId: identifier,
  name: z.union([z.string(), z.strictObject({ messageKey: z.enum(storageLabelKeys) })]),
  root: entryRefSchema,
});

// Strict request schemas reject accidental options instead of silently ignoring them.
export const createTargetSchema = z.strictObject({ parent: entryRefSchema, name: identifier });
const createWriteTargetSchema = createTargetSchema.extend({
  kind: z.literal('create'),
  policy: z.literal('create-only'),
});
const replaceWriteTargetSchema = z.strictObject({
  kind: z.literal('replace'),
  ref: entryRefSchema,
  policy: z.literal('replace-unconditionally'),
});
const conditionalWriteTargetSchema = z.strictObject({
  kind: z.literal('replace'),
  ref: entryRefSchema,
  policy: z.literal('replace-if-version'),
  expectedRevision: identifier,
});

export const writeTargetSchema = z.union([
  createWriteTargetSchema,
  replaceWriteTargetSchema,
  conditionalWriteTargetSchema,
]);
export const rangeSchema = z
  .strictObject({ offset: byteCountSchema, length: byteCountSchema.optional() })
  .refine(({ offset, length }) => length === undefined || Number.isSafeInteger(offset + length));
export const readOptionsSchema = z.strictObject({
  range: rangeSchema.optional(),
  expectedRevision: identifier.optional(),
});
export const listRequestSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(10000).optional(),
  cursor: identifier.max(65536).optional(),
});
export const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connection'), connectionId: identifier }),
  z.strictObject({ kind: z.literal('space'), connectionId: identifier, spaceId: identifier }),
  z.strictObject({ kind: z.literal('entry'), ref: entryRefSchema }),
]);

// Backend persistence: the common layer validates envelopes, not provider payload semantics.
export const sourceDescriptorSchema = z.strictObject({
  identity: identifier,
  revision: identifier,
  size: byteCountSchema,
  verification: z.enum(['strong', 'weak']),
});
export const progressSchema = z
  .strictObject({ processedBytes: byteCountSchema, confirmedBytes: byteCountSchema })
  .refine((progress) => progress.confirmedBytes <= progress.processedBytes);
export const driverCheckpointSchema = z.strictObject({
  version: z.number().int().positive(),
  payload: z.json(),
});
export const connectionSchema = z.strictObject({
  id: identifier,
  provider: identifier,
  configuration: z.record(z.string(), z.json()),
  credentialRef: identifier.optional(),
});

/** Converts validation failures into safe domain errors without leaking schema input. */
export function parse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: 'InvalidArgument' | 'ResumeInvalid' | 'OutcomeUnknown' = 'InvalidArgument',
): T {
  try {
    const result = schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
  } catch {
    // Cyclic or otherwise invalid values must not escape as raw validation errors.
  }
  throw new StorageError(code);
}

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

export function fingerprint(value: unknown): string {
  const json = parse(z.json(), value);

  // Equivalent configuration objects must bind identically regardless of property insertion order.
  return createHash('sha256').update(canonicalJson(json)).digest('hex');
}
