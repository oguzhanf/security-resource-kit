import { z } from 'zod';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';

const descriptor = z.object({
  id: z.string(),
  type: z.literal('public-key'),
  transports: z.array(z.string()).optional(),
});

export const registrationOptionsSchema: z.ZodType<PublicKeyCredentialCreationOptionsJSON> = z.object({
  rp: z.object({ name: z.string(), id: z.string().optional() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
  challenge: z.string(),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number().int() })),
  timeout: z.number().optional(),
  excludeCredentials: z.array(descriptor).optional(),
  authenticatorSelection: z.object({
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    residentKey: z.enum(['discouraged', 'preferred', 'required']).optional(),
    requireResidentKey: z.boolean().optional(),
    userVerification: z.enum(['discouraged', 'preferred', 'required']).optional(),
  }).optional(),
  attestation: z.enum(['none', 'direct', 'indirect', 'enterprise']).optional(),
});

export const authenticationOptionsSchema: z.ZodType<PublicKeyCredentialRequestOptionsJSON> = z.object({
  challenge: z.string(),
  rpId: z.string().optional(),
  timeout: z.number().optional(),
  allowCredentials: z.array(descriptor).optional(),
  userVerification: z.enum(['discouraged', 'preferred', 'required']).optional(),
});
