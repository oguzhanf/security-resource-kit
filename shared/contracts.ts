export const TERMS_VERSION = '2026-10-08.1';
export const PRIVACY_VERSION = '2026-10-08.1';

export const SOCIAL_PROVIDERS = [
  { id: 'github', name: 'GitHub' },
  { id: 'microsoft', name: 'Microsoft' },
] as const;
export type SocialProviderId = typeof SOCIAL_PROVIDERS[number]['id'];
export type AuthMethod = 'passkey' | SocialProviderId;
export type SocialAuthInput =
  | { intent: 'login' | 'link' | 'reauth' }
  | { intent: 'register'; handle: string; accepted: boolean; termsVersion: string; privacyVersion: string; turnstileToken?: string };

export interface User {
  id: string;
  handle: string;
  role: 'learner' | 'moderator';
}

export interface SessionInfo {
  user: User | null;
  csrfToken: string | null;
  authenticatedAt?: number;
  expiresAt?: number;
  needsConsent?: boolean;
  authMethods: AuthMethod[];
  managementLink?: { href: '/management'; label: 'Site management' };
}

export interface SiteConfig {
  environment: 'local' | 'production';
  registrationEnabled: boolean;
  turnstileSiteKey: string;
  operatorName: string;
  contactUrl: string;
  termsVersion: string;
  privacyVersion: string;
  authProviders: { id: SocialProviderId; name: string }[];
}

export interface Progress {
  lessonId: string;
  revision: number;
  preAnswers: number[];
  preScore: number;
  postAnswers: number[] | null;
  postScore: number | null;
  completedAt: number | null;
}

export interface Comment {
  id: string;
  pageId: string | null;
  threadId: string;
  forumId: string;
  threadTitle: string;
  threadKind: DiscussionThread['kind'];
  parentId: string | null;
  depth: number;
  replyCount: number;
  handle: string;
  body: string;
  status: 'pending' | 'published' | 'hidden' | 'removed';
  createdAt: number;
  own: boolean;
  reports?: number;
  reportReasons?: string[];
  ancestors?: CommentAncestor[];
}

export interface CommentAncestor {
  id: string;
  parentId: string | null;
  depth: number;
  handle: string;
  body: string;
  status: Comment['status'];
}

export const DISCUSSION_MAX_DEPTH = 16;
export const DISCUSSION_PAGE_SIZE = 30;

export interface ForumCategory {
  id: string;
  title: string;
  kind: 'course' | 'site' | 'announcements';
  lessonCount: number;
}

export interface DiscussionThread {
  id: string;
  forumId: string;
  pageId: string | null;
  kind: 'page' | 'question' | 'announcement';
  title: string;
  rootCommentId: string | null;
}

export interface ThreadSummary extends DiscussionThread {
  rootPosts: number;
  latestPostAt: number | null;
}

export interface ForumIndex {
  categories: ForumCategory[];
  canAnnounce: boolean;
}

export interface ForumPage {
  category: ForumCategory;
  pageDiscussions: ThreadSummary[];
  threads: ThreadSummary[];
  nextCursor: string | null;
}

export interface DiscussionPage {
  thread: DiscussionThread;
  comments: Comment[];
  nextCursor: string | null;
}

export interface SourceStatus {
  sourceId: string;
  status: 'unchanged' | 'changed' | 'unavailable' | 'not-checked';
  checkedAt: number | null;
}

export interface PrivateContactRequest {
  id: string;
  replyEmail: string | null;
  message: string;
  status: 'new' | 'resolved';
  createdAt: number;
}
