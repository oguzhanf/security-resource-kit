import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import type { AppContext } from './types';

const encoded = z.string().min(1).max(24000).regex(/^[A-Za-z0-9_-]+$/u);
const credentialId = z.string().min(1).max(1400).regex(/^[A-Za-z0-9_-]+$/u);
const attachment = z.enum(['platform', 'cross-platform']).optional();
const extensions = z.object({}).passthrough();

export const handleSchema = z.string().trim().toLowerCase()
  .min(3).max(30).regex(/^[a-z0-9][a-z0-9_-]*$/u)
  .refine((value) => !['admin', 'administrator', 'moderator', 'microsoft', 'support', 'security', 'system'].includes(value), 'Choose a non-reserved handle.');

export const consentSchema = z.object({
  accepted: z.literal(true),
  termsVersion: z.literal(TERMS_VERSION),
  privacyVersion: z.literal(PRIVACY_VERSION),
}).strict();

export const registrationStartSchema = consentSchema.extend({
  handle: handleSchema,
  turnstileToken: z.string().max(2048).optional(),
});

export const registrationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  authenticatorAttachment: attachment,
  clientExtensionResults: extensions,
  response: z.object({
    clientDataJSON: encoded,
    attestationObject: encoded,
    authenticatorData: encoded.optional(),
    transports: z.array(z.string().max(30)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: encoded.optional(),
  }),
});

export const authenticationResponseSchema = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal('public-key'),
  authenticatorAttachment: attachment,
  clientExtensionResults: extensions,
  response: z.object({
    clientDataJSON: encoded,
    authenticatorData: encoded,
    signature: encoded,
    userHandle: encoded.optional(),
  }),
});

export const challengePayloadSchema = z.object({
  userId: z.uuid().optional(),
  handle: handleSchema.optional(),
  termsVersion: z.string().optional(),
  privacyVersion: z.string().optional(),
  sessionHash: z.string().optional(),
}).strict();

export function containsLikelySecret(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}|(?:AccountKey|SharedAccessSignature)\s*=\s*\S{16,}|Bearer\s+[A-Za-z0-9._-]{32,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/iu.test(text);
}

export function hasDisallowedControl(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });
}

const contributionBodySchema = z.string().trim().min(10).max(2000)
    .refine((body) => !hasDisallowedControl(body), 'Control characters are not allowed.')
    .refine((body) => !containsLikelySecret(body), 'Potential secret detected. Use synthetic, redacted examples only.');

export const commentSchema = z.object({
  body: contributionBodySchema,
  // Accepted for older clients only; authenticated contributions never verify or require it.
  turnstileToken: z.string().max(2048).optional(),
}).strict();

export const questionThreadSchema = z.object({
  title: z.string().trim().min(5).max(160)
    .refine((title) => !hasDisallowedControl(title) && !/[\r\n\t]/u.test(title), 'Use a single-line title without control characters.')
    .refine((title) => !containsLikelySecret(title), 'Potential secret detected. Redact the title.'),
  body: contributionBodySchema,
}).strict();

export const attemptSchema = z.object({
  stage: z.enum(['pre', 'post']),
  revision: z.number().int().positive(),
  answers: z.array(z.number().int().min(0).max(10)).min(1).max(10),
}).strict();

export async function readJson<T>(c: AppContext, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json<unknown>();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new HTTPException(400, { message: 'Invalid JSON request.' });
    }
    throw error;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const reason = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ');
    throw new HTTPException(400, { message: reason });
  }
  return parsed.data;
}
