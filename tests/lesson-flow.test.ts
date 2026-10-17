import { describe, expect, it } from 'vitest';
import { lessons, wordCount } from '../shared/catalog';
import { isAnswerReview, lessonStepPath, lessonSteps, resolveLessonStep } from '../shared/lesson-flow';

describe('universal nugget learning sequence', () => {
  for (const lesson of lessons) {
    describe(lesson.id, () => {
      const steps = lessonSteps(lesson);
      const expected = [
        ...lesson.preflight.map((_, index) => `pre-${index + 1}`),
        'summary',
        ...lesson.checkpoints.map((_, index) => `checkpoint-${index + 1}`),
        ...lesson.evidence.map((_, index) => `evidence-${index + 1}`),
        ...(lesson.codeExamples || []).map((_, index) => `example-${index + 1}`),
        'exercise',
        ...lesson.application.map((_, index) => `post-${index + 1}`),
        ...lesson.preflight.map((_, index) => `review-pre-${index + 1}`),
        ...lesson.application.map((_, index) => `review-post-${index + 1}`),
        'review-exercise', 'complete',
      ];

      it('separates every question and content item and reviews answers only after application', () => {
        expect(steps.map((step) => step.id)).toEqual(expected);
        expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
        const firstReview = steps.findIndex(isAnswerReview);
        const lastApplication = steps.reduce((last, step, index) => step.kind === 'post' ? index : last, -1);
        expect(firstReview).toBe(lastApplication + 1);
        expect(steps.slice(0, firstReview).every((step) => !isAnswerReview(step))).toBe(true);
        expect(steps.slice(firstReview).every(isAnswerReview)).toBe(true);
        expect(steps.filter((step) => step.kind === 'pre')).toHaveLength(lesson.preflight.length);
        expect(steps.filter((step) => step.kind === 'post')).toHaveLength(lesson.application.length);
      });

      it('requires saved preparation before reading and saved application before any answer review', () => {
        for (const step of steps) {
          expect(resolveLessonStep(steps, step.id, false, false).id).toBe(step.kind === 'pre' ? step.id : 'pre-1');
          expect(resolveLessonStep(steps, step.id, true, false).id).toBe(isAnswerReview(step) ? 'post-1' : step.id);
          expect(resolveLessonStep(steps, step.id, true, true).id).toBe(step.id);
        }
        expect(resolveLessonStep(steps, 'invalid-step', true, true).id).toBe('pre-1');
      });

      it('keeps each prose nugget and answer explanation within 100 words', () => {
        const nuggets = [
          ['summary', lesson.gist],
          ['objective', lesson.objective],
          ...lesson.checkpoints.map((text, index) => [`checkpoint-${index + 1}`, text]),
          ...lesson.evidence.map((item, index) => [`evidence-${index + 1}`, `${item.title} ${item.text}`]),
          ...(lesson.codeExamples || []).map((item, index) => [`example-${index + 1}`, `${item.title} ${item.note}`]),
          ['exercise', `${lesson.exercise.title} ${lesson.exercise.prompt}`],
          ['exercise-review', lesson.exercise.expected],
        ];
        for (const [id, text] of nuggets) {
          expect(wordCount(text || ''), `${lesson.id}/${id}`).toBeLessThanOrEqual(100);
        }
        for (const question of [...lesson.preflight, ...lesson.application]) {
          const correct = question.choices[question.correct];
          if (!correct) throw new Error('The question requires a correct answer.');
          for (const choice of question.choices) {
            const text = `${question.prompt} ${choice.text} ${correct.text} ${choice.feedback} ${choice === correct ? '' : correct.feedback}`;
            expect(wordCount(text), `${lesson.id}/${question.id}/review`).toBeLessThanOrEqual(100);
          }
        }
      });
    });
  }

  it('uses safe bookmarkable step paths and rejects an empty sequence explicitly', () => {
    expect(lessonStepPath('mdti-hunting', 'example-2')).toBe('/learn/mdti-hunting?step=example-2');
    expect(lessonStepPath('a/b', 'c&d')).toBe('/learn/a%2Fb?step=c%26d');
    expect(() => resolveLessonStep([], 'summary', false, false)).toThrow('learning sequence');
    expect(() => resolveLessonStep([{ id: 'summary', kind: 'summary' }], 'summary', false, false)).toThrow('preparation and application');
  });
});
