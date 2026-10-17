import type { Lesson } from '../shared/content-types';
import type { Progress } from '../shared/contracts';
import { lessonSteps, lessonStepTitle, resolveLessonStep } from '../shared/lesson-flow';
import { PageLink } from './routing';

export function LessonContents({ lesson, progress }: { lesson: Lesson; progress?: Progress }) {
  const steps = lessonSteps(lesson);
  const current = progress?.revision === lesson.revision ? progress : undefined;
  return <ol className="lesson-contents" aria-label={`${lesson.shortTitle} table of contents`}>
    {steps.map((step) => <li key={step.id}>
      {resolveLessonStep(steps, step.id, !!current, !!current?.postAnswers).id === step.id
        ? <PageLink pageId={lesson.id} stepId={step.id}>{lessonStepTitle(lesson, step)}</PageLink>
        : <span aria-disabled="true">{lessonStepTitle(lesson, step)} <small>/ complete {current ? 'application' : 'preparation'} first</small></span>}
      {lesson.visuals?.some((visual) => visual.stepId === step.id) && <span className="contents-visual-label"> / illustrated</span>}
    </li>)}
  </ol>;
}
