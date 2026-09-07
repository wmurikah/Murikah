/**
 * The only AI credentials and destinations the CMS is allowed to use.
 *
 * SECURITY BOUNDARY. Provider rows are administrator-managed data. They must
 * never be able to choose an arbitrary Worker environment key or an arbitrary
 * network destination, because that combination turns provider configuration
 * into a secret-exfiltration primitive.
 *
 * The allowlist therefore lives in application code, not in the database:
 * - a provider type selects exactly one Worker secret NAME;
 * - the same provider type selects exactly one outbound endpoint;
 * - legacy/custom rows that do not match this policy fail closed before fetch.
 *
 * Azure OpenAI, Google and OTHER remain unsupported here until they have their
 * own explicit endpoint/credential policy. They must not inherit OpenAI's
 * request shape through a caller-supplied URL.
 */

export const APPROVED_AI_PROVIDER_TYPES = ['ANTHROPIC', 'OPENAI'] as const;
export type ApprovedAiProviderType = (typeof APPROVED_AI_PROVIDER_TYPES)[number];

export interface ApprovedAiProviderPolicy {
  readonly providerType: ApprovedAiProviderType;
  readonly secretName: string;
  readonly endpoint: string;
}

const POLICIES: Readonly<Record<ApprovedAiProviderType, ApprovedAiProviderPolicy>> = {
  ANTHROPIC: {
    providerType: 'ANTHROPIC',
    secretName: 'ANTHROPIC_API_KEY',
    endpoint: 'https://api.anthropic.com/v1/messages',
  },
  OPENAI: {
    providerType: 'OPENAI',
    secretName: 'OPENAI_API_KEY',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  },
};

export function approvedAiProviderPolicy(providerType: string): ApprovedAiProviderPolicy | null {
  return (APPROVED_AI_PROVIDER_TYPES as readonly string[]).includes(providerType)
    ? POLICIES[providerType as ApprovedAiProviderType]
    : null;
}

export function isApprovedAiProviderType(value: string): value is ApprovedAiProviderType {
  return approvedAiProviderPolicy(value) !== null;
}

/**
 * Fields written to ai_providers for a newly configured provider.
 *
 * Neither value comes from the request body. The database retains the columns
 * for compatibility, but the administrator no longer selects a secret name or
 * an outbound address.
 */
export function canonicalAiProviderFields(providerType: string): {
  readonly secretName: string;
  readonly baseUrl: null;
} | null {
  const policy = approvedAiProviderPolicy(providerType);
  return policy === null ? null : { secretName: policy.secretName, baseUrl: null };
}

export interface ProviderSecurityShape {
  readonly providerType: string;
  readonly secretName: string;
  readonly baseUrl: string | null;
}

/**
 * Existing database rows must also satisfy the allowlist.
 *
 * This neutralises a malicious or historical row already present before this
 * control was introduced. A custom base URL is accepted only when it is
 * byte-for-byte the canonical endpoint; callModel still uses the code-owned
 * endpoint rather than the row value.
 */
export function providerConfigurationApproved(provider: ProviderSecurityShape): boolean {
  const policy = approvedAiProviderPolicy(provider.providerType);
  if (policy === null) return false;
  if (provider.secretName !== policy.secretName) return false;
  return provider.baseUrl === null || provider.baseUrl === policy.endpoint;
}

/**
 * Whether the one approved secret for this provider is present.
 *
 * The environment is indexed only with an application-owned allowlisted name,
 * never with provider.secretName from the database.
 */
export function approvedProviderSecretPresent(
  provider: ProviderSecurityShape,
  env: Record<string, unknown>,
): boolean {
  if (!providerConfigurationApproved(provider)) return false;
  const policy = approvedAiProviderPolicy(provider.providerType);
  if (policy === null) return false;
  const value = env[policy.secretName];
  return typeof value === 'string' && value !== '';
}
