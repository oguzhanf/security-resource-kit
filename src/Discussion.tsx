import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { acknowledgement, commentResponseSchema, discussionSchema } from '../shared/api-schemas';
import { DISCUSSION_MAX_DEPTH, DISCUSSION_PAGE_SIZE } from '../shared/contracts';
import type { Comment, DiscussionThread, SessionInfo, SiteConfig } from '../shared/contracts';
import { ApiError, errorMessage, request } from './api';
import { forumPageId, PageLink, threadPageId } from './routing';

interface ReplyPage {
  comments: Comment[];
  cursor: string | null;
  expanded: boolean;
  loading: boolean;
  loaded: boolean;
}

type DiscussionProps = {
  session: SessionInfo;
  config: SiteConfig | null;
  onThreadLoaded?: (thread: DiscussionThread) => void;
} & ({ pageId: string; threadId?: never } | { threadId: string; pageId?: never });

function chronological(comments: Comment[]): Comment[] {
  return [...comments].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function mergeComments(previous: Comment[], incoming: Comment[]): Comment[] {
  const entries = new Map(previous.map((comment) => [comment.id, comment]));
  for (const comment of incoming) entries.set(comment.id, comment);
  return [...entries.values()];
}

export function Discussion({ pageId, threadId, session, config, onThreadLoaded }: DiscussionProps) {
  const endpoint = pageId ? `/discussions/${pageId}` : `/threads/${threadId}`;
  const [thread, setThread] = useState<DiscussionThread | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, ReplyPage>>({});
  const [body, setBody] = useState('');
  const [replyId, setReplyId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState('');
  const participationDisabled = busy || !!session.needsConsent || !config?.registrationEnabled;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setComments([]);
    setReplies({});
    setThread(null);
    setCursor(null);
    setReplyId(null);
    setReportId(null);
    setError('');
    request(endpoint, discussionSchema, { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) return;
      setThread(data.thread);
      onThreadLoaded?.(data.thread);
      setComments(data.comments);
      setCursor(data.nextCursor);
      setLoading(false);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); setLoading(false); }
    });
    return () => controller.abort();
  }, [endpoint, session.user?.id, revision, onThreadLoaded]);

  function changedVisibility(failure: unknown) {
    if (failure instanceof ApiError && failure.status === 404) {
      setComments([]);
      setReplies({});
      setThread(null);
    }
  }

  async function submit(parentId: string | null) {
    if (!session.user || (!parentId && !thread?.pageId)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const comment = await request(parentId ? `/comments/${parentId}/replies` : `/discussions/${thread?.pageId}`, commentResponseSchema, {
        method: 'POST', csrfToken: session.csrfToken, body: { body: parentId ? replyBody : body },
      });
      if (parentId) {
        setComments((previous) => previous.map((entry) => entry.id === parentId ? { ...entry, replyCount: entry.replyCount + 1 } : entry));
        setReplies((previous) => {
          const updated = Object.fromEntries(Object.entries(previous).map(([id, page]) => [
            id, { ...page, comments: page.comments.map((entry) => entry.id === parentId ? { ...entry, replyCount: entry.replyCount + 1 } : entry) },
          ]));
          const page = updated[parentId];
          updated[parentId] = {
            comments: chronological(mergeComments(page?.comments || [], [comment])),
            cursor: page?.cursor ?? null, expanded: true, loading: false, loaded: page?.loaded || false,
          };
          return updated;
        });
        setReplyId(null);
        setReplyBody('');
      } else {
        setComments((previous) => [comment, ...previous]);
        setBody('');
      }
      setNotice('Contribution saved for moderation. Only you can see it until it is approved; its parent path must also remain available.');
    } catch (failure) {
      changedVisibility(failure);
      setError(`${errorMessage(failure)} If the connection was interrupted, refresh before resubmitting to avoid a duplicate.`);
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`/comments/${id}`, acknowledgement('removed'), { method: 'DELETE', csrfToken: session.csrfToken });
      setNotice('Your contribution was removed. Other members\' replies keep their original parent context.');
      setRevision((value) => value + 1);
    } catch (failure) { changedVisibility(failure); setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function report() {
    if (!reportId) return;
    setBusy(true);
    setError('');
    try {
      await request(`/comments/${reportId}/report`, acknowledgement('reported'), {
        method: 'POST', csrfToken: session.csrfToken, body: { reason: reportReason },
      });
      setReportId(null);
      setReportReason('');
      setNotice('Report sent to the moderation queue.');
    } catch (failure) { changedVisibility(failure); setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function older() {
    if (!cursor) return;
    setBusy(true);
    setError('');
    try {
      const data = await request(`${endpoint}?cursor=${encodeURIComponent(cursor)}`, discussionSchema);
      setComments((previous) => mergeComments(previous, data.comments));
      setCursor(data.nextCursor);
    } catch (failure) { changedVisibility(failure); setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function loadReplies(comment: Comment, nextCursor?: string) {
    setError('');
    setReplies((previous) => ({
      ...previous,
      [comment.id]: {
        comments: previous[comment.id]?.comments || [], cursor: previous[comment.id]?.cursor || null,
        expanded: true, loading: true, loaded: previous[comment.id]?.loaded || false,
      },
    }));
    try {
      const data = await request(`/comments/${comment.id}/replies${nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`, discussionSchema);
      if (data.thread.id !== comment.threadId || data.comments.some((entry) => entry.parentId !== comment.id || entry.depth !== comment.depth + 1)) {
        throw new Error('The reply relationships could not be validated. Refresh the discussion.');
      }
      setReplies((previous) => ({
        ...previous,
        [comment.id]: {
          comments: chronological(mergeComments(previous[comment.id]?.comments || [], data.comments)),
          cursor: data.nextCursor, expanded: true, loading: false, loaded: true,
        },
      }));
    } catch (failure) {
      setReplies((previous) => ({ ...previous, [comment.id]: { comments: [], cursor: null, expanded: false, loading: false, loaded: false } }));
      changedVisibility(failure);
      setError(errorMessage(failure));
    }
  }

  function toggleReplies(comment: Comment) {
    const page = replies[comment.id];
    if (!page) { void loadReplies(comment); return; }
    setReplies((previous) => ({ ...previous, [comment.id]: { ...page, expanded: !page.expanded } }));
  }

  function renderComment(comment: Comment): ReactNode {
    const page = replies[comment.id];
    const indent = `indent-${Math.min(comment.depth, 6)}`;
    return <Fragment key={comment.id}>
      <li className={`thread-entry ${indent}`}>
        <article className="comment threaded-comment" id={`comment-${comment.id}`} data-comment-id={comment.id} data-depth={comment.depth}>
          <header><strong>{comment.handle}</strong>
            <time dateTime={new Date(comment.createdAt * 1000).toISOString()}>{new Date(comment.createdAt * 1000).toLocaleDateString('en-US', { timeZone: 'UTC' })}</time>
            <span className="reply-level">{comment.parentId ? <>Reply level {comment.depth} / <a href={`#comment-${comment.parentId}`}>parent post</a></> : 'Root post'}</span>
            {comment.status === 'pending' && <span className="status-tag">awaiting moderation / only visible to you</span>}
          </header>
          {comment.status === 'hidden' && <p className="field-help">Hidden by moderation. Only you can see this contribution; new replies are closed on this branch.</p>}
          {comment.status === 'removed'
            ? <p className="field-help">This contribution was removed. Remaining replies retain their original parent.</p>
            : <p className="comment-body">{comment.body}</p>}
          <div className="comment-actions">
            <button className="text-button" disabled={participationDisabled || comment.depth >= DISCUSSION_MAX_DEPTH || comment.status === 'hidden'}
              onClick={() => { setReplyId(comment.id); setReplyBody(''); setReportId(null); }}>Reply</button>
            {comment.own && <button className="text-button" disabled={busy} onClick={() => void remove(comment.id)}>Remove my contribution</button>}
            {!comment.own && comment.status === 'published' && <button className="text-button" disabled={busy}
              onClick={() => { setReportId(comment.id); setReportReason(''); setReplyId(null); }}>Report</button>}
            {(comment.replyCount > 0 || page) && <button className="text-button" disabled={busy || page?.loading}
              aria-expanded={!!page?.expanded} aria-controls={`replies-${comment.id}`} onClick={() => toggleReplies(comment)}>
              {page?.loading ? 'Loading replies...' : page?.expanded ? 'Hide replies' : `View replies (${comment.replyCount})`}
            </button>}
          </div>
          {comment.depth >= DISCUSSION_MAX_DEPTH && <p className="field-help">Maximum reply depth reached. Start a new question in the category instead; replies are never moved to another parent.</p>}
          {replyId === comment.id && <form className="contribution-form reply-form" onSubmit={(event) => { event.preventDefault(); void submit(comment.id); }}>
            <label htmlFor={`reply-${comment.id}`}>Reply as <strong>{session.user?.handle}</strong></label>
            <textarea id={`reply-${comment.id}`} value={replyBody} onChange={(event) => setReplyBody(event.target.value)}
              minLength={10} maxLength={2000} rows={4} required disabled={participationDisabled} />
            <p className="form-footer">{replyBody.length}/2000 characters. Pending until approved; every ancestor must be visible.</p>
            <div className="button-row"><button className="primary" type="submit" disabled={participationDisabled}>Submit reply for moderation</button>
              <button type="button" disabled={busy} onClick={() => setReplyId(null)}>Cancel reply</button></div>
          </form>}
          {reportId === comment.id && <form className="report-form" onSubmit={(event) => { event.preventDefault(); void report(); }}>
            <label htmlFor="report-reason">Reason for moderator review</label>
            <input id="report-reason" value={reportReason} onChange={(event) => setReportReason(event.target.value)} minLength={10} maxLength={300} required disabled={busy} />
            <button type="submit" disabled={busy}>Send report</button><button type="button" onClick={() => setReportId(null)} disabled={busy}>Cancel</button>
          </form>}
        </article>
      </li>
      {page?.expanded && <li className={`reply-group-marker ${indent}`} id={`replies-${comment.id}`} aria-label={`Replies to ${comment.handle}`} />}
      {page?.expanded && page.comments.map(renderComment)}
      {page?.expanded && !page.loaded && <li className={`thread-entry indent-${Math.min(comment.depth + 1, 6)}`}>
        <button disabled={busy || page.loading} onClick={() => void loadReplies(comment)}>Load existing replies to this post</button>
      </li>}
      {page?.expanded && page.cursor && <li className={`thread-entry indent-${Math.min(comment.depth + 1, 6)}`}>
        <button disabled={busy || page.loading} onClick={() => void loadReplies(comment, page.cursor || undefined)}>Load more replies to this post</button>
      </li>}
    </Fragment>;
  }

  return <section className="discussion" aria-labelledby="discussion-heading">
    <div className="section-bar"><span className="icon-discussion" aria-hidden="true" /><h2 id="discussion-heading">{pageId ? 'Discussion' : 'Thread posts'}</h2>
      <span className="small-label">Moderated / maximum reply depth {DISCUSSION_MAX_DEPTH}</span></div>
    <p className="section-intro">Submit questions, corrections, or replies using synthetic examples or public sources. Do not include credentials, customer data, live tokens, or confidential information.</p>
    {thread && <p className="discussion-location">
      <PageLink pageId={forumPageId(thread.forumId)}>Category forum</PageLink>
      {pageId && <> / <PageLink pageId={threadPageId(thread.forumId, thread.id)}>Open this same discussion in the forum</PageLink></>}
      {!pageId && thread.pageId && <> / <PageLink pageId={thread.pageId}>Attached page</PageLink></>}
    </p>}
    <p className="field-help">Root posts load {DISCUSSION_PAGE_SIZE} at a time, newest first. Expand replies to load {DISCUSSION_PAGE_SIZE} direct children at a time, oldest first. Indentation is capped; reply levels and parent links preserve the full tree.</p>
    <button disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>Refresh discussion</button>
    {loading && <p role="status">Loading this discussion...</p>}
    {!loading && !error && comments.length === 0 && <p className="empty-state">No comments have been posted.</p>}
    <ol className="comment-list thread-list">{comments.map(renderComment)}</ol>
    {cursor && <button disabled={busy} onClick={() => void older()}>Load older contributions</button>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success-notice" role="status">{notice}</p>}
    {session.needsConsent && <p className="notice">Accept the updated policies in My account before contributing.</p>}
    {thread?.kind === 'page' && session.user && <form className="contribution-form" onSubmit={(event) => { event.preventDefault(); void submit(null); }}>
      <label htmlFor="contribution">Contribute as <strong>{session.user.handle}</strong></label>
      <textarea id="contribution" value={body} onChange={(event) => setBody(event.target.value)} minLength={10} maxLength={2000} rows={4} required
        disabled={participationDisabled} placeholder="Use a synthetic scenario or public source. State the question or correction precisely." />
      <div className="form-footer"><span>{body.length}/2000 characters. Pending until a moderator approves.</span></div>
      <button className="primary" type="submit" disabled={participationDisabled}>{busy ? 'Submitting...' : 'Submit for moderation'}</button>
    </form>}
  </section>;
}
