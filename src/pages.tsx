import type { Lesson, MemberCatalog, Track } from '../shared/content-types';
import type { Progress, SiteConfig, SourceStatus } from '../shared/contracts';
import { PageLink } from './routing';
import { LessonContents } from './LessonContents';

function done(progress: Progress[], id: string, lessons: readonly Lesson[]) {
  return progress.some((record) => record.lessonId === id && record.revision === lessons.find((lesson) => lesson.id === id)?.revision && record.completedAt);
}

export function LearningTable({ progress, track, catalog }: { progress: Progress[]; track: Track; catalog: MemberCatalog }) {
  const { lessons } = catalog;
  const trackLessons = lessons.filter((lesson) => lesson.trackId === track.id);
  return <table className="resource-table">
    <caption>{track.title} topics</caption>
    <thead><tr><th scope="col">Section</th><th scope="col">Topic</th><th scope="col">Level</th><th scope="col">Progress</th></tr></thead>
    <tbody>{trackLessons.map((lesson, index) => <tr key={lesson.id}>
      <td className="order-cell">{String(index + 1).padStart(2, '0')}</td>
      <td><PageLink pageId={lesson.id}>{lesson.shortTitle}</PageLink><small>{lesson.objective}</small>
        <details className="topic-contents"><summary>Subsections</summary><LessonContents lesson={lesson} progress={progress.find((record) => record.lessonId === lesson.id && record.revision === lesson.revision)} /></details></td>
      <td><span className="level-tag">{lesson.level}</span></td>
      <td><span className={done(progress, lesson.id, lessons) ? 'state-complete' : 'state-open'}>{done(progress, lesson.id, lessons) ? 'Complete' : 'Not started'}</span></td>
    </tr>)}</tbody>
  </table>;
}

export function RegistrationPage({ onRegister, onSignIn, registrationEnabled }: {
  onRegister: () => void; onSignIn: () => void; registrationEnabled: boolean;
}) {
  return <article className="registration-landing">
    <h1>Security Resource Kit</h1>
    <p>This site provides free training on Microsoft security technologies. Registration and sign-in are required to access topics, references, and discussions.</p>
    <div className="button-row"><button className="primary" onClick={onRegister}>Register an account</button><button onClick={onSignIn}>Sign in to your account</button></div>
    {!registrationEnabled && <p>Registration is currently unavailable.</p>}
    <p>Review the <PageLink pageId="terms">terms of participation</PageLink> and <PageLink pageId="privacy">privacy notice</PageLink> before registering.</p>
  </article>;
}

export function HomePage({ progress, catalog }: { progress: Progress[]; catalog: MemberCatalog }) {
  const { lessons, tracks } = catalog;
  const availableTracks = tracks.filter((track) => track.status === 'available');
  return <article className="home">
    <h1>Security Resource Kit</h1>
    <p className="home-intro">Technical training for security professionals working with Microsoft technologies. Select a topic from Contents or the list below.</p>
    <h2>Contents</h2>
    <table className="resource-table"><caption>All training areas</caption>
      <thead><tr><th>Area</th><th>Scope</th><th>Progress</th></tr></thead>
      <tbody>{availableTracks.map((track) => {
        const completed = track.lessonIds.filter((id) => done(progress, id, lessons)).length;
        return <tr key={track.id}><td><PageLink pageId={`track-${track.id}`}>{track.title}</PageLink></td><td>{track.description}</td>
          <td>{completed}/{track.lessonIds.length} complete{completed === track.lessonIds.length && ' / area complete'}</td></tr>;
      })}</tbody>
    </table>
    <h2>Using this Resource Kit</h2>
    <p>Each topic includes pre-topic questions, a summary, an application check, and references. Summaries are limited to 100 words. Progress is recorded in your account.</p>
    <p className="public-boundary"><strong>Important:</strong> Do not submit credentials, live tokens, confidential information, customer data, or unredacted incident records.</p>
  </article>;
}

export function TrackPage({ progress, track, catalog }: { progress: Progress[]; track: Track; catalog: MemberCatalog }) {
  const completed = track.lessonIds.filter((id) => done(progress, id, catalog.lessons)).length;
  return <article><h1>{track.title}</h1>
    <p>{track.description}</p>
    <p className={completed === track.lessonIds.length ? 'success-notice' : 'objective'}>{completed === track.lessonIds.length
      ? 'Area complete. Use this full table of contents to revisit any topic or subsection.'
      : `${completed}/${track.lessonIds.length} topics complete. Select a topic or expand its subsections.`}</p>
    <p>Topics are listed in the recommended order. Prerequisites are optional. Each topic begins with pre-topic questions and includes an application check. Completion records do not provide certification credit.</p>
    <LearningTable progress={progress} track={track} catalog={catalog} /><PageLink pageId="sources">References and review status</PageLink>
  </article>;
}

export function RoadmapPage({ catalog }: { catalog: MemberCatalog }) {
  const { tracks } = catalog;
  return <article><h1>Planned Topics</h1>
    <p>The following table lists available and planned training. Planned topics are not yet available in Contents.</p>
    <table className="resource-table"><caption>Training topics</caption><thead><tr><th>Topic</th><th>Scope</th><th>Status</th></tr></thead>
      <tbody>{tracks.map((track) => <tr key={track.id}><td>{track.status === 'available' ? <PageLink pageId={`track-${track.id}`}>{track.title}</PageLink> : track.title}</td><td>{track.description}</td><td><span className={track.status === 'available' ? 'state-complete' : 'state-planned'}>{track.status === 'available' ? `${track.lessonIds.length} topics available` : 'Planned'}</span></td></tr>)}</tbody></table>
    <p>Topic requests and corrections can be submitted in the discussion below.</p>
  </article>;
}

export function AboutPage({ config }: { config: SiteConfig | null }) {
  return <article><h1>About the Security Resource Kit</h1>
    <p className="objective">Created by <a href="https://github.com/oguzhanf" target="_blank" rel="noopener noreferrer">@oguzhanf</a> for security professionals working at Microsoft and with Microsoft technologies elsewhere.</p>
    <p>This is an independent project, not an official Microsoft publication, support service, or certification. "400 / 500" describes the intended depth, not an official course classification. Accounts do not verify employment.</p>
    <h2>Content Format</h2>
    <dl className="editorial-contract"><dt>Summary</dt><dd>Each topic includes a summary of no more than 100 words. Configuration guidance, exceptions, and references are provided separately.</dd>
      <dt>Pre-topic questions</dt><dd>Questions introduce the topic and provide explanations for each answer. Incorrect answers do not prevent access to the topic.</dd>
      <dt>References</dt><dd>Technical content cites public primary documentation. Review dates and known documentation conflicts are recorded with the topic.</dd>
      <dt>Updates</dt><dd>Daily checks identify source changes and unavailable references. Topic content and review dates are updated only after technical review.</dd></dl>
    <h2>Discussion</h2><p>Each page includes a moderated discussion. Use public sources and synthetic examples. Submit private security or privacy reports through the operator's contact channel.</p>
    {config?.contactUrl && <p><a href={config.contactUrl} target="_blank" rel="noopener noreferrer">Contact the operator privately</a></p>}
    <p><PageLink pageId="terms">Terms of participation</PageLink> / <PageLink pageId="privacy">Privacy notice</PageLink> / <PageLink pageId="sources">Source register</PageLink></p>
  </article>;
}

export function SourcesPage({ statuses, catalog }: { statuses: SourceStatus[]; catalog: MemberCatalog }) {
  const { lessons, sources } = catalog;
  const latestReview = [...lessons].map((lesson) => lesson.reviewedAt).sort().at(-1);
  const conflicts = lessons.flatMap((lesson) => lesson.evidence
    .filter((entry) => entry.documentationConflict)
    .map((entry) => ({ ...entry, lessonId: lesson.id, lessonTitle: lesson.title })));
  const label = (status: SourceStatus | undefined) => {
    if (!status || status.status === 'not-checked') return 'Not yet checked';
    if (status.checkedAt && Date.now() / 1000 - status.checkedAt > 48 * 3600) return 'Check overdue / freshness unverified';
    return status.status === 'unchanged' ? 'No upstream change detected' : status.status === 'changed' ? 'Changed / technical review required' : 'Source unavailable / freshness unverified';
  };
  return <article><h1>References and Review Status</h1>
    <p>Most recent topic review: {latestReview}. Each topic lists its review date. Automated source checks are separate from technical review.</p>
    <p>Daily checks compare official Microsoft Learn pages and documentation repository sources with approved fingerprints. A changed source prompts review; an unchanged hash is not proof of correctness. If checks fail or are more than 48 hours old, freshness is unverified.</p>
    {conflicts.length > 0 && <div className="notice"><strong>Known documentation differences:</strong>
      <ul>{conflicts.map((entry) => <li key={`${entry.lessonId}-${entry.title}`}>
        <PageLink pageId={entry.lessonId}>{entry.lessonTitle}</PageLink>: {entry.text}
      </li>)}</ul>
    </div>}
    <table className="resource-table source-table"><caption>Evidence and automated check status</caption><thead><tr><th>Microsoft source</th><th>Check result</th><th>Last check (UTC)</th></tr></thead><tbody>{sources.map((source) => {
      const status = statuses.find((entry) => entry.sourceId === source.id);
      return <tr key={source.id}><td><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><small>Microsoft Learn / official source repository</small></td>
        <td className={status?.status === 'changed' || status?.status === 'unavailable' ? 'source-alert' : ''}>{label(status)}</td>
        <td>{status?.checkedAt ? new Date(status.checkedAt * 1000).toISOString().replace('T', ' ').slice(0, 16) : 'Not yet observed'}</td></tr>;
    })}</tbody></table>
    <p>Check the source again before a production change. Product availability, licensing, API schemas, and policy behavior must be verified for your tenant and release.</p>
  </article>;
}
