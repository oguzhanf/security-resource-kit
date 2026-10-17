import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { commentResponseSchema, discussionSchema, forumIndexSchema, forumPageSchema } from '../shared/api-schemas';
import type { Comment, DiscussionThread, ForumIndex, ForumPage, SessionInfo, SiteConfig, ThreadSummary } from '../shared/contracts';
import { errorMessage, request } from './api';
import { Discussion } from './Discussion';
import { forumPageId, navigate, PageLink, threadPageId } from './routing';

function postDate(value: number | null): string {
  return value === null ? 'No visible posts' : new Date(value * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function ThreadTable({ threads, caption, attached = false }: { threads: ThreadSummary[]; caption: string; attached?: boolean }) {
  return <table className="resource-table forum-table">
    <caption>{caption}</caption>
    <thead><tr><th>Discussion</th>{attached && <th>Root posts</th>}<th>Latest root post</th></tr></thead>
    <tbody>{threads.map((thread) => <tr key={thread.id}>
      <td><PageLink pageId={threadPageId(thread.forumId, thread.id)}>{thread.title}</PageLink>
        {attached && thread.pageId && <small><PageLink pageId={thread.pageId}>Open attached page</PageLink></small>}</td>
      {attached && <td>{thread.rootPosts}</td>}<td>{postDate(thread.latestPostAt)}</td>
    </tr>)}</tbody>
  </table>;
}

export function ForumsPage({ forumId, threadId, session, config }: {
  forumId: string | null; threadId: string | null; session: SessionInfo; config: SiteConfig | null;
}) {
  const [index, setIndex] = useState<ForumIndex | null>(null);
  const [forum, setForum] = useState<ForumPage | null>(null);
  const [thread, setThread] = useState<DiscussionThread | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [activity, setActivity] = useState<Comment[] | null>(null);
  const [activityView, setActivityView] = useState<'mine' | 'replies'>('mine');
  const matches = (value: string) => value.toLowerCase().includes(filter.trim().toLowerCase());

  async function loadActivity(view: 'mine' | 'replies') {
    setBusy(true);
    setError('');
    try {
      setActivity(await request(`/community/activity?view=${view}`, z.array(commentResponseSchema)));
      setActivityView(view);
    } catch (failure) { setActivity(null); setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [categories, category] = await Promise.all([
          request('/forums', forumIndexSchema, { signal: controller.signal }),
          forumId && !threadId ? request(`/forums/${forumId}`, forumPageSchema, { signal: controller.signal }) : null,
        ]);
        if (!controller.signal.aborted) {
          if (forumId && !categories.categories.some((entry) => entry.id === forumId)) throw new Error('Discussion category not found.');
          setIndex(categories);
          setForum(category);
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [forumId, threadId]);

  const threadLoaded = useCallback((value: DiscussionThread) => {
    setThread(value);
    if (forumId !== value.forumId) navigate(threadPageId(value.forumId, value.id));
  }, [forumId]);

  async function createThread() {
    if (!forumId) return;
    setBusy(true);
    setError('');
    try {
      const created = await request(`/forums/${forumId}/threads`, discussionSchema, {
        method: 'POST', csrfToken: session.csrfToken, body: { title, body },
      });
      navigate(threadPageId(created.thread.forumId, created.thread.id));
    } catch (failure) {
      setError(`${errorMessage(failure)} If the connection was interrupted, refresh the category before resubmitting.`);
    } finally { setBusy(false); }
  }

  async function olderThreads() {
    if (!forumId || !forum?.nextCursor) return;
    setBusy(true);
    setError('');
    try {
      const data = await request(`/forums/${forumId}?cursor=${encodeURIComponent(forum.nextCursor)}`, forumPageSchema);
      setForum((previous) => previous ? {
        ...data, threads: [...previous.threads, ...data.threads.filter((entry) => !previous.threads.some((old) => old.id === entry.id))],
      } : data);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  const category = index?.categories.find((entry) => entry.id === forumId);
  const announcement = category?.kind === 'announcements';
  const canCreate = !!index && (!announcement || index.canAnnounce);

  return <article className="forums-page">
    <h1>{threadId ? thread?.title || 'Discussion thread' : forum?.category.title || 'Discussions'}</h1>
    <p className="forum-navigation"><PageLink pageId="discussions">All discussion categories</PageLink>
      {threadId && category && <> / <PageLink pageId={forumPageId(category.id)}>{category.title}</PageLink></>}</p>
    {session.managementLink && <p className="moderation-location"><PageLink pageId="management">Site management / moderate discussions and announcements</PageLink></p>}
    {loading && <p role="status">Loading discussion categories...</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!forumId && index && <>
      <p>Course forums collect their attached page discussions and independent questions. Other published pages belong to Site discussions. Announcements are created by the personal site owner; members may reply.</p>
      <table className="resource-table forum-table">
        <caption>Discussion categories</caption><thead><tr><th>Category</th><th>Contents</th></tr></thead>
        <tbody>{index.categories.map((entry) => <tr key={entry.id}>
          <td><PageLink pageId={forumPageId(entry.id)}>{entry.title}</PageLink></td>
          <td>{entry.kind === 'course' ? `${entry.lessonCount} topics, the course overview, and independent questions`
            : entry.kind === 'site' ? 'Main site pages and independent questions' : 'Owner announcements and moderated member replies'}</td>
        </tr>)}</tbody>
      </table>
      <section className="community-activity">
        <h2>Your discussion activity</h2>
        <p>Review moderation status or find replies to your posts. Only accessible branches appear; hidden ancestors do not grant access through this list.</p>
        <div className="button-row"><button disabled={busy} onClick={() => void loadActivity('mine')}>My contributions</button>
          <button disabled={busy} onClick={() => void loadActivity('replies')}>Replies to my posts</button></div>
        {activity && <><h3>{activityView === 'mine' ? 'Your latest 30 accessible contributions' : 'Latest 30 accessible direct replies'}</h3>
          {activity.length === 0 && <p>No accessible activity.</p>}
          <ul className="activity-list">{activity.map((entry) => <li key={entry.id}>
            <PageLink pageId={threadPageId(entry.forumId, entry.threadId)}>{entry.threadTitle}</PageLink>
            <span className="status-tag">{entry.status}</span><p>{entry.body}</p><small>{postDate(entry.createdAt)} / {entry.parentId ? `reply level ${entry.depth}` : 'root post'}</small>
          </li>)}</ul></>}
      </section>
    </>}
    {forum && !threadId && <>
      <p>Questions and replies are pending until reviewed. Pending or hidden material is visible only to its author, and only through an available parent path. Posts remain inert plain text.</p>
      <label htmlFor="forum-filter">Find a discussion in the loaded list</label>
      <input id="forum-filter" type="search" value={filter} onChange={(event) => setFilter(event.target.value)} maxLength={100} />
      <p className="field-help">Filters titles already loaded on this page. Load older threads to search those titles too.</p>
      {forum.pageDiscussions.length > 0 && <>
        <p>Attached discussions below are the same stored conversations shown on their pages, not copied posts.</p>
        <ThreadTable threads={forum.pageDiscussions.filter((entry) => matches(entry.title))} caption="Attached page discussions" attached />
      </>}
      {forum.threads.length > 0 ? <ThreadTable threads={forum.threads.filter((entry) => matches(entry.title))} caption={announcement ? 'Announcement threads' : 'Independent questions'} />
        : <p className="empty-state">{announcement ? 'No announcements are available.' : 'No independent questions are available.'}</p>}
      {forum.nextCursor && <button disabled={busy} onClick={() => void olderThreads()}>Load older threads</button>}
      {canCreate ? <section className="new-thread">
        <h2>{announcement ? 'Create an announcement' : 'Ask a new question'}</h2>
        <p>Use a precise title and a synthetic scenario or public source. Do not include secrets, personal data, or confidential material.</p>
        {announcement && <p className="field-help">Owner announcements publish immediately and require a sign-in within five minutes. Replies still require moderation.</p>}
        <form className="contribution-form thread-form" onSubmit={(event) => { event.preventDefault(); void createThread(); }}>
          <label htmlFor="thread-title">Title</label>
          <input id="thread-title" value={title} onChange={(event) => setTitle(event.target.value)} minLength={5} maxLength={160} required disabled={busy || session.needsConsent} />
          <label htmlFor="thread-body">Initial post</label>
          <textarea id="thread-body" value={body} onChange={(event) => setBody(event.target.value)} minLength={10} maxLength={2000} rows={5} required disabled={busy || session.needsConsent} />
          <p className="form-footer">{title.length}/160 title characters; {body.length}/2000 post characters.</p>
          <button className="primary" type="submit" disabled={busy || session.needsConsent || !config?.registrationEnabled}>
            {busy ? 'Submitting...' : announcement ? 'Publish announcement' : 'Submit question for moderation'}
          </button>
        </form>
      </section> : announcement && <p className="notice">Only the personal site owner can create announcements. Members may reply to published announcements.</p>}
    </>}
    {threadId && category && !error && <Discussion threadId={threadId} session={session} config={config} onThreadLoaded={threadLoaded} />}
  </article>;
}
