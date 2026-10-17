import { z } from 'zod';
import { sourceStatusSchema } from './api-schemas';

export const managementOverviewSchema = z.object({
  accounts: z.number().int().nonnegative(),
  activeSessions: z.number().int().nonnegative(),
  pendingContributions: z.number().int().nonnegative(),
  unresolvedRequests: z.number().int().nonnegative(),
  sourceAlerts: z.number().int().nonnegative(),
  publishedCourses: z.number().int().nonnegative(),
  publishedTopics: z.number().int().nonnegative(),
});

export const managementAccountsSchema = z.array(z.object({
  id: z.uuid(), handle: z.string(), role: z.enum(['learner', 'moderator']),
  createdAt: z.number().int(), lastSignIn: z.number().int().nullable(),
  passkeys: z.number().int().nonnegative(), linkedProviders: z.number().int().nonnegative(),
}));

export const managementAuditSchema = z.array(z.object({
  id: z.uuid(), handle: z.string().nullable(), action: z.enum(['publish', 'hide']),
  recordId: z.string().nullable(), createdAt: z.number().int(),
}));

export const managementReferencesSchema = z.array(z.intersection(sourceStatusSchema, z.object({
  title: z.string(), url: z.url(),
})));

export const contentHistorySchema = z.array(z.object({
  id: z.uuid(), lessonId: z.string(), revision: z.number().int().positive(),
  reason: z.string(), createdAt: z.number().int(), editor: z.string().nullable(),
}));
