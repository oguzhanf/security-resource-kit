import { z } from 'zod';
import type { Lesson, LessonVisual } from './content-types';
import { wordCount } from './learning-utils';
import { lessonSteps } from './lesson-flow';

const prose = z.string().trim().min(1).max(4000).refine((text) => wordCount(text) <= 100, 'Keep each prose nugget within 100 words.');
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(100);
const title = z.string().trim().min(1).max(160);
export const questionSchema = z.object({
  id, scenario: prose, prompt: prose,
  choices: z.array(z.object({ text: prose, feedback: prose }).strict()).min(3).max(10),
  correct: z.number().int().nonnegative(), sourceId: id,
}).strict().refine((question) => question.correct < question.choices.length, 'Choose an existing correct answer.');

const visualBase = { id, stepId: id, title, caption: prose, sourceId: id };
export const lessonVisualSchema: z.ZodType<LessonVisual> = z.discriminatedUnion('kind', [
  z.object({
    ...visualBase, kind: z.literal('diagram'),
    nodes: z.array(z.object({
      id, label: z.string().min(1).max(55), detail: z.string().max(90),
      column: z.number().int().min(0).max(2), row: z.number().int().min(0).max(5),
    }).strict()).min(2).max(12),
    edges: z.array(z.object({ from: id, to: id, label: z.string().max(60) }).strict()).min(1).max(16),
  }).strict().superRefine((visual, context) => {
    const ids = new Set(visual.nodes.map((node) => node.id));
    if (ids.size !== visual.nodes.length ||
      new Set(visual.nodes.map((node) => `${node.column}:${node.row}`)).size !== visual.nodes.length ||
      visual.edges.some((edge) => edge.from === edge.to || !ids.has(edge.from) || !ids.has(edge.to))) {
      context.addIssue({ code: 'custom', message: 'Use unique node IDs/positions and edges between existing distinct nodes.' });
    }
  }),
  z.object({
    ...visualBase, kind: z.literal('screenshot'),
    src: z.string().regex(/^\/training-media\/[a-z0-9-]+\.png$/u),
    alt: prose, capturedAt: z.iso.date(),
    provenance: z.enum(['public-documentation-redacted', 'tenant-redacted']),
  }).strict(),
]);

export const lessonSchema: z.ZodType<Lesson> = z.object({
  id, trackId: id, title, shortTitle: title,
  level: z.union([z.literal(400), z.literal(500)]),
  minutes: z.number().int().positive().max(120), revision: z.number().int().positive(),
  reviewedAt: z.iso.date(), objective: prose, gist: prose,
  prerequisites: z.array(id).max(20), tags: z.array(title).max(20), sourceIds: z.array(id).min(1).max(30),
  preflight: z.array(questionSchema).min(2).max(10), application: z.array(questionSchema).min(1).max(10),
  checkpoints: z.array(prose).min(1).max(20),
  evidence: z.array(z.object({ title, text: prose, sourceId: id, documentationConflict: z.boolean().optional() }).strict()).min(1).max(20),
  exercise: z.object({ title, prompt: prose, expected: prose }).strict(),
  codeExamples: z.array(z.object({
    title, language: z.enum(['http', 'kql', 'json']), code: z.string().min(1).max(12000), note: prose, sourceId: id,
  }).strict()).max(10).optional(),
  visuals: z.array(lessonVisualSchema).max(30).optional(),
}).strict().superRefine((lesson, context) => {
  const steps = new Set(lessonSteps(lesson).map((step) => step.id));
  const references = [
    ...lesson.preflight, ...lesson.application, ...lesson.evidence,
    ...(lesson.codeExamples || []), ...(lesson.visuals || []),
  ];
  const nuggets = [
    ...lesson.evidence.map((item) => `${item.title} ${item.text}`),
    ...(lesson.codeExamples || []).map((item) => `${item.title} ${item.note}`),
    `${lesson.exercise.title} ${lesson.exercise.prompt}`,
    ...(lesson.visuals || []).map((visual) => visual.kind === 'diagram'
      ? `${visual.title} ${visual.caption} ${visual.nodes.map((node) => `${node.label} ${node.detail}`).join(' ')} ${visual.edges.map((edge) => edge.label).join(' ')}`
      : `${visual.title} ${visual.caption} ${visual.alt}`),
  ];
  for (const question of [...lesson.preflight, ...lesson.application]) {
    const correct = question.choices[question.correct];
    if (correct) for (const choice of question.choices) {
      nuggets.push(`${question.prompt} ${choice.text} ${correct.text} ${choice.feedback} ${choice === correct ? '' : correct.feedback}`);
    }
  }
  if (nuggets.some((text) => wordCount(text) > 100)) {
    context.addIssue({ code: 'custom', message: 'Combined nugget and answer-review text must stay within 100 words.' });
  }
  if (references.some((item) => !lesson.sourceIds.includes(item.sourceId))) {
    context.addIssue({ code: 'custom', message: 'Every reference must be included in the lesson source IDs.' });
  }
  if (new Set(lesson.visuals?.map((visual) => visual.id)).size !== (lesson.visuals?.length || 0) ||
    lesson.visuals?.some((visual) => !steps.has(visual.stepId) || /^(?:pre|post)-\d+$/u.test(visual.stepId) || visual.stepId === 'complete')) {
    context.addIssue({ code: 'custom', message: 'Visuals need unique IDs and an existing teaching or review step, not an unanswered question.' });
  }
});

export const contentEditSchema = z.object({
  expectedRevision: z.number().int().positive(),
  lesson: lessonSchema,
  reason: z.string().trim().min(10).max(500),
  technicalReviewConfirmed: z.literal(true),
}).strict();
