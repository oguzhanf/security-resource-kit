import { useEffect, useState } from 'react';
import { z } from 'zod';
import { acknowledgement, commentResponseSchema, privateContactSchema } from '../shared/api-schemas';
import {
  contentHistorySchema, managementAccountsSchema, managementAuditSchema, managementOverviewSchema, managementReferencesSchema,
} from '../shared/management-schemas';
import type { SessionInfo } from '../shared/contracts';
import { ApiError, errorMessage, request } from './api';
import { ContributionContext } from './ContributionContext';
import type { Lesson, MemberCatalog } from '../shared/content-types';
import { ContentEditor } from './ContentEditor';
import { forumPageId, PageLink } from './routing';
import { ISSUE_REPOSITORY } from '../shared/feedback';

const views = [
  ['overview', 'Overview'], ['contributions', 'Discussion review'], ['requests', 'Private requests'],
  ['content', 'Training content'], ['community', 'Forums and announcements'],
  ['accounts', 'Accounts'], ['references', 'References'], ['audit', 'Review history'], ['content-history', 'Content history'],
] as const;
type View = typeof views[number][0];
const dataSchema = z.object({
  overview: managementOverviewSchema, accounts: managementAccountsSchema, audit: managementAuditSchema,
  references: managementReferencesSchema, contributions: z.array(commentResponseSchema), requests: z.array(privateContactSchema),
  contentHistory: contentHistorySchema,
});
type ManagementData = z.infer<typeof dataSchema>;

function timestamp(value: number | null): string {
  return value === null ? 'Not observed' : new Date(value * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export function ManagementPage({ session, catalog, onContentSaved, onSignIn, onRefresh }: {
  session: SessionInfo; onSignIn: () => void; onRefresh: () => Promise<void>;
  catalog: MemberCatalog | null; onContentSaved: (lesson: Lesson) => void;
}) {
  const [view, setView] = useState<View>('overview');
  const [data, setData] = useState<ManagementData | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [contentId, setContentId] = useState('');
  const [editing, setEditing] = useState(false);
  const [reviewFilter, setReviewFilter] = useState('queue');
  const [search, setSearch] = useState('');
  const selectedLesson = catalog?.lessons.find((lesson) => lesson.id === contentId);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    setBusy(true);
    async function load() {
      try {
        const [overview, accounts, audit, references, contributions, requests, contentHistory] = await Promise.all([
          request('/management/overview', managementOverviewSchema, { signal: controller.signal }),
          request('/management/accounts', managementAccountsSchema, { signal: controller.signal }),
          request('/management/audit', managementAuditSchema, { signal: controller.signal }),
          request('/management/references', managementReferencesSchema, { signal: controller.signal }),
          request(`/management/contributions?status=${reviewFilter}`, z.array(commentResponseSchema), { signal: controller.signal }),
          request('/management/requests', z.array(privateContactSchema), { signal: controller.signal }),
          request('/management/content-history', contentHistorySchema, { signal: controller.signal }),
        ]);
        if (!controller.signal.aborted) setData(dataSchema.parse({ overview, accounts, audit, references, contributions, requests, contentHistory }));
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(errorMessage(failure));
          if (failure instanceof ApiError && failure.status === 403) {
            try { await onRefresh(); }
            catch (refreshFailure) { setError(`${errorMessage(failure)} ${errorMessage(refreshFailure)}`); }
          }
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [session.user?.id, session.authenticatedAt, revision, onRefresh, reviewFilter]);

  async function perform(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      setRevision((value) => value + 1);
    } catch (failure) {
      setData(null);
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <article className="management-page">
    <h1>Site management</h1>
    <p>Training content, forums, moderation, private requests, accounts, and review history. Private operations require a sign-in within five minutes.</p>
    <p className="objective">Your public handle does not grant administration. This area is authorized by your verified personal GitHub identity. If records cannot load, use <strong>Sign in again</strong>, then refresh.</p>
    <div className="button-row management-actions">
      <button onClick={onSignIn} disabled={busy}>Sign in again</button>
      <button onClick={() => setRevision((value) => value + 1)} disabled={busy}>Refresh records</button>
    </div>
    <nav className="management-tabs" aria-label="Site management sections">
      {views.map(([id, label]) => <button key={id} aria-pressed={view === id} onClick={() => setView(id)}>{label}</button>)}
    </nav>
    {busy && <p role="status">Loading management records...</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success-notice" role="status">{notice}</p>}
    {data && view === 'overview' && <>
      <div className="management-shortcuts">
        <button onClick={() => { setReviewFilter('queue'); setView('contributions'); }}>Moderate discussions ({data.overview.pendingContributions} pending)</button>
        <button onClick={() => setView('requests')}>Review private requests ({data.overview.unresolvedRequests})</button>
        <button onClick={() => setView('content')}>Edit training nuggets</button>
        <button onClick={() => setView('community')}>Manage forums and announcements</button>
      </div>
      <table className="resource-table">
      <caption>Site status</caption><thead><tr><th>Record</th><th>Count</th></tr></thead>
      <tbody>{([
        ['Accounts', data.overview.accounts], ['Active sessions', data.overview.activeSessions],
        ['Pending contributions', data.overview.pendingContributions], ['Unresolved private requests', data.overview.unresolvedRequests],
        ['Source alerts or overdue checks', data.overview.sourceAlerts], ['Published courses', data.overview.publishedCourses],
        ['Published topics', data.overview.publishedTopics],
      ] as const).map(([label, value]) => <tr key={label}><td>{label}</td><td>{value}</td></tr>)}</tbody>
    </table></>}
    {data && view === 'content' && catalog && <section>
      <h2>Training content</h2>
      <p>Edit any lesson using the shared content contract, or open a lesson and use <strong>Edit this nugget</strong> for a single subsection. Reviewed changes are stored in D1, versioned, and recorded in Content history; they survive deployments.</p>
      <label htmlFor="managed-lesson">Topic to edit</label>
      <select id="managed-lesson" value={contentId} onChange={(event) => { setContentId(event.target.value); setEditing(false); }}>
        <option value="">Select a topic</option>
        {catalog.tracks.filter((track) => track.status === 'available').map((track) => <optgroup key={track.id} label={track.title}>
          {catalog.lessons.filter((lesson) => lesson.trackId === track.id).map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.shortTitle}</option>)}
        </optgroup>)}
      </select>
      {selectedLesson && <><p>Revision {selectedLesson.revision} / reviewed {selectedLesson.reviewedAt}. <PageLink pageId={selectedLesson.id}>Open lesson</PageLink></p>
        <button onClick={() => setEditing(true)}>Edit structured lesson</button>
        {editing && <ContentEditor key={`${selectedLesson.id}:${selectedLesson.revision}`} lesson={selectedLesson} catalog={catalog} session={session}
          onSaved={(lesson) => { onContentSaved(lesson); setNotice('Reviewed revision published.'); setRevision((value) => value + 1); }}
          onClose={() => setEditing(false)} />}</>}
      <p>New areas use the same Lesson/Track contracts and renderer. New sources and screenshots require source registration and privacy review before publication.</p>
    </section>}
    {data && view === 'community' && <section>
      <h2>Forums and announcements</h2>
      <p>Course forums follow the published catalog automatically. Page conversations keep the same thread in the lesson and forum. Review pending, reported, published, or hidden contributions in Discussion review.</p>
      <div className="button-row"><button onClick={() => setView('contributions')}>Open moderation tools</button>
        <PageLink pageId={forumPageId('announcements')}>Create or read announcements</PageLink>
        <PageLink pageId="discussions">Member discussion view</PageLink></div>
      <table className="resource-table"><caption>Published course forums</caption><thead><tr><th>Forum</th><th>Topics</th></tr></thead>
        <tbody>{catalog?.tracks.filter((track) => track.status === 'available').map((track) =>
          <tr key={track.id}><td><PageLink pageId={forumPageId(track.id)}>{track.title}</PageLink></td><td>{track.lessonIds.length}</td></tr>)}</tbody></table>
      <p><a href={`https://github.com/${ISSUE_REPOSITORY}/issues`} target="_blank" rel="noopener noreferrer">Public GitHub training issues</a>. Sensitive reports stay in private Contact requests.</p>
    </section>}
    {data && view === 'contributions' && <section>
      <h2>Discussion review</h2>
      <label htmlFor="review-status">Contribution status</label>
      <select id="review-status" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}>
        <option value="queue">Pending and reported</option><option value="pending">Pending</option>
        <option value="reported">Reported</option><option value="published">Published</option><option value="hidden">Hidden</option>
      </select>
      <label htmlFor="review-search">Filter loaded contributions</label>
      <input id="review-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} />
      <p className="field-help">Up to 100 matching records, oldest first. Filter by handle, thread title, or text. Review ancestor context before publishing a reply. Hidden branches remain inaccessible in the member view.</p>
      {data.contributions.length === 0 && <p>No pending or reported contributions.</p>}
      {data.contributions.filter((comment) => `${comment.handle} ${comment.threadTitle} ${comment.body}`.toLowerCase().includes(search.toLowerCase().trim())).map((comment) => <article className="comment" key={comment.id} data-comment-id={comment.id}>
        <header><strong>{comment.handle}</strong>
          <span>{comment.status} / {comment.reports || 0} reports</span><time>{timestamp(comment.createdAt)} UTC</time></header>
        <ContributionContext comment={comment} />
        <p className="comment-body">{comment.body}</p>
        {!!comment.reportReasons?.length && <ul>{comment.reportReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        <div className="button-row">{(['publish', 'hide'] as const).map((action) => <button key={action} disabled={busy}
          onClick={() => void perform(async () => {
            await request(`/management/contributions/${comment.id}`, acknowledgement('reviewed'), {
              method: 'POST', csrfToken: session.csrfToken, body: { action },
            });
          }, `Contribution ${action === 'publish' ? 'published' : 'hidden'}.`)}>{action === 'publish' ? 'Publish' : 'Hide'}</button>)}</div>
      </article>)}
    </section>}
    {data && view === 'requests' && <section>
      <h2>Private requests</h2><p>Reply privately where an address is supplied. Do not copy private messages into discussions.</p>
      {data.requests.length === 0 && <p>No unresolved private requests.</p>}
      {data.requests.map((entry) => <article className="comment" key={entry.id}>
        <header><code>{entry.id}</code><time>{timestamp(entry.createdAt)} UTC</time></header>
        {entry.replyEmail && <p>Reply address: {entry.replyEmail}</p>}
        <p className="comment-body">{entry.message}</p>
        <button disabled={busy} onClick={() => void perform(async () => {
          await request(`/management/requests/${entry.id}/resolve`, acknowledgement('resolved'), {
            method: 'POST', csrfToken: session.csrfToken,
          });
        }, 'Private request marked resolved.')}>Mark resolved</button>
      </article>)}
    </section>}
    {data && view === 'accounts' && <div className="management-table-scroll"><table className="resource-table">
      <caption>Latest 100 accounts</caption><thead><tr><th>Handle</th><th>Role</th><th>Created (UTC)</th><th>Last sign-in (UTC)</th><th>Passkeys</th><th>Linked accounts</th></tr></thead>
      <tbody>{data.accounts.map((account) => <tr key={account.id}><td>{account.handle}</td><td>{account.role}</td>
        <td>{timestamp(account.createdAt)}</td><td>{timestamp(account.lastSignIn)}</td><td>{account.passkeys}</td><td>{account.linkedProviders}</td></tr>)}</tbody>
    </table></div>}
    {data && view === 'references' && <table className="resource-table source-table">
      <caption>Reference checks</caption><thead><tr><th>Source</th><th>Status</th><th>Checked (UTC)</th></tr></thead>
      <tbody>{data.references.map((source) => <tr key={source.sourceId}><td><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a></td>
        <td>{source.status}</td><td>{timestamp(source.checkedAt)}</td></tr>)}</tbody>
    </table>}
    {data && view === 'audit' && <table className="resource-table">
      <caption>Latest 100 contribution reviews</caption><thead><tr><th>Reviewer</th><th>Action</th><th>Time (UTC)</th></tr></thead>
      <tbody>{data.audit.map((entry) => <tr key={entry.id}><td>{entry.handle || 'Deleted account'}</td><td>{entry.action}</td><td>{timestamp(entry.createdAt)}</td></tr>)}</tbody>
    </table>}
    {data && view === 'content-history' && <table className="resource-table">
      <caption>Latest 100 reviewed content changes</caption><thead><tr><th>Topic</th><th>Revision</th><th>Reason</th><th>Reviewer / UTC</th></tr></thead>
      <tbody>{data.contentHistory.map((entry) => <tr key={entry.id}><td><PageLink pageId={entry.lessonId}>{entry.lessonId}</PageLink></td>
        <td>{entry.revision}</td><td>{entry.reason}</td><td>{entry.editor || 'Deleted account'} / {timestamp(entry.createdAt)}</td></tr>)}</tbody>
    </table>}
  </article>;
}
