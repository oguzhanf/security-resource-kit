import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { lessonStepPath, lessonSteps, resolveLessonStep } from '../shared/lesson-flow';
import type { LessonStep } from '../shared/lesson-flow';
import type { Lesson, MemberCatalog, Question } from '../shared/content-types';
import type { Progress, SessionInfo, SourceStatus } from '../shared/contracts';
import { Quiz } from './Quiz';
import { PageLink, threadPageId } from './routing';
import { errorMessage } from './api';
import { LessonVisuals } from './LessonVisuals';
import { LessonContents } from './LessonContents';
import { ContentEditor } from './ContentEditor';
import { trainingIssueUrl } from '../shared/feedback';

const draftSchema = z.object({
  learnerId: z.string(), lessonId: z.string(), revision: z.number().int(),
  preAnswers: z.array(z.number().int().nonnegative().nullable()),
  postAnswers: z.array(z.number().int().nonnegative().nullable()),
});
type Answers = Pick<z.infer<typeof draftSchema>, 'preAnswers' | 'postAnswers'>;

function readDraft(learnerId: string, lesson: Lesson): Answers | null {
  const state: unknown = window.history.state;
  if (!state || typeof state !== 'object' || !('lessonDraft' in state)) return null;
  const draft = draftSchema.safeParse(state.lessonDraft);
  if (!draft.success || draft.data.learnerId !== learnerId || draft.data.lessonId !== lesson.id || draft.data.revision !== lesson.revision) return null;
  const valid = (answers: (number | null)[], questions: readonly Question[]) =>
    answers.length === questions.length && answers.every((answer, index) =>
      answer === null || answer < requiredItem(questions, index).choices.length);
  return valid(draft.data.preAnswers, lesson.preflight) && valid(draft.data.postAnswers, lesson.application)
    ? { preAnswers: draft.data.preAnswers, postAnswers: draft.data.postAnswers } : null;
}

function requiredItem<T>(items: readonly T[] | undefined, index: number): T {
  const item = items?.[index];
  if (item === undefined) throw new Error('The topic learning page is missing content.');
  return item;
}

function requestedStepId(steps: readonly LessonStep[], completed = false): string {
  return new URLSearchParams(window.location.search).get('step') || (completed ? 'complete' : requiredItem(steps, 0).id);
}

export function LessonView({ learnerId, lesson, progress, records, sourceStatuses, catalog, onAttempt, session, onContentSaved }: {
  learnerId: string;
  lesson: Lesson;
  progress: Progress | undefined;
  records: readonly Progress[];
  sourceStatuses: SourceStatus[];
  catalog: MemberCatalog;
  onAttempt: (stage: 'pre' | 'post', answers: number[]) => Promise<void>;
  session: SessionInfo;
  onContentSaved: (lesson: Lesson) => void;
}) {
  const steps = useMemo(() => lessonSteps(lesson), [lesson]);
  const [stepId, setStepId] = useState(() => requestedStepId(steps, !!progress?.completedAt));
  const [restoredDraft] = useState(() => readDraft(learnerId, lesson));
  const [answers, setAnswers] = useState<Answers>(() => restoredDraft || {
    preAnswers: lesson.preflight.map((_, index) => progress?.preAnswers[index] ?? null),
    postAnswers: lesson.application.map((_, index) => progress?.postAnswers?.[index] ?? null),
  });
  const { preAnswers, postAnswers } = answers;
  const [prepared, setPrepared] = useState(() => !!progress && preAnswers.every((answer, index) => answer === progress.preAnswers[index]));
  const [applied, setApplied] = useState(() => prepared && !!progress?.postAnswers && postAnswers.every((answer, index) => answer === progress.postAnswers?.[index]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const nugget = useRef<HTMLDivElement>(null);
  const track = catalog.tracks.find((item) => item.id === lesson.trackId);
  if (!track) throw new Error('The topic requires a published module.');
  const trackLessons = track.lessonIds.map((id) => {
    const topic = catalog.lessons.find((item) => item.id === id && item.trackId === track.id);
    if (!topic) throw new Error('The module contains an unavailable topic.');
    return topic;
  });
  const topicIndex = trackLessons.findIndex((item) => item.id === lesson.id);
  const nextTopic = trackLessons[topicIndex + 1];
  const step: LessonStep = resolveLessonStep(steps, stepId, prepared, applied);
  const stepIndex = steps.findIndex((item) => item.id === step.id);
  const firstApplication = steps.find((item) => item.kind === 'post');
  const topicComplete = progress !== undefined && progress.completedAt !== null;
  const completedTopics = trackLessons.filter((item) => records.some((record) =>
    record.lessonId === item.id && record.revision === item.revision && record.completedAt !== null)).length;
  const moduleComplete = completedTopics === trackLessons.length;

  useEffect(() => {
    const changed = () => {
      setStepId(requestedStepId(steps, !!progress?.completedAt));
      setEditing(false);
      nugget.current?.querySelector<HTMLHeadingElement>('h2')?.focus();
    };
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, [steps, progress?.completedAt]);

  useEffect(() => {
    if (step.id !== stepId) {
      window.history.replaceState(window.history.state, '', lessonStepPath(lesson.id, step.id));
      setStepId(step.id);
    }
    nugget.current?.querySelector<HTMLHeadingElement>('h2')?.focus();
    window.dispatchEvent(new Event('srk-lesson-step'));
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [step.id, stepId, lesson.id]);

  function historyDraft(nextAnswers: Answers = answers) {
    const state: unknown = window.history.state;
    return {
      ...(state && typeof state === 'object' ? state : {}),
      lessonDraft: { learnerId, lessonId: lesson.id, revision: lesson.revision, ...nextAnswers },
    };
  }

  function move(id: string) {
    window.history.pushState(historyDraft(), '', lessonStepPath(lesson.id, id));
    setStepId(id);
    setEditing(false);
    setError('');
  }

  async function next() {
    setError('');
    const following = steps[stepIndex + 1];
    if (!following) return;
    setBusy(true);
    try {
      if (step.kind === 'pre' && step.index === lesson.preflight.length - 1) {
        if (preAnswers.some((answer) => answer === null)) throw new Error('Answer each pre-topic question before continuing.');
        await onAttempt('pre', preAnswers.map((answer) => {
          if (answer === null) throw new Error('A pre-topic answer is missing.');
          return answer;
        }));
        setPrepared(true);
      }
      if (step.kind === 'post' && step.index === lesson.application.length - 1) {
        if (postAnswers.some((answer) => answer === null)) throw new Error('Answer each application question before reviewing the topic.');
        await onAttempt('post', postAnswers.map((answer) => {
          if (answer === null) throw new Error('An application answer is missing.');
          return answer;
        }));
        setApplied(true);
      }
      move(following.id);
    } catch (failure) {
      setError(`The record was not saved: ${errorMessage(failure)} Retry before continuing.`);
    } finally {
      setBusy(false);
    }
  }

  function select(stage: 'pre' | 'post', index: number, answer: number) {
    const nextAnswers = {
      preAnswers: stage === 'pre' ? preAnswers.map((value, position) => position === index ? answer : value) : preAnswers,
      postAnswers: stage === 'post' ? postAnswers.map((value, position) => position === index ? answer : value) : postAnswers,
    };
    window.history.replaceState(historyDraft(nextAnswers), '');
    setAnswers(nextAnswers);
    if (stage === 'pre') setPrepared(false);
    setApplied(false);
  }

  function sourceLink(id: string) {
    const source = catalog.sources.find((item) => item.id === id);
    if (!source) throw new Error('The topic primary reference is missing.');
    return <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>;
  }

  function review(question: Question, answer: number | null, title: string) {
    if (answer === null) throw new Error('The answer review requires a saved answer.');
    const chosen = requiredItem(question.choices, answer);
    const correct = requiredItem(question.choices, question.correct);
    return <section className="answer-review">
      <h2 tabIndex={-1}>{title}</h2>
      <p><strong>{question.prompt}</strong></p>
      <p><strong>Your answer:</strong> {chosen.text}</p>
      <p><strong>Correct answer:</strong> {correct.text}</p>
      <p className={`answer-feedback ${answer === question.correct ? 'correct' : 'incorrect'}`}>{chosen.feedback}</p>
      {answer !== question.correct && <p>{correct.feedback}</p>}
      {sourceLink(question.sourceId)}
    </section>;
  }

  const sourceWarning = sourceStatuses.some((status) => lesson.sourceIds.includes(status.sourceId) &&
    (status.status !== 'unchanged' || status.checkedAt === null || Date.now() / 1000 - status.checkedAt > 48 * 3600));
  const reviewOverdue = Date.now() - Date.parse(`${lesson.reviewedAt}T00:00:00Z`) > 45 * 86400000;
  const unanswered = step.kind === 'pre' ? preAnswers[step.index] === null : step.kind === 'post' ? postAnswers[step.index] === null : false;

  function renderNugget() {
    switch (step.kind) {
      case 'pre':
      case 'post': {
        const questions = step.kind === 'pre' ? lesson.preflight : lesson.application;
        return <Quiz question={requiredItem(questions, step.index)} stage={step.kind} number={step.index + 1} total={questions.length}
          selected={requiredItem(step.kind === 'pre' ? preAnswers : postAnswers, step.index)}
          onSelect={(answer) => select(step.kind === 'pre' ? 'pre' : 'post', step.index, answer)} busy={busy} />;
      }
      case 'summary':
        return <section className="gist-section">
          <h2 tabIndex={-1}>Summary</h2><p className="gist-text">{lesson.gist}</p>
          <p className="field-help"><strong>Objective:</strong> {lesson.objective}</p>
          {(sourceWarning || reviewOverdue) && <p className="notice">Reference freshness or technical review needs confirmation. Review date: {lesson.reviewedAt}.</p>}
        </section>;
      case 'checkpoint':
        return <section><h2 tabIndex={-1}>Operational checkpoint {step.index + 1}</h2><p>{requiredItem(lesson.checkpoints, step.index)}</p></section>;
      case 'evidence': {
        const evidence = requiredItem(lesson.evidence, step.index);
        return <section className="evidence-item"><h2 tabIndex={-1}>{evidence.title}</h2><p>{evidence.text}</p>{sourceLink(evidence.sourceId)}</section>;
      }
      case 'example': {
        const example = requiredItem(lesson.codeExamples, step.index);
        return <section className="code-examples">
          <h2 tabIndex={-1}>{example.title}</h2><div className="code-example"><pre><code>{example.code}</code></pre>
            <p>{example.note}</p>{sourceLink(example.sourceId)}</div>
        </section>;
      }
      case 'exercise':
        return <section className="exercise">
          <h2 tabIndex={-1}>{lesson.exercise.title}</h2><p>{lesson.exercise.prompt}</p>
          <p className="field-help">Use synthetic or approved lab data. Compare your reasoning at the end of the topic.</p>
        </section>;
      case 'review-pre':
        return review(requiredItem(lesson.preflight, step.index), requiredItem(preAnswers, step.index), `Pre-topic answer review ${step.index + 1}`);
      case 'review-post':
        return review(requiredItem(lesson.application, step.index), requiredItem(postAnswers, step.index), `Application answer review ${step.index + 1}`);
      case 'review-exercise':
        return <section className="exercise-review">
          <h2 tabIndex={-1}>Exercise review</h2><p>{lesson.exercise.expected}</p>
        </section>;
      case 'complete':
        return <section className="topic-complete">
          <h2 tabIndex={-1}>{topicComplete ? 'Topic complete' : 'Topic review complete'}</h2>
          <p>{topicComplete ? 'The application check and topic record are complete.' : 'Review the application explanation, then retry the application question to complete the topic record.'}</p>
          {!topicComplete && firstApplication && <button onClick={() => { setApplied(false); move(firstApplication.id); }}>Retry application question</button>}
          {nextTopic ? topicComplete && <p><PageLink pageId={nextTopic.id} className="next-topic-link">Next topic: {nextTopic.shortTitle}</PageLink></p>
            : <p><strong>{moduleComplete ? 'Module complete.' : 'Last topic reached.'}</strong> {completedTopics}/{trackLessons.length} topics complete. <PageLink pageId={`track-${lesson.trackId}`}>Review module progress</PageLink></p>}
          <h3>Topic contents</h3><LessonContents lesson={lesson} progress={progress} />
          <p><PageLink pageId={`track-${lesson.trackId}`}>Full {catalog.tracks.find((item) => item.id === lesson.trackId)?.title} table of contents</PageLink></p>
        </section>;
    }
  }

  return <article className="lesson lesson-player">
    <p className="eyebrow">{track.title} / Topic {topicIndex + 1} of {trackLessons.length}</p>
    <h1>{lesson.title}</h1>
    <div className="lesson-meta"><span>Page {stepIndex + 1} of {steps.length}</span><span>Level {lesson.level}</span><span>Reviewed {lesson.reviewedAt}</span></div>
    <div className="lesson-nugget" data-step={step.id} ref={nugget}>{renderNugget()}
      <LessonVisuals visuals={(lesson.visuals || []).filter((visual) => visual.stepId === step.id)} catalog={catalog} />
    </div>
    <div className="nugget-tools">
      <a href={trainingIssueUrl(lesson.id, lesson.revision, step.id)} target="_blank" rel="noopener noreferrer">Report an issue on GitHub</a>
      {session.managementLink && step.kind !== 'complete' && <button className="text-button" onClick={() => setEditing(!editing)}>Edit this nugget</button>}
    </div>
    <p className="field-help">GitHub issues are public. Do not attach tenant/user identifiers or incident data. Use <PageLink pageId="contact">private Contact</PageLink> for sensitive reports.</p>
    {editing && <ContentEditor key={`${lesson.revision}:${step.id}`} lesson={lesson} step={step} catalog={catalog} session={session}
      onSaved={onContentSaved} onClose={() => setEditing(false)} />}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="lesson-step-controls">
      <button disabled={busy || stepIndex === 0} onClick={() => {
        const previous = steps[stepIndex - 1];
        if (previous) move(previous.id);
      }}>Back</button>
      {step.kind !== 'complete' && <button className="primary" disabled={busy || unanswered} onClick={() => void next()}>{busy ? 'Saving...' : step.kind === 'review-exercise' ? 'Finish topic' : 'Next'}</button>}
    </div>
    <p className="lesson-player-links"><PageLink pageId={`track-${lesson.trackId}`}>Module contents</PageLink> / <PageLink pageId={threadPageId(lesson.trackId, `page-${lesson.id}`)}>Discuss this topic</PageLink></p>
  </article>;
}
