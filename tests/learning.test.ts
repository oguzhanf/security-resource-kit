import { describe, expect, it } from 'vitest';
import { lessons } from '../shared/catalog';
import { grade, wordCount } from '../shared/learning-utils';

const lesson = lessons[0];
if (!lesson) throw new Error('The curriculum must contain a lesson.');

describe('member learning utilities', () => {
  it('grades every correct answer', () => {
    expect(grade(lesson.preflight, lesson.preflight.map((question) => question.correct))).toBe(lesson.preflight.length);
  });

  it('grades wrong diagnostic answers without an access decision', () => {
    expect(grade(lesson.preflight, lesson.preflight.map((question) => (question.correct + 1) % question.choices.length))).toBe(0);
  });

  it('counts empty summaries and normalized whitespace correctly', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one\n two\tthree  ')).toBe(3);
  });

  it('treats missing answers as incorrect', () => {
    expect(grade(lesson.preflight, [])).toBe(0);
  });
});
