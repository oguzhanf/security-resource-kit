import type { Question } from './content-types';

export function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

export function grade(questions: readonly Question[], answers: readonly number[]): number {
  return questions.reduce((score, question, index) => score + Number(answers[index] === question.correct), 0);
}
