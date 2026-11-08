export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Provider configuration is separate from credentials, which stay behind credentialRef. */
export interface ConnectionDefinition {
  id: string;
  provider: string;
  configuration: JsonObject;
  credentialRef?: string | undefined;
}

export interface EntryRef {
  connectionId: string;
  spaceId: string;
  /** Adapter-owned ID, key, or native path. Never normalize it as a universal filesystem path. */
  locator: string;
}

export const storageLabelKeys = ['thisPc', 'localFileSystem', 'myDrive'] as const;
export type StorageLabel = string | { messageKey: (typeof storageLabelKeys)[number] };

export interface Space {
  id: string;
  connectionId: string;
  name: StorageLabel;
  root: EntryRef;
}

export const operations = [
  'list',
  'read',
  'write',
  'createDirectory',
  'remove',
  'copyWithin',
  'moveWithin',
  'rangeRead',
  'conditionalRead',
  'conditionalWrite',
  'resumeWrite',
] as const;

export type StorageOperation = (typeof operations)[number];

export interface CapabilityGuarantees {
  atomic?: boolean | undefined;
  durableRecovery?: boolean | undefined;
}

export interface Capability {
  support: 'supported' | 'unsupported' | 'unknown';
  guarantees?: CapabilityGuarantees | undefined;
}

export type Capabilities = Partial<Record<StorageOperation, Capability>>;

export type CapabilityScope =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'space'; connectionId: string; spaceId: string }
  | { kind: 'entry'; ref: EntryRef };

export interface ContentChecksum {
  algorithm: string;
  value: string;
}

/** Optional metadata remains unknown when absent; consumers must not invent defaults. */
export interface Entry {
  ref: EntryRef;
  name: string;
  kind: 'file' | 'directory' | 'link' | 'other';
  size?: number | undefined;
  modifiedAt?: string | undefined;
  revision?: string | undefined;
  mediaType?: string | undefined;
  checksums?: ContentChecksum[] | undefined;
  capabilities: Capabilities;
}

export interface ByteRange {
  offset: number;
  /** A byte count, not an inclusive end position. Absence means read through EOF. */
  length?: number | undefined;
}

export interface ReadOptions {
  range?: ByteRange | undefined;
  expectedRevision?: string | undefined;
}

export interface ListRequest {
  pageSize?: number | undefined;
  cursor?: string | undefined;
}

export interface EntryPage {
  entries: Entry[];
  /** A page can be empty and still provide a continuation cursor. */
  nextCursor?: string;
}

export interface CreateTarget {
  parent: EntryRef;
  name: string;
}

export interface CreateWriteTarget extends CreateTarget {
  kind: 'create';
  policy: 'create-only';
}

export interface ReplaceWriteTarget {
  kind: 'replace';
  ref: EntryRef;
  policy: 'replace-unconditionally';
}

export interface ConditionalWriteTarget {
  kind: 'replace';
  ref: EntryRef;
  policy: 'replace-if-version';
  expectedRevision: string;
}

/** Every write explicitly chooses creation or replacement; adapters cannot silently overwrite. */
export type WriteTarget = CreateWriteTarget | ReplaceWriteTarget | ConditionalWriteTarget;

export interface SourceDescriptor {
  identity: string;
  revision: string;
  size: number;
  /** A weak descriptor requires an independent verification callback before recovery. */
  verification: 'strong' | 'weak';
}

export type UploadState =
  | 'created'
  | 'active'
  | 'suspended'
  | 'completed'
  | 'expired'
  | 'discarded'
  | 'unknown';

export interface UploadProgress {
  processedBytes: number;
  confirmedBytes: number;
}

export interface UploadStatus {
  id: string;
  state: UploadState;
  progress: UploadProgress;
  totalBytes: number;
  entry?: Entry;
}

export interface DiscardResult {
  cleanup: 'complete' | 'pending' | 'unsupported';
}
