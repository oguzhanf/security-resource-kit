import type { Lesson } from './content-types';

export type LessonStep =
  | { id: string; kind: 'pre' | 'post'; index: number }
  | { id: string; kind: 'summary' }
  | { id: string; kind: 'checkpoint' | 'evidence' | 'example'; index: number }
  | { id: string; kind: 'exercise' | 'review-exercise' }
  | { id: string; kind: 'review-pre' | 'review-post'; index: number }
  | { id: string; kind: 'complete' };

export function lessonSteps(lesson: Lesson): LessonStep[] {
  return [
    ...lesson.preflight.map((_, index): LessonStep => ({ id: `pre-${index + 1}`, kind: 'pre', index })),
    { id: 'summary', kind: 'summary' },
    ...lesson.checkpoints.map((_, index): LessonStep => ({ id: `checkpoint-${index + 1}`, kind: 'checkpoint', index })),
    ...lesson.evidence.map((_, index): LessonStep => ({ id: `evidence-${index + 1}`, kind: 'evidence', index })),
    ...(lesson.codeExamples || []).map((_, index): LessonStep => ({ id: `example-${index + 1}`, kind: 'example', index })),
    { id: 'exercise', kind: 'exercise' },
    ...lesson.application.map((_, index): LessonStep => ({ id: `post-${index + 1}`, kind: 'post', index })),
    ...lesson.preflight.map((_, index): LessonStep => ({ id: `review-pre-${index + 1}`, kind: 'review-pre', index })),
    ...lesson.application.map((_, index): LessonStep => ({ id: `review-post-${index + 1}`, kind: 'review-post', index })),
    { id: 'review-exercise', kind: 'review-exercise' },
    { id: 'complete', kind: 'complete' },
  ];
}

export function isAnswerReview(step: LessonStep): boolean {
  return step.kind === 'review-pre' || step.kind === 'review-post' || step.kind === 'review-exercise' || step.kind === 'complete';
}

export function resolveLessonStep(steps: readonly LessonStep[], requestedId: string, prepared: boolean, applied: boolean): LessonStep {
  const requested = steps.find((step) => step.id === requestedId) || steps[0];
  if (!requested) throw new Error('The topic requires a learning sequence.');
  const selected = !prepared && requested.kind !== 'pre' ? steps.find((step) => step.kind === 'pre')
    : !applied && isAnswerReview(requested) ? steps.find((step) => step.kind === 'post') : requested;
  if (!selected) throw new Error('The topic requires preparation and application questions.');
  return selected;
}

export function lessonStepPath(lessonId: string, step: string): string {
  return `/learn/${encodeURIComponent(lessonId)}?step=${encodeURIComponent(step)}`;
}

export function lessonStepTitle(lesson: Lesson, step: LessonStep): string {
  switch (step.kind) {
    case 'pre': return `Preparation ${step.index + 1}`;
    case 'post': return `Application ${step.index + 1}`;
    case 'summary': return 'Summary';
    case 'checkpoint': return `Checkpoint ${step.index + 1}`;
    case 'evidence': return lesson.evidence[step.index]?.title || 'Evidence';
    case 'example': return lesson.codeExamples?.[step.index]?.title || 'Example';
    case 'exercise': return lesson.exercise.title;
    case 'review-pre': return `Preparation review ${step.index + 1}`;
    case 'review-post': return `Application review ${step.index + 1}`;
    case 'review-exercise': return 'Exercise review';
    case 'complete': return 'Topic completion';
  }
}
