import { z } from 'zod';
import type { AccountErrorCode } from '../../../../../shared/accounts';
import { assertNotCancelled, AccountError } from '../../../core/errors';

const providerFailureSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  response: z
    .object({
      status: z.number(),
      data: z.unknown().optional(),
    })
    .optional(),
});
const providerBodySchema = z.object({
  error: z
    .union([z.string(), z.object({ errors: z.array(z.object({ reason: z.string() })).optional() })])
    .optional(),
});

export function googleRequestError(error: unknown, signal?: AbortSignal): AccountError {
  assertNotCancelled(signal);
  if (error instanceof AccountError) return error;
  const parsed = providerFailureSchema.safeParse(error);
  const failure = parsed.success ? parsed.data : undefined;
  const response = failure?.response;
  const body = providerBodySchema.safeParse(response?.data);
  const providerError = body.success ? body.data.error : undefined;
  const code = typeof providerError === 'string' ? providerError : undefined;
  const reasons =
    typeof providerError === 'object'
      ? (providerError.errors?.map((entry) => entry.reason) ?? [])
      : [];

  let category: AccountErrorCode = 'NetworkError';
  if (code === 'invalid_grant' || response?.status === 401) category = 'AuthRequired';
  else if (['invalid_client', 'deleted_client', 'unauthorized_client'].includes(code ?? '')) {
    category = 'ClientConfigurationInvalid';
  } else if (code === 'access_denied') category = 'AccessDenied';
  else if (code === 'admin_policy_enforced' || code === 'org_internal') category = 'AccessBlocked';
  else if (reasons.some((reason) => ['accessNotConfigured', 'serviceDisabled'].includes(reason))) {
    category = 'ApiDisabled';
  } else if (reasons.includes('insufficientPermissions')) category = 'InsufficientScope';
  else if (
    response?.status === 429 ||
    reasons.some((reason) => /ratelimit|quota|dailylimit/i.test(reason))
  ) {
    category = 'RateLimited';
  } else if (response?.status === 403) category = 'AccessBlocked';
  else if (['ETIMEDOUT', 'ECONNABORTED', 'TimeoutError'].includes(String(failure?.code)))
    category = 'Timeout';
  else if (response && response.status < 500) category = 'InvalidResponse';

  return new AccountError(category, error);
}
