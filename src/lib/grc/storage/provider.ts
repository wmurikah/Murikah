/**
 * The evidence storage provider seam (Build Prompt 51).
 *
 * Evidence used to live in one place decided by Worker secrets: R2 for writes,
 * Google Drive read-through for the legacy files. That is a single-tenant shape.
 * An organisation now chooses and configures its own provider, so the bytes can
 * sit in the customer's own R2 bucket, Google Drive, SharePoint or Dropbox, and
 * one customer's choice says nothing about another's.
 *
 * Everything above this line is provider-agnostic. The evidence layer resolves
 * the acting organisation's active provider and calls these methods; it never
 * learns which one answered. That is the contract that makes adding a fifth
 * provider, or fixing a bug in one, a change to a single file under
 * `storage/providers/` and nowhere else.
 *
 * Two shapes deliberately admit "this provider cannot do that":
 *
 * - `presignedDownloadUrl` and `presignedUploadUrl` return null when the
 *   provider has no such thing. R2 signs a URL and the bytes never touch the
 *   Worker; Drive, Graph and Dropbox authenticate with a bearer token that must
 *   not be handed to a browser, so their bytes stream through the Worker
 *   instead. The caller branches on null rather than each provider pretending.
 * - `markForDeletion` is not `delete`. Governance decides whether bytes may go
 *   (legal holds, retention, Build Prompt 11); a provider is told to act on a
 *   decision already made, and the name keeps that boundary visible.
 *
 * No imports, so node strips the types and the unit tests run this directly.
 */

/** The provider codes. Stored in `storage_connections.provider`. */
export const PROVIDERS = ['r2', 'google_drive', 'sharepoint', 'dropbox'] as const;
export type ProviderCode = (typeof PROVIDERS)[number];

export function isProviderCode(value: string): value is ProviderCode {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** A folder in the provider's own namespace, for the folder picker. */
export interface StorageFolder {
  /** The provider's own identifier: a key prefix, a Drive id, a Graph item id, a Dropbox path. */
  id: string;
  name: string;
  /** A readable path for the picker, when the provider has one. */
  path?: string;
}

/** Where an object lives: which provider, and that provider's own key. */
export interface StoredObjectRef {
  /** The provider code that holds the bytes, or a legacy backend name. */
  backend: string;
  /** The provider-specific key: an R2 object key, a Drive file id, a Dropbox path. */
  key: string;
}

export interface PutMeta {
  contentType: string;
  /** The original filename, for the providers that store a name rather than a path. */
  fileName?: string;
}

export interface ObjectHead {
  size: number;
}

/** The outcome of a connection test, as the settings screen reports it. */
export type TestResult = { ok: true; detail: string } | { ok: false; error: string };

export interface StorageProvider {
  readonly provider: ProviderCode;

  /**
   * Prove the connection end to end by writing and removing a probe object. A
   * credential that reads but cannot write is a connection that will fail on the
   * first upload, so the test writes: anything less reports a false green.
   */
  testConnection(): Promise<TestResult>;

  /** The folders available to the connected account, for the picker. */
  listFolders(parent?: string): Promise<StorageFolder[]>;

  put(
    key: string,
    bytes: ArrayBuffer | Uint8Array | ReadableStream,
    meta: PutMeta,
  ): Promise<StoredObjectRef>;

  get(key: string): Promise<ReadableStream>;

  head(key: string): Promise<ObjectHead | null>;

  /**
   * A short-lived URL the browser may fetch directly, or null when the provider
   * cannot issue one without exposing a credential. Null means "stream it
   * through the Worker instead", which the download route already handles.
   */
  presignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string | null>;

  /** The same for an upload, or null when the bytes must be posted to the Worker. */
  presignedUploadUrl(key: string, expiresInSeconds: number): Promise<string | null>;

  /**
   * Remove the bytes. Only ever called by the governed deletion path, which has
   * already checked legal holds and retention (Build Prompt 11).
   */
  markForDeletion(key: string): Promise<void>;
}

/** One configurable field of a provider, as the settings form renders it. */
export interface ProviderField {
  name: string;
  label: string;
  /** True for a credential: masked on the screen, never returned in full. */
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
}

export interface ProviderDefinition {
  code: ProviderCode;
  name: string;
  /** How the admin connects: fill in fields, or complete an OAuth consent. */
  kind: 'fields' | 'oauth';
  description: string;
  /** The fields the admin fills in. Empty for the OAuth providers. */
  fields: readonly ProviderField[];
  /** What the folder means for this provider, for the picker's label. */
  folderLabel: string;
  /** Where the one-time app registration is documented. */
  setupDoc: string;
}

/**
 * The provider catalogue. The settings screen renders from this, so adding a
 * provider adds a row here and a module under `providers/`, and touches no
 * screen code.
 */
export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    code: 'r2',
    name: 'Cloudflare R2',
    kind: 'fields',
    description:
      'S3-compatible object storage. The bytes move directly between the browser and R2 on a signed URL, so they never pass through this application.',
    fields: [
      { name: 'account_id', label: 'Account ID', placeholder: 'Cloudflare account id' },
      { name: 'bucket', label: 'Bucket', placeholder: 'evidence' },
      { name: 'access_key_id', label: 'Access key ID', secret: true },
      { name: 'secret_access_key', label: 'Secret access key', secret: true },
      {
        name: 'endpoint',
        label: 'Endpoint',
        optional: true,
        placeholder: 'https://<account>.r2.cloudflarestorage.com',
        hint: 'Leave blank to derive it from the account id.',
      },
    ],
    folderLabel: 'Key prefix',
    setupDoc: 'grc/docs/storage-setup.md',
  },
  {
    code: 'google_drive',
    name: 'Google Drive',
    kind: 'oauth',
    description:
      'Connect a Google account once. Evidence is written as files in the folder you choose; the refresh token is sealed and never shown.',
    fields: [],
    folderLabel: 'Drive folder',
    setupDoc: 'grc/docs/storage-setup.md',
  },
  {
    code: 'sharepoint',
    name: 'SharePoint / OneDrive',
    kind: 'oauth',
    description:
      'Connect a Microsoft account once, through Graph. Evidence is written to the drive and folder you choose.',
    fields: [],
    folderLabel: 'Document library folder',
    setupDoc: 'grc/docs/storage-setup.md',
  },
  {
    code: 'dropbox',
    name: 'Dropbox',
    kind: 'oauth',
    description:
      'Connect a Dropbox account once. Evidence is written under the folder path you choose.',
    fields: [],
    folderLabel: 'Dropbox folder',
    setupDoc: 'grc/docs/storage-setup.md',
  },
];

export function providerDefinition(code: string): ProviderDefinition | null {
  return PROVIDER_DEFINITIONS.find((p) => p.code === code) ?? null;
}

/**
 * Mask a stored credential for display: enough to recognise which key is in
 * place, never enough to use it. Short values are masked entirely rather than
 * having a "tail" that is most of the secret.
 */
export function maskSecret(value: string): string {
  if (value === '') return '';
  if (value.length <= 8) return '••••••••';
  return `••••••••${value.slice(-4)}`;
}

/**
 * The config as the settings screen may see it: every field declared secret is
 * replaced by its mask. Nothing else in the app hands a stored credential to a
 * template, so this is the one place the decision is made.
 */
export function maskConfig(code: string, config: Record<string, string>): Record<string, string> {
  const def = providerDefinition(code);
  const secrets = new Set((def?.fields ?? []).filter((f) => f.secret).map((f) => f.name));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    // The OAuth token is never a declared field, and must never reach a screen.
    out[k] = secrets.has(k) || k === 'refresh_token' ? maskSecret(v) : v;
  }
  return out;
}

/** The fields a provider requires that the submitted config does not carry. */
export function missingFields(code: string, config: Record<string, string>): string[] {
  const def = providerDefinition(code);
  if (!def) return [];
  return def.fields
    .filter((f) => !f.optional && (config[f.name] ?? '').trim() === '')
    .map((f) => f.label);
}
