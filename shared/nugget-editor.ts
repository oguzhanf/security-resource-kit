import { z } from 'zod';
import type { Lesson } from './content-types';
import type { LessonStep } from './lesson-flow';
import { lessonSchema, lessonVisualSchema } from './content-schemas';

const draftSchema = z.object({ content: z.unknown(), visuals: z.array(lessonVisualSchema) }).strict();

export function nuggetDraft(lesson: Lesson, step: LessonStep) {
  let content: unknown;
  switch (step.kind) {
    case 'summary': content = { gist: lesson.gist, objective: lesson.objective }; break;
    case 'checkpoint': content = { text: lesson.checkpoints[step.index] }; break;
    case 'evidence': content = lesson.evidence[step.index]; break;
    case 'example': content = lesson.codeExamples?.[step.index]; break;
    case 'pre': case 'review-pre': content = lesson.preflight[step.index]; break;
    case 'post': case 'review-post': content = lesson.application[step.index]; break;
    case 'exercise': case 'review-exercise': content = lesson.exercise; break;
    case 'complete': throw new Error('Completion is computed from learning records, not editable content.');
  }
  return { content, visuals: (lesson.visuals || []).filter((visual) => visual.stepId === step.id) };
}

export function applyNuggetDraft(lesson: Lesson, step: LessonStep, value: unknown): Lesson {
  const draft = draftSchema.parse(value);
  const replace = (items: readonly unknown[] | undefined, index: number) =>
    (items || []).map((item, position) => position === index ? draft.content : item);
  let patch: Record<string, unknown>;
  switch (step.kind) {
    case 'summary': patch = z.object({ gist: z.string(), objective: z.string() }).strict().parse(draft.content); break;
    case 'checkpoint': patch = { checkpoints: replace(lesson.checkpoints, step.index).map((item, index) =>
      index === step.index ? z.object({ text: z.string() }).strict().parse(item).text : item) }; break;
    case 'evidence': patch = { evidence: replace(lesson.evidence, step.index) }; break;
    case 'example': patch = { codeExamples: replace(lesson.codeExamples, step.index) }; break;
    case 'pre': case 'review-pre': patch = { preflight: replace(lesson.preflight, step.index) }; break;
    case 'post': case 'review-post': patch = { application: replace(lesson.application, step.index) }; break;
    case 'exercise': case 'review-exercise': patch = { exercise: draft.content }; break;
    case 'complete': throw new Error('Completion is not editable.');
  }
  if (draft.visuals.some((visual) => visual.stepId !== step.id)) throw new Error('Keep visuals attached to this nugget step.');
  return lessonSchema.parse({
    ...lesson, ...patch,
    visuals: [...(lesson.visuals || []).filter((visual) => visual.stepId !== step.id), ...draft.visuals],
  });
}
