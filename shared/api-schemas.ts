import { z } from 'zod';
import { DISCUSSION_MAX_DEPTH, DISCUSSION_PAGE_SIZE } from './contracts';
import type {
  Comment, CommentAncestor, DiscussionPage, DiscussionThread, ForumCategory, ForumIndex, ForumPage,
  PrivateContactRequest, Progress, SessionInfo, SiteConfig, SourceStatus, ThreadSummary,
} from './contracts';
import type { MemberCatalog, PublicTrack } from './content-types';
import { lessonSchema } from './content-schemas';

export const progressSchema: z.ZodType<Progress> = z.object({
  lessonId: z.string(),
  revision: z.number().int().positive(),
  preAnswers: z.array(z.number().int()),
  preScore: z.number().int(),
  postAnswers: z.array(z.number().int()).nullable(),
  postScore: z.number().int().nullable(),
  completedAt: z.number().int().nullable(),
});

export const sessionSchema: z.ZodType<SessionInfo> = z.object({
  user: z.object({ id: z.uuid(), handle: z.string(), role: z.enum(['learner', 'moderator']) }).nullable(),
  csrfToken: z.string().nullable(),
  authenticatedAt: z.number().optional(),
  expiresAt: z.number().optional(),
  needsConsent: z.boolean().optional(),
  authMethods: z.array(z.enum(['passkey', 'microsoft', 'github'])),
  managementLink: z.object({ href: z.literal('/management'), label: z.literal('Site management') }).optional(),
});

export const configSchema: z.ZodType<SiteConfig> = z.object({
  environment: z.enum(['local', 'production']),
  registrationEnabled: z.boolean(),
  turnstileSiteKey: z.string(),
  operatorName: z.string(),
  contactUrl: z.string(),
  termsVersion: z.string(),
  privacyVersion: z.string(),
  authProviders: z.array(z.object({ id: z.enum(['microsoft', 'github']), name: z.string() })),
});

export const socialAuthorizationSchema = z.object({
  provider: z.enum(['microsoft', 'github']),
  authorizationUrl: z.url(),
}).refine((value) => {
  const url = new URL(value.authorizationUrl);
  return !url.username && !url.password && !url.port &&
    (value.provider === 'github'
      ? url.origin === 'https://github.com' && url.pathname === '/login/oauth/authorize'
      : url.origin === 'https://login.microsoftonline.com' && url.pathname === '/common/oauth2/v2.0/authorize');
}, 'The sign-in destination is not an approved identity provider.');

const contributionStatus = z.enum(['pending', 'published', 'hidden', 'removed']);
const threadKind = z.enum(['page', 'question', 'announcement']);

export const commentAncestorSchema: z.ZodType<CommentAncestor> = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  depth: z.number().int().min(0).max(DISCUSSION_MAX_DEPTH),
  handle: z.string(),
  body: z.string(),
  status: contributionStatus,
});

export const commentResponseSchema: z.ZodType<Comment> = z.object({
  id: z.uuid(),
  pageId: z.string().nullable(),
  threadId: z.string(),
  forumId: z.string(),
  threadTitle: z.string(),
  threadKind,
  parentId: z.uuid().nullable(),
  depth: z.number().int().min(0).max(DISCUSSION_MAX_DEPTH),
  replyCount: z.number().int().nonnegative(),
  handle: z.string(),
  body: z.string(),
  status: contributionStatus,
  createdAt: z.number().int(),
  own: z.boolean(),
  reports: z.number().int().optional(),
  reportReasons: z.array(z.string()).max(10).optional(),
  ancestors: z.array(commentAncestorSchema).max(DISCUSSION_MAX_DEPTH).optional(),
}).refine((comment) => (comment.parentId === null) === (comment.depth === 0), 'Invalid reply depth.')
  .refine((comment) => comment.status !== 'removed' || (comment.body === '' && !comment.own), 'Removed content must be anonymous and empty.')
  .refine((comment) => comment.threadKind === 'page' ? comment.pageId !== null : comment.pageId === null, 'Invalid attached-page context.')
  .refine((comment) => !comment.ancestors || (comment.ancestors.length === comment.depth &&
    comment.ancestors.every((ancestor, index) => ancestor.depth === index &&
      ancestor.parentId === (index ? comment.ancestors?.[index - 1]?.id : null)) &&
    (comment.depth === 0 || comment.ancestors.at(-1)?.id === comment.parentId)), 'Incomplete or reordered parent context.');

export const discussionThreadSchema: z.ZodType<DiscussionThread> = z.object({
  id: z.string(), forumId: z.string(), pageId: z.string().nullable(), kind: threadKind,
  title: z.string(), rootCommentId: z.uuid().nullable(),
}).refine((thread) => thread.kind === 'page'
  ? thread.pageId !== null && thread.id === `page-${thread.pageId}` && thread.rootCommentId === null
  : thread.pageId === null && thread.rootCommentId !== null && z.uuid().safeParse(thread.id).success, 'Invalid discussion identity.');

export const discussionSchema: z.ZodType<DiscussionPage> = z.object({
  thread: discussionThreadSchema,
  comments: z.array(commentResponseSchema).max(DISCUSSION_PAGE_SIZE),
  nextCursor: z.string().nullable(),
}).refine((page) => new Set(page.comments.map((comment) => comment.id)).size === page.comments.length &&
  page.comments.every((comment) => comment.threadId === page.thread.id && comment.forumId === page.thread.forumId &&
    comment.pageId === page.thread.pageId && comment.threadKind === page.thread.kind && comment.threadTitle === page.thread.title),
  'Contributions do not match the stored conversation.');

export const forumCategorySchema: z.ZodType<ForumCategory> = z.object({
  id: z.string(), title: z.string(), kind: z.enum(['course', 'site', 'announcements']),
  lessonCount: z.number().int().nonnegative(),
});

export const forumIndexSchema: z.ZodType<ForumIndex> = z.object({
  categories: z.array(forumCategorySchema), canAnnounce: z.boolean(),
});

export const threadSummarySchema: z.ZodType<ThreadSummary> = z.object({
  id: z.string(), forumId: z.string(), pageId: z.string().nullable(), kind: threadKind,
  title: z.string(), rootCommentId: z.uuid().nullable(), rootPosts: z.number().int().nonnegative(),
  latestPostAt: z.number().int().nullable(),
});

export const forumPageSchema: z.ZodType<ForumPage> = z.object({
  category: forumCategorySchema, pageDiscussions: z.array(threadSummarySchema),
  threads: z.array(threadSummarySchema).max(DISCUSSION_PAGE_SIZE), nextCursor: z.string().nullable(),
}).refine((page) => page.pageDiscussions.every((thread) => thread.forumId === page.category.id && thread.kind === 'page') &&
  page.threads.every((thread) => thread.forumId === page.category.id && thread.kind !== 'page'), 'Threads do not match their category.');

export const sourceStatusSchema: z.ZodType<SourceStatus> = z.object({
  sourceId: z.string(),
  status: z.enum(['unchanged', 'changed', 'unavailable', 'not-checked']),
  checkedAt: z.number().int().nullable(),
});

export function acknowledgement(key: 'registered' | 'authenticated' | 'added' | 'signedOut' | 'removed' | 'reported' | 'reviewed' | 'accepted' | 'deleted' | 'resolved') {
  return z.object({ [key]: z.literal(true) });
}

export const memberCatalogSchema: z.ZodType<MemberCatalog> = z.object({
  lessons: z.array(lessonSchema),
  tracks: z.array(z.object({
    id: z.string(), title: z.string(), description: z.string(),
    status: z.enum(['available', 'planned']), lessonIds: z.array(z.string()),
  })),
  sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), upstream: z.string() })),
  pageIds: z.array(z.string()),
});

export const publicOutlineSchema: z.ZodType<PublicTrack[]> = z.array(z.object({
  id: z.string(), title: z.string(), status: z.enum(['available', 'planned']),
}).strict());

export const privateContactSchema: z.ZodType<PrivateContactRequest> = z.object({
  id: z.uuid(), replyEmail: z.string().nullable(), message: z.string(),
  status: z.enum(['new', 'resolved']), createdAt: z.number().int(),
});
