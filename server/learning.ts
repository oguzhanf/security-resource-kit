import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { grade } from '../shared/learning-utils';
import { readLesson } from './lesson-content';
import type { Progress } from '../shared/contracts';
import { now, rateLimit, requireSession } from './security';
import { attemptSchema, readJson } from './validation';
import type { AppEnv } from './types';

interface ProgressRow {
  lesson_id: string;
  revision: number;
  pre_answers: string;
  pre_score: number;
  post_answers: string | null;
  post_score: number | null;
  completed_at: number | null;
}

function toProgress(row: ProgressRow): Progress {
  return {
    lessonId: row.lesson_id, revision: row.revision,
    preAnswers: JSON.parse(row.pre_answers), preScore: row.pre_score,
    postAnswers: row.post_answers ? JSON.parse(row.post_answers) : null,
    postScore: row.post_score, completedAt: row.completed_at,
  };
}

export const learning = new Hono<AppEnv>();

learning.get('/progress', async (c) => {
  const session = requireSession(c);
  const rows = await c.env.DB.prepare('SELECT * FROM progress WHERE user_id = ?').bind(session.user_id).all<ProgressRow>();
  return c.json(rows.results.map(toProgress));
});

learning.post('/lessons/:id/attempts', async (c) => {
  const session = requireSession(c, { currentConsent: true });
  await rateLimit(c, 'learning', 120, 3600, session.user_id);
  const lesson = await readLesson(c.env.DB, c.req.param('id'));
  if (!lesson) throw new HTTPException(404, { message: 'Lesson not found.' });
  const input = await readJson(c, attemptSchema);
  if (input.revision !== lesson.revision) throw new HTTPException(409, { message: 'This lesson changed. Refresh and complete the current revision.' });
  const questions = input.stage === 'pre' ? lesson.preflight : lesson.application;
  if (input.answers.length !== questions.length || input.answers.some((answer, index) => answer >= (questions[index]?.choices.length || 0))) {
    throw new HTTPException(400, { message: 'Provide one valid choice for every question.' });
  }
  const score = grade(questions, input.answers);
  const time = now();
  if (input.stage === 'pre') {
    await c.env.DB.prepare(
      'INSERT INTO progress (user_id, lesson_id, revision, pre_answers, pre_score, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, lesson_id, revision) DO UPDATE SET pre_answers = excluded.pre_answers, pre_score = excluded.pre_score, updated_at = excluded.updated_at',
    ).bind(session.user_id, lesson.id, lesson.revision, JSON.stringify(input.answers), score, time).run();
  } else {
    const row = await c.env.DB.prepare('SELECT * FROM progress WHERE user_id = ? AND lesson_id = ? AND revision = ?')
      .bind(session.user_id, lesson.id, lesson.revision).first<ProgressRow>();
    if (!row) throw new HTTPException(409, { message: 'Complete the pre-topic diagnostic before the application check.' });
    await c.env.DB.prepare(
      'UPDATE progress SET post_answers = ?, post_score = ?, completed_at = COALESCE(?, completed_at), updated_at = ? WHERE user_id = ? AND lesson_id = ? AND revision = ?',
    ).bind(JSON.stringify(input.answers), score, score === questions.length ? time : null, time, session.user_id, lesson.id, lesson.revision).run();
  }
  const updated = await c.env.DB.prepare('SELECT * FROM progress WHERE user_id = ? AND lesson_id = ? AND revision = ?')
    .bind(session.user_id, lesson.id, lesson.revision).first<ProgressRow>();
  if (!updated) throw new HTTPException(503, { message: 'The learning record could not be saved.' });
  return c.json(toProgress(updated));
});
