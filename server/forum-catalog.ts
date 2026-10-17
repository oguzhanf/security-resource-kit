import { HTTPException } from 'hono/http-exception';
import { lessons, pageIds, tracks } from '../shared/catalog';
import type { DiscussionThread, ForumCategory } from '../shared/contracts';

export const forumCategories: readonly ForumCategory[] = [
  ...tracks.filter((track) => track.status === 'available').map((track): ForumCategory => ({
    id: track.id, title: track.title, kind: 'course', lessonCount: track.lessonIds.length,
  })),
  { id: 'site', title: 'Site discussions', kind: 'site', lessonCount: 0 },
  { id: 'announcements', title: 'Announcements', kind: 'announcements', lessonCount: 0 },
];

const siteTitles: Record<string, string> = {
  home: 'Overview', about: 'About this project', terms: 'Terms of participation',
  privacy: 'Privacy notice', sources: 'References', roadmap: 'Planned topics', account: 'My account',
};

export function pageDiscussion(pageId: string): DiscussionThread {
  if (!pageIds.has(pageId)) throw new HTTPException(404, { message: 'Discussion page not found.' });
  const lesson = lessons.find((entry) => entry.id === pageId);
  const track = tracks.find((entry) => entry.status === 'available' && pageId === `track-${entry.id}`);
  return {
    id: `page-${pageId}`, forumId: lesson?.trackId || track?.id || 'site', pageId, kind: 'page',
    title: lesson?.title || track?.title || siteTitles[pageId] || pageId, rootCommentId: null,
  };
}

export function requireForum(id: string): ForumCategory {
  const forum = forumCategories.find((entry) => entry.id === id);
  if (!forum) throw new HTTPException(404, { message: 'Discussion category not found.' });
  return forum;
}

export function forumPages(id: string): DiscussionThread[] {
  return [...pageIds].map(pageDiscussion).filter((thread) => thread.forumId === id);
}
