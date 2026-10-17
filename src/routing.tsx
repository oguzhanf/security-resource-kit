import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes } from 'react';
import { lessonStepPath } from '../shared/lesson-flow';

const paths = new Map<string, string>([
  ['home', '/'],
  ['about', '/about'],
  ['terms', '/terms'],
  ['privacy', '/privacy'],
  ['contact', '/contact'],
  ['sources', '/sources'],
  ['roadmap', '/roadmap'],
  ['account', '/account'],
  ['management', '/management'],
  ['discussions', '/discussions'],
]);

export function forumPageId(forumId: string): string {
  return `forum:${forumId}`;
}

export function threadPageId(forumId: string, threadId: string): string {
  return `thread:${forumId}:${threadId}`;
}

export function discussionRoute(pageId: string): { forumId: string | null; threadId: string | null } | null {
  if (pageId === 'discussions') return { forumId: null, threadId: null };
  const forum = /^forum:([a-z0-9-]+)$/u.exec(pageId);
  if (forum?.[1]) return { forumId: forum[1], threadId: null };
  const thread = /^thread:([a-z0-9-]+):([a-z0-9-]+)$/u.exec(pageId);
  return thread?.[1] && thread[2] ? { forumId: thread[1], threadId: thread[2] } : null;
}

export function pathFor(pageId: string): string {
  const fixed = paths.get(pageId);
  if (fixed) return fixed;
  const discussion = discussionRoute(pageId);
  if (discussion?.forumId) return `/discussions/${discussion.forumId}${discussion.threadId ? `/${discussion.threadId}` : ''}`;
  if (/^track-[a-z0-9-]+$/u.test(pageId)) return `/tracks/${pageId.slice(6)}`;
  if (/^[a-z0-9-]+$/u.test(pageId)) return `/learn/${pageId}`;
  return '/';
}

function currentPage(): string {
  const pathname = window.location.pathname.replace(/\/+$/u, '') || '/';
  const fixed = [...paths].find(([, path]) => path === pathname)?.[0];
  if (fixed) return fixed;
  const discussion = /^\/discussions\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?$/u.exec(pathname);
  if (discussion?.[1]) return discussion[2] ? threadPageId(discussion[1], discussion[2]) : forumPageId(discussion[1]);
  const lesson = /^\/learn\/([a-z0-9-]+)$/u.exec(pathname)?.[1];
  if (lesson) return lesson;
  const track = /^\/tracks\/([a-z0-9-]+)$/u.exec(pathname)?.[1];
  return track ? `track-${track}` : 'not-found';
}

export function navigate(pageId: string, stepId?: string): void {
  const path = stepId ? lessonStepPath(pageId, stepId) : pathFor(pageId);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== path) {
    window.history.pushState(window.location.pathname === pathFor(pageId) ? window.history.state : null, '', path);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'instant' });
}

export function usePage(): string {
  const [pageId, setPageId] = useState(currentPage);
  useEffect(() => {
    const changed = () => setPageId(currentPage());
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  return pageId;
}

export function PageLink({ pageId, stepId, children, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { pageId: string; stepId?: string }) {
  return <a {...props} href={stepId ? lessonStepPath(pageId, stepId) : pathFor(pageId)} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(pageId, stepId);
  }}>{children}</a>;
}
