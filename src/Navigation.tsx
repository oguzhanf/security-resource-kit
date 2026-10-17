import { useEffect, useState } from 'react';
import type { MemberCatalog, PublicTrack } from '../shared/content-types';
import type { Progress } from '../shared/contracts';
import { discussionRoute, PageLink } from './routing';
import { lessonSteps, lessonStepTitle, resolveLessonStep } from '../shared/lesson-flow';

export function Navigation({ pageId, progress, catalog, outline, onNavigate }: {
  pageId: string;
  progress: Progress[];
  catalog: MemberCatalog | null;
  outline: PublicTrack[];
  onNavigate: () => void;
}) {
  const [tab, setTab] = useState<'contents' | 'index' | 'search'>('contents');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [stepId, setStepId] = useState(() => new URLSearchParams(window.location.search).get('step') || '');
  useEffect(() => {
    const changed = () => {
      const step = new URLSearchParams(window.location.search).get('step') || '';
      setStepId(step);
      if (step === 'complete') {
        const lesson = catalog?.lessons.find((entry) => window.location.pathname === `/learn/${entry.id}`);
        if (lesson) {
          const track = catalog?.tracks.find((entry) => entry.id === lesson.trackId);
          const complete = track?.lessonIds.every((id) => progress.some((record) =>
            record.lessonId === id && record.revision === catalog?.lessons.find((entry) => entry.id === id)?.revision && record.completedAt !== null));
          setExpanded((previous) => ({ ...previous, [`lesson:${lesson.id}`]: false, ...(complete ? { [lesson.trackId]: false } : {}) }));
        }
      }
    };
    window.addEventListener('popstate', changed);
    window.addEventListener('srk-lesson-step', changed);
    return () => {
      window.removeEventListener('popstate', changed);
      window.removeEventListener('srk-lesson-step', changed);
    };
  }, [catalog, progress]);
  const lessons = catalog?.lessons || [];
  const tracks = catalog?.tracks || [];
  const availableTracks = tracks.filter((track) => track.status === 'available');
  const results = lessons.filter((lesson) =>
    `${lesson.title} ${lesson.gist} ${lesson.tags.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const complete = (id: string) => progress.some((record) => record.lessonId === id && record.revision === lessons.find((lesson) => lesson.id === id)?.revision && record.completedAt);
  const link = (id: string, text: string, icon: 'document' | 'book' = 'document') => {
    const selected = pageId === id || (id === 'discussions' && discussionRoute(pageId) !== null);
    return <PageLink pageId={id} className={`tree-link ${selected ? 'selected' : ''}`}
      aria-current={pageId === id ? 'page' : selected ? 'location' : undefined} onClick={onNavigate}>
      <span className={`icon-${icon}`} aria-hidden="true" />
      <span>{text}</span>{complete(id) && <span className="completed-dot" title="Application check completed" aria-label="Completed" />}
    </PageLink>;
  };

  return <nav className="navigator" aria-label="Resource kit navigation">
    <div className="nav-title">Resource Kit Navigator</div>
    <div className="nav-tabs" aria-label="Navigation views">
      {(['contents', 'index', 'search'] as const).map((name) => <button key={name} className={tab === name ? 'active' : ''}
        aria-pressed={tab === name} disabled={!catalog && name !== 'contents'} onClick={() => setTab(name)}>{name.charAt(0).toUpperCase() + name.slice(1)}</button>)}
    </div>
    <div className="nav-pane">
      {!catalog ? <ul className="tree guest-tree">
        <li className="tree-root"><span className="tree-root-title"><span className="icon-book" aria-hidden="true" />Security Resource Kit</span></li>
        <li>{link('home', 'Overview')}</li>
        {outline.map((track) => <li key={track.id}><span className="tree-locked" aria-disabled="true">
          <span className="icon-folder" aria-hidden="true" />{track.title}{track.status === 'planned' && <span className="planned-label">planned</span>}
        </span></li>)}
        <li className="pane-help">Registration and sign-in are required to open topics.</li>
        <li>{link('terms', 'Terms of participation')}</li>
        <li>{link('privacy', 'Privacy notice')}</li>
        <li>{link('contact', 'Contact')}</li>
      </ul> : tab === 'contents' && <ul className="tree">
        <li className="tree-root"><span className="tree-root-title"><span className="icon-book" aria-hidden="true" />Security Resource Kit</span></li>
        <li>{link('home', 'Overview')}</li>
        {availableTracks.map((track, trackIndex) => {
          const trackComplete = track.lessonIds.every(complete);
          const activeTopic = track.lessonIds.includes(pageId);
          const open = expanded[track.id] ?? (!trackComplete && (activeTopic || trackIndex === 0));
          return <li className="tree-branch" key={track.id}>
          <div className="branch-line">
            <button className="expander" aria-label={`${open ? 'Collapse' : 'Expand'} ${track.title}`}
              aria-expanded={open} onClick={() => setExpanded((previous) => ({ ...previous, [track.id]: !open }))}>{open ? '-' : '+'}</button>
            <span className="icon-folder" aria-hidden="true" />
            <PageLink pageId={`track-${track.id}`} onClick={onNavigate}
              aria-current={pageId === `track-${track.id}` ? 'page' : undefined}>{track.title}</PageLink>
          </div>
          {open && <ul>{track.lessonIds.map((id, index) => {
            const lesson = lessons.find((entry) => entry.id === id);
            if (!lesson) return null;
            const topicOpen = expanded[`lesson:${lesson.id}`] ?? (pageId === lesson.id && stepId !== 'complete');
            const record = progress.find((entry) => entry.lessonId === lesson.id && entry.revision === lesson.revision);
            const steps = lessonSteps(lesson);
            const selectedStep = pageId === lesson.id ? (stepId || (complete(lesson.id) ? 'complete' : steps[0]?.id)) : null;
            return <li key={lesson.id} className="topic-branch">
              <div className="branch-line topic-line">
                <button className="expander" aria-label={`${topicOpen ? 'Collapse' : 'Expand'} ${lesson.shortTitle} subsections`}
                  aria-expanded={topicOpen} onClick={() => setExpanded((previous) => ({ ...previous, [`lesson:${lesson.id}`]: !topicOpen }))}>{topicOpen ? '-' : '+'}</button>
                {link(lesson.id, `${String(index + 1).padStart(2, '0')}. ${lesson.shortTitle}`)}
              </div>
              {topicOpen && <ul className="subsection-tree" aria-label={`${lesson.shortTitle} subsections`}>{steps.map((step) => {
                const allowed = resolveLessonStep(steps, step.id, !!record, !!record?.postAnswers).id === step.id;
                return <li key={step.id}>{allowed
                  ? <PageLink pageId={lesson.id} stepId={step.id} className={`tree-link ${selectedStep === step.id ? 'selected' : ''}`}
                    aria-current={selectedStep === step.id ? 'step' : undefined} onClick={onNavigate}>{lessonStepTitle(lesson, step)}</PageLink>
                  : <span className="step-locked" aria-disabled="true" title="Save the preparation or application answers to unlock this subsection.">{lessonStepTitle(lesson, step)}</span>}</li>;
              })}</ul>}
            </li>;
          })}</ul>}
        </li>;
        })}
        <li className="tree-section-label">Planned topics</li>
        {tracks.filter((track) => track.status === 'planned').map((track) => <li key={track.id} className="planned-tree">
          <PageLink pageId="roadmap" onClick={onNavigate}><span className="icon-folder muted" aria-hidden="true" />{track.title}<span className="planned-label">planned</span></PageLink>
        </li>)}
        <li className="tree-section-label">Discussions</li>
        <li>{link('discussions', 'Discussion forums')}</li>
        <li className="tree-section-label">Reference</li>
        <li>{link('sources', 'References and review status')}</li>
        <li>{link('roadmap', 'Planned topics')}</li>
        <li>{link('about', 'About this project')}</li>
        <li>{link('account', 'My account')}</li>
        <li>{link('terms', 'Terms of participation')}</li>
        <li>{link('privacy', 'Privacy notice')}</li>
        <li>{link('contact', 'Contact')}</li>
      </ul>}
      {catalog && tab === 'index' && <div>
        <p className="pane-help">Available lessons, alphabetically.</p>
        <ul className="index-list">{[...lessons].sort((left, right) => left.title.localeCompare(right.title)).map((lesson) =>
          <li key={lesson.id}>{link(lesson.id, lesson.title)}</li>)}</ul>
      </div>}
      {catalog && tab === 'search' && <div className="nav-search">
        <label htmlFor="topic-search">Find a concept</label>
        <input id="topic-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="e.g. API key, sponsor, OBO" maxLength={100} />
        <p className="pane-help">{query.trim() ? `${results.length} matching lesson${results.length === 1 ? '' : 's'}.` : 'Search titles, tags, and gists. Nothing is sent to a search service.'}</p>
        <ul className="index-list">{results.map((lesson) => <li key={lesson.id}>{link(lesson.id, lesson.shortTitle)}</li>)}</ul>
        {results.length === 0 && <p>No match. Try a broader concept.</p>}
      </div>}
    </div>
    <div className="navigator-footer"><span className="icon-book" aria-hidden="true" />Security Resource Kit</div>
  </nav>;
}
