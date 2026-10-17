import { test, expect } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { lessons, sources, tracks, wordCount } from '../../shared/catalog';
import type { Lesson } from '../../shared/content-types';
import type { Progress } from '../../shared/contracts';
import { isAnswerReview, lessonStepPath, lessonSteps } from '../../shared/lesson-flow';
import { commentResponseSchema, discussionSchema, forumIndexSchema, forumPageSchema, memberCatalogSchema, progressSchema, sessionSchema, sourceStatusSchema } from '../../shared/api-schemas';
import { TERMS_VERSION, PRIVACY_VERSION } from '../../shared/contracts';
import { randomToken, sha256 } from '../../server/security';
import { MANAGEMENT_GITHUB_USER_ID } from '../../server/management-access';

const origin = 'http://localhost:8787';
const firstLesson = lessons[0];
if (!firstLesson) throw new Error('The initial learning path is required.');
const defenderLessons = lessons.filter((lesson) => lesson.trackId === 'defender-threat-intelligence');
const agentLessons = lessons.filter((lesson) => lesson.trackId === 'agent-identity');
const discussionPageIds = [
  'home', 'about', 'terms', 'privacy', 'sources', 'roadmap', 'account',
  ...tracks.filter((track) => track.status === 'available').map((track) => `track-${track.id}`),
  ...lessons.map((lesson) => lesson.id),
];

function headers(csrfToken?: string | null) {
  return {
    Origin: origin,
    'X-SRK-Request': '1',
    'Content-Type': 'application/json',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  };
}

async function virtualPasskey(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  return { cdp, authenticatorId: await addAuthenticator(cdp) };
}

async function addAuthenticator(cdp: CDPSession): Promise<string> {
  const result = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return result.authenticatorId;
}

async function register(page: Page, handle: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page.getByLabel('Public handle', { exact: true }).fill(handle);
  await page.getByRole('checkbox', { name: /I am 18 or older/u }).check();
  await page.getByRole('button', { name: 'Accept & create passkey', exact: true }).click();
  await expect(page.getByRole('link', { name: `Signed in: ${handle}`, exact: true })).toBeVisible();
  const session = sessionSchema.parse(await (await page.request.get('/api/auth/me')).json());
  if (!session.user || !session.csrfToken) throw new Error('The passkey did not establish an authenticated session.');
  return session;
}

async function removeTestAccount(page: Page, handle: string) {
  const session = sessionSchema.parse(await (await page.request.get('/api/auth/me')).json());
  const response = await page.request.delete('/api/account', { headers: headers(session.csrfToken), data: { confirmHandle: handle } });
  expect(response.status()).toBe(200);
  await page.reload();
}

function localSql(sql: string): void {
  execFileSync(process.execPath, [
    join(process.cwd(), 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
    'd1', 'execute', 'security-resource-kit-local', '--env', 'local', '--local',
    '--persist-to', join(process.cwd(), '.wrangler', 'e2e-state'), '--command', sql, '--json',
  ], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    windowsHide: true,
  });
}

async function expectAnswersWithheld(page: Page, lesson: Lesson) {
  await expect(page.locator('.lesson-nugget > section')).toHaveCount(1);
  await expect(page.locator('.answer-feedback, .answer-review, .exercise-review, .quiz-result')).toHaveCount(0);
  await expect(page.locator('.lesson-nugget')).not.toContainText('Correct answer:');
  await expect(page.locator('.lesson-nugget')).not.toContainText(lesson.exercise.expected);
  await expect(page.locator('.discussion')).toHaveCount(0);
}

async function answerPreparation(page: Page, lesson: Lesson, wrong = false) {
  for (const [index, question] of lesson.preflight.entries()) {
    await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', `pre-${index + 1}`);
    await expect(page.locator('.quiz-pre fieldset')).toHaveCount(1);
    await expect(page.locator('.quiz-post, .gist-text')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await expectAnswersWithheld(page, lesson);
    const answer = wrong ? (question.correct + 1) % question.choices.length : question.correct;
    await page.locator('.quiz-pre').getByRole('radio').nth(answer).check();
    const response = index === lesson.preflight.length - 1
      ? page.waitForResponse((response) => response.url().endsWith(`/api/lessons/${lesson.id}/attempts`) && response.request().method() === 'POST') : null;
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (response) {
      const saved = await response;
      expect(saved.status()).toBe(200);
      expect(progressSchema.parse(await saved.json()).preScore).toBe(wrong ? 0 : lesson.preflight.length);
    }
  }
}

async function readTopicNuggets(page: Page, lesson: Lesson) {
  for (const step of lessonSteps(lesson).filter((step) => ['summary', 'checkpoint', 'evidence', 'example', 'exercise'].includes(step.kind))) {
    await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', step.id);
    await expect(page.locator('.lesson-nugget h2')).toBeFocused();
    await expectAnswersWithheld(page, lesson);
    switch (step.kind) {
      case 'summary':
        await expect(page.locator('.gist-text')).toHaveText(lesson.gist);
        expect(wordCount(await page.locator('.gist-text').innerText())).toBeLessThanOrEqual(100);
        await expect(page.locator('.evidence-item, .code-examples, .exercise, .question')).toHaveCount(0);
        break;
      case 'checkpoint':
        await expect(page.locator('.lesson-nugget')).toContainText(lesson.checkpoints[step.index] || '');
        break;
      case 'evidence':
        await expect(page.locator('.evidence-item')).toHaveCount(1);
        await expect(page.locator('.evidence-item')).toContainText(lesson.evidence[step.index]?.text || '');
        break;
      case 'example':
        await expect(page.locator('.code-examples pre code')).toHaveCount(1);
        await expect(page.locator('.code-examples pre code')).toHaveText(lesson.codeExamples?.[step.index]?.code || '');
        expect(await page.locator('.code-examples pre code').evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Courier New');
        break;
      case 'exercise':
        await expect(page.locator('.exercise')).toContainText(lesson.exercise.prompt);
        break;
    }
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
}

async function answerApplicationAndReview(page: Page, lesson: Lesson, wrong = false): Promise<Progress> {
  let record: Progress | undefined;
  for (const [index, question] of lesson.application.entries()) {
    await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', `post-${index + 1}`);
    await expect(page.locator('.quiz-post fieldset')).toHaveCount(1);
    await expectAnswersWithheld(page, lesson);
    const answer = wrong ? (question.correct + 1) % question.choices.length : question.correct;
    await page.locator('.quiz-post').getByRole('radio').nth(answer).check();
    await expectAnswersWithheld(page, lesson);
    const response = index === lesson.application.length - 1
      ? page.waitForResponse((response) => response.url().endsWith(`/api/lessons/${lesson.id}/attempts`) && response.request().method() === 'POST') : null;
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    if (response) {
      const saved = await response;
      expect(saved.status()).toBe(200);
      record = progressSchema.parse(await saved.json());
      expect(record.postScore).toBe(wrong ? 0 : lesson.application.length);
    }
  }
  if (!record) throw new Error('The application record was not returned.');
  for (const step of lessonSteps(lesson).filter((step) => isAnswerReview(step) && step.kind !== 'complete')) {
    await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', step.id);
    await expect(page.locator('.lesson-nugget > section')).toHaveCount(1);
    await expect(page.locator('.quiz, .gist-text, .discussion')).toHaveCount(0);
    if (step.kind === 'review-pre' || step.kind === 'review-post') {
      const question = (step.kind === 'review-pre' ? lesson.preflight : lesson.application)[step.index];
      if (!question) throw new Error('The review question is missing.');
      await expect(page.locator('.answer-review')).toHaveCount(1);
      await expect(page.locator('.answer-review')).toContainText(`Correct answer: ${question.choices[question.correct]?.text}`);
      await expect(page.locator('.answer-feedback')).toHaveCount(1);
      await expect(page.locator('.lesson-nugget')).not.toContainText(lesson.exercise.expected);
    } else {
      await expect(page.locator('.exercise-review')).toHaveText(`Exercise review${lesson.exercise.expected}`);
      await expect(page.locator('.answer-review')).toHaveCount(0);
    }
    await page.getByRole('button', { name: step.kind === 'review-exercise' ? 'Finish topic' : 'Next', exact: true }).click();
  }
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'complete');
  await expect(page.getByRole('heading', { name: record.completedAt !== null ? 'Topic complete' : 'Topic review complete', exact: true })).toBeVisible();
  return record;
}

test('Defender XDR uses visual nuggets, gated subsection links, collapsed completion, and area contents', async ({ page }) => {
  test.setTimeout(180000);
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  const xdr = lessons.filter((lesson) => lesson.trackId === 'defender-xdr-secops');
  expect(xdr).toHaveLength(7);
  await page.locator('.home').getByRole('link', { name: 'Microsoft Defender XDR SecOps', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Microsoft Defender XDR SecOps topics', exact: true }).locator('tbody tr')).toHaveCount(7);
  const first = xdr[0];
  if (!first) throw new Error('An XDR topic is required.');
  await page.getByRole('table', { name: 'Microsoft Defender XDR SecOps topics', exact: true }).getByRole('link', { name: first.shortTitle, exact: true }).click();
  const navigator = page.getByRole('navigation', { name: 'Resource kit navigation' });
  const branch = navigator.locator('.topic-branch').filter({ has: page.getByRole('button', { name: `Collapse ${first.shortTitle} subsections`, exact: true }) });
  await expect(branch.locator('.step-locked').filter({ hasText: 'Summary' })).toBeVisible();
  for (const [index, lesson] of xdr.entries()) {
    await answerPreparation(page, lesson);
    await expect(page.locator('.teaching-diagram')).toHaveCount(1);
    if (index === 0) {
      await navigator.getByRole('link', { name: 'Summary', exact: true }).click();
      await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'summary');
      const issue = page.getByRole('link', { name: 'Report an issue on GitHub', exact: true });
      const url = new URL(await issue.getAttribute('href') || '');
      expect(url.pathname).toBe('/oguzhanf/security-resource-kit/issues/new');
      expect(url.searchParams.get('body')).toContain(`Topic: ${lesson.id}`);
      expect(url.searchParams.get('body')).not.toContain(handle);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await readTopicNuggets(page, lesson);
    expect((await answerApplicationAndReview(page, lesson)).completedAt).not.toBeNull();
    const next = xdr[index + 1];
    if (next) await expect(navigator.getByRole('button', { name: `Expand ${lesson.shortTitle} subsections`, exact: true })).toBeVisible();
    if (next) await page.getByRole('link', { name: `Next topic: ${next.shortTitle}`, exact: true }).click();
  }
  await expect(page.locator('.topic-complete')).toContainText('Module complete. 7/7 topics complete.');
  await expect(navigator.getByRole('button', { name: 'Expand Microsoft Defender XDR SecOps', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Full Microsoft Defender XDR SecOps table of contents', exact: true }).click();
  await expect(page.getByText('Area complete. Use this full table of contents to revisit any topic or subsection.', { exact: true })).toBeVisible();
  const topicTable = page.getByRole('table', { name: 'Microsoft Defender XDR SecOps topics', exact: true });
  await topicTable.locator('details summary').first().click();
  await topicTable.getByRole('link', { name: 'Summary', exact: true }).first().click();
  await expect(page.locator('.gist-text')).toHaveText(first.gist);
  await page.screenshot({ path: 'test-results/xdr-visual-nugget.png', fullPage: true });
  await page.goto(lessonStepPath(first.id, 'evidence-1'));
  const screenshot = page.locator('.lesson-visual img');
  await expect(screenshot).toHaveCount(1);
  await expect(screenshot).toBeVisible();
  await expect.poll(() => screenshot.evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
  await page.goto(`/learn/${first.id}`);
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'complete');
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('owner edits persist through reload, administration exposes moderation, and public handle changes preserve identity', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const renamed = `${handle}_new`;
  const passkey = await virtualPasskey(page);
  const learner = await register(page, handle);
  if (!learner.user) throw new Error('A test owner is required.');
  const id = z.uuid().parse(learner.user.id);
  const ownerHash = await sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID]));
  localSql(`INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github','${ownerHash}','${id}',${Math.floor(Date.now() / 1000)});`);
  await page.reload();
  await page.goto(`/learn/${firstLesson.id}`);
  await answerPreparation(page, firstLesson);
  await page.getByRole('button', { name: 'Edit this nugget', exact: true }).click();
  const gist = `${firstLesson.gist} Preserve the reviewed object boundaries.`;
  await page.getByLabel('Summary text', { exact: true }).fill(gist);
  await page.getByLabel('Change reason', { exact: true }).fill('Clarify the reviewed object boundaries for training.');
  await page.getByRole('button', { name: 'Validate and preview', exact: true }).click();
  await expect(page.getByLabel('Content preview', { exact: true })).toContainText(gist);
  await page.getByRole('checkbox', { name: /I reviewed the technical accuracy/u }).check();
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/management/content/${firstLesson.id}`));
  await page.getByRole('button', { name: 'Publish reviewed revision', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-1');
  await page.reload();
  const updated = memberCatalogSchema.parse(await (await page.request.get('/api/catalog')).json()).lessons.find((lesson) => lesson.id === firstLesson.id);
  expect(updated?.gist).toBe(gist);
  expect(updated?.revision).toBe(firstLesson.revision + 1);
  await page.locator('.identity-controls').getByRole('link', { name: 'Site management', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Moderate discussions/u })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Site management sections', exact: true });
  await sections.getByRole('button', { name: 'Content history', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Latest 100 reviewed content changes', exact: true })).toContainText('Clarify the reviewed object boundaries for training.');
  await sections.getByRole('button', { name: 'Discussion review', exact: true }).click();
  await page.getByLabel('Contribution status', { exact: true }).selectOption('hidden');
  await expect(page.getByLabel('Contribution status', { exact: true })).toHaveValue('hidden');
  await sections.getByRole('button', { name: 'Training content', exact: true }).click();
  await page.getByLabel('Topic to edit', { exact: true }).selectOption(firstLesson.id);
  await expect(page.getByRole('button', { name: 'Edit structured lesson', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/site-management-content.png', fullPage: true });
  await page.goto('/account');
  await expect(page.getByRole('link', { name: /^Open site management:/u })).toBeVisible();
  await page.getByLabel('Public site handle', { exact: true }).fill(renamed);
  await page.getByRole('button', { name: 'Save public handle', exact: true }).click();
  await expect(page.getByRole('link', { name: `Signed in: ${renamed}`, exact: true })).toBeVisible();
  const after = sessionSchema.parse(await (await page.request.get('/api/auth/me')).json());
  expect(after.user?.id).toBe(id);
  expect(after.managementLink?.href).toBe('/management');
  await removeTestAccount(page, renamed);
  localSql(`DELETE FROM lesson_content WHERE lesson_id='${firstLesson.id}'; DELETE FROM lesson_content_history WHERE lesson_id='${firstLesson.id}';`);
  await passkey.cdp.detach();
});

test('forum activity shows moderation status and the loaded title filter is usable', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  await page.goto('/discussions/site');
  await page.getByLabel('Title', { exact: true }).fill('Synthetic training discussion question');
  await page.getByLabel('Initial post', { exact: true }).fill('How should this synthetic training scenario be investigated?');
  await page.getByRole('button', { name: 'Submit question for moderation', exact: true }).click();
  await expect(page.locator('.discussion .status-tag')).toContainText('awaiting moderation');
  await page.goto('/discussions');
  await page.getByRole('button', { name: 'My contributions', exact: true }).click();
  await expect(page.locator('.activity-list')).toContainText('Synthetic training discussion question');
  await expect(page.locator('.activity-list')).toContainText('pending');
  await page.getByRole('button', { name: 'Replies to my posts', exact: true }).click();
  await expect(page.getByText('No accessible activity.', { exact: true })).toBeVisible();
  await page.goto('/discussions/site');
  await page.getByLabel('Find a discussion in the loaded list', { exact: true }).fill('Synthetic training discussion');
  await expect(page.getByRole('table', { name: 'Independent questions', exact: true }).locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Find a discussion in the loaded list', { exact: true }).fill('no-matching-title');
  await expect(page.getByRole('table', { name: 'Independent questions', exact: true }).locator('tbody tr')).toHaveCount(0);
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('guests receive only registration information and a reduced non-clickable tree', async ({ page, request: api }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Security Resource Kit', exact: true })).toBeVisible();
  await expect(page.getByText('This site provides free training', { exact: false })).toBeVisible();
  const navigator = page.getByRole('navigation', { name: 'Resource kit navigation' });
  await expect(navigator.getByRole('button', { name: 'Index', exact: true })).toBeDisabled();
  await expect(navigator.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
  await expect(navigator.locator('.tree-locked').filter({ hasText: 'Microsoft Defender Threat Intelligence' })).toBeVisible();
  await expect(navigator.locator('.tree-locked a')).toHaveCount(0);
  await expect(navigator).not.toContainText('Availability and E5 entitlement');
  await expect(navigator.locator('a[href^="/learn/"], a[href^="/tracks/"], a[href="/sources"], a[href="/about"], a[href="/account"], a[href^="/discussions"]')).toHaveCount(0);
  await expect(page.locator('.quiz, .gist-text, .discussion')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Site management', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    window.history.pushState(null, '', '/learn/identity-model');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.locator('.registration-landing')).toBeVisible();
  await expect(page.locator('.quiz, .gist-text, .discussion')).toHaveCount(0);
  for (const path of [
    '/learn/identity-model', '/tracks/agent-identity', '/tracks/defender-threat-intelligence',
    '/learn/mdti-hunting', '/sources', '/roadmap', '/about', '/account', '/management', '/management/hidden',
    '/discussions', '/discussions/site', '/discussions/agent-identity/page-identity-model',
  ]) {
    const response = await api.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(303);
    expect(response.headers().location).toBe('/');
    expect(response.headers()['cache-control']).toBe('no-store');
    await page.goto(path);
    await expect(page.locator('.registration-landing')).toContainText('Registration and sign-in are required');
    await expect(page.locator('.quiz, .gist-text, .discussion')).toHaveCount(0);
  }
  const image = await api.get('/training-media/defender-incident-graph.png', { maxRedirects: 0 });
  expect(image.status()).toBe(303);
  expect(image.headers()['cache-control']).toBe('no-store');
  const outline = await (await api.get('/api/outline')).json();
  expect(Array.isArray(outline)).toBe(true);
  expect(outline.every((track: Record<string, unknown>) => Object.keys(track).sort().join(',') === 'id,status,title')).toBe(true);
  expect(outline).toContainEqual({ id: 'defender-threat-intelligence', title: 'Microsoft Defender Threat Intelligence', status: 'available' });
  const html = await (await api.get('/')).text();
  const bundlePath = /src="([^"]+\.js)"/u.exec(html)?.[1];
  if (!bundlePath) throw new Error('The public application bundle was not found.');
  const bundle = await (await api.get(bundlePath)).text();
  expect(bundle).not.toContain(firstLesson.gist);
  expect(bundle).not.toContain(firstLesson.preflight[0]?.scenario);
  expect(bundle).not.toContain('raw.githubusercontent.com/MicrosoftDocs/entra-docs');
  expect(bundle).not.toContain('/security/threatIntelligence/');
  for (const lesson of defenderLessons) {
    expect(bundle).not.toContain(lesson.gist);
    expect(bundle).not.toContain(lesson.preflight[0]?.scenario);
    for (const evidence of lesson.evidence.filter((entry) => entry.documentationConflict)) {
      expect(bundle).not.toContain(evidence.text);
    }
  }
  const visitorConfig = await (await api.get('/api/config')).json();
  expect(Object.hasOwn(visitorConfig, 'setupRequired')).toBe(false);
});

test('only the personal GitHub owner receives the server-generated top-bar management link', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  const learner = await register(page, handle);
  if (!learner.user) throw new Error('Missing test learner.');
  const userId = z.uuid().parse(learner.user.id);
  await expect(page.getByRole('link', { name: 'Site management', exact: true })).toHaveCount(0);
  expect((await page.request.get('/management')).status()).toBe(403);
  expect((await page.request.get('/api/management/overview')).status()).toBe(403);
  const ownerHash = await sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID]));
  localSql(`INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github','${ownerHash}','${userId}',${Math.floor(Date.now() / 1000)});`);
  await page.reload();
  const managementLink = page.locator('.identity-controls').getByRole('link', { name: 'Site management', exact: true });
  await expect(managementLink).toHaveAttribute('href', '/management');
  await managementLink.click();
  await expect(page).toHaveURL(/\/management$/u);
  await expect(page.getByRole('heading', { name: 'Site management', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Site status', exact: true })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Site management sections', exact: true });
  await sections.getByRole('button', { name: 'Accounts', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Latest 100 accounts', exact: true })).toContainText(handle);
  await sections.getByRole('button', { name: 'Private requests', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private requests', exact: true })).toBeVisible();
  await sections.getByRole('button', { name: 'References', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Reference checks', exact: true }).locator('tbody tr')).toHaveCount(sources.length);
  localSql(`DELETE FROM social_identities WHERE user_id='${userId}';`);
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Access unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Site management', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/management/accounts')).status()).toBe(403);
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('closed registration uses visitor messages, not operator setup instructions', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const configuration = await response.json();
    await route.fulfill({ response, json: { ...configuration, registrationEnabled: false, environment: 'production' } });
  });
  await page.goto('/');
  await expect(page.locator('.registration-landing')).toContainText('Registration is currently unavailable.');
  await expect(page.locator('body')).not.toContainText('The operator must');
  await expect(page.locator('body')).not.toContainText('policy review');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Registration is currently unavailable.');
  await expect(dialog.locator('form')).toHaveCount(0);
  await expect(dialog).not.toContainText('Configure');
  await expect(dialog).not.toContainText('Turnstile');
  await expect(dialog).not.toContainText('Operator approval');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  for (const path of ['/terms', '/privacy']) {
    await page.goto(path);
    await expect(page.locator('body')).not.toContainText('before launch');
    await expect(page.locator('body')).not.toContainText('launch configuration');
    await expect(page.locator('body')).not.toContainText('The operator must');
  }
});

test('existing-account registration does not invoke a passkey and returns provider cancellation safely', async ({ page }) => {
  let authorization: URL | null = null;
  await page.route('https://github.com/login/oauth/authorize**', async (route) => {
    authorization = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled provider page</title><h1>Provider fixture</h1>' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Continue with Microsoft', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue with GitHub', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Passkeys are optional.');
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await dialog.getByLabel('Public handle', { exact: true }).fill(handle);
  await dialog.getByRole('checkbox', { name: /I am 18 or older/u }).check();
  const started = page.waitForRequest((request) => request.url().endsWith('/api/auth/social/github/start'));
  await dialog.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/github\.com\/login\/oauth\/authorize\?/u);
  const input = (await started).postDataJSON();
  expect(input).toMatchObject({ intent: 'register', handle, accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION });
  const target = new URL(page.url());
  expect(authorization).not.toBeNull();
  expect(target.searchParams.get('scope')).toBe('');
  expect(target.searchParams.get('code_challenge_method')).toBe('S256');
  expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(target.searchParams.has('client_secret')).toBe(false);
  expect(target.searchParams.has('code_verifier')).toBe(false);
  const flowCookie = (await page.context().cookies(origin)).find((entry) => entry.name === 'srk-oauth');
  expect(flowCookie?.httpOnly).toBe(true);
  expect(flowCookie?.sameSite).toBe('Lax');
  await page.goto(`${origin}/api/auth/social/github/callback?state=${target.searchParams.get('state')}&error=access_denied`);
  await expect(page.locator('.registration-landing')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Account sign-in was cancelled.');
  expect(page.url()).not.toContain('authError');
  expect(sessionSchema.parse(await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  expect((await page.request.get('/api/catalog')).status()).toBe(401);
});

test('Microsoft sign-in sends only identity scopes and handles a cross-site cancellation', async ({ page }) => {
  await page.route('https://login.microsoftonline.com/common/oauth2/v2.0/authorize**', async (route) => {
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Controlled provider page</title><h1>Provider fixture</h1>' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in with Microsoft', exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/u);
  const target = new URL(page.url());
  expect(target.searchParams.get('scope')).toBe('openid profile');
  expect(target.searchParams.get('nonce')).toMatch(/^[a-f0-9]{64}$/u);
  expect(target.searchParams.get('response_type')).toBe('code');
  expect(target.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/social/microsoft/callback`);
  await page.goto(`${origin}/api/auth/social/microsoft/callback?state=${target.searchParams.get('state')}&error=access_denied`);
  await expect(page.getByRole('alert')).toContainText('Account sign-in was cancelled.');
  await expect(page.locator('.quiz, .gist-text, .discussion')).toHaveCount(0);
});

test('separate preparation, saved drafts, Next and Back, delayed review, failed saves, and topic handover', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Security Resource Kit', exact: true })).toBeVisible();
  const navigator = page.getByRole('navigation', { name: 'Resource kit navigation' });
  await expect(navigator.getByRole('button', { name: 'Contents', exact: true })).toBeVisible();
  await expect(navigator.getByRole('button', { name: 'Index', exact: true })).toBeVisible();
  await navigator.getByRole('button', { name: 'Search', exact: true }).click();
  await navigator.getByLabel('Find a concept').fill('blueprint');
  await expect(navigator.getByRole('link', { name: 'Blueprint security', exact: true })).toBeVisible();
  await navigator.getByRole('button', { name: 'Contents', exact: true }).click();
  await navigator.getByRole('link', { name: '01. Agent identity objects', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/identity-model$/u);
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.goto(lessonStepPath(firstLesson.id, 'review-pre-1'));
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-1');
  await expectAnswersWithheld(page, firstLesson);
  const firstQuestion = firstLesson.preflight[0];
  const secondQuestion = firstLesson.preflight[1];
  if (!firstQuestion || !secondQuestion) throw new Error('Two preparation questions are required.');
  const firstWrong = (firstQuestion.correct + 1) % firstQuestion.choices.length;
  await page.locator('.quiz-pre').getByRole('radio').nth(firstWrong).check();
  await expectAnswersWithheld(page, firstLesson);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-2');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.quiz-pre').getByRole('radio').nth(firstWrong)).toBeChecked();
  await page.goBack();
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-2');
  await page.reload();
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-2');
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await page.locator('.quiz-pre').getByRole('radio').nth((secondQuestion.correct + 1) % secondQuestion.choices.length).check();
  await page.route(`**/api/lessons/${firstLesson.id}/attempts`, (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic record-save failure.' }),
  }));
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The record was not saved');
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-2');
  await expectAnswersWithheld(page, firstLesson);
  expect(z.array(progressSchema).parse(await (await page.request.get('/api/progress')).json())).toHaveLength(0);
  await page.unroute(`**/api/lessons/${firstLesson.id}/attempts`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.gist-text')).toHaveText(firstLesson.gist);
  const preparation = z.array(progressSchema).parse(await (await page.request.get('/api/progress')).json())[0];
  expect(preparation?.preScore).toBe(0);
  await page.reload();
  await expect(page.locator('.gist-text')).toHaveText(firstLesson.gist);
  await readTopicNuggets(page, firstLesson);
  await page.goto(lessonStepPath(firstLesson.id, 'review-exercise'));
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'post-1');
  await expectAnswersWithheld(page, firstLesson);
  const wrongApplication = await answerApplicationAndReview(page, firstLesson, true);
  expect(wrongApplication.completedAt).toBeNull();
  await expect(page.locator('.next-topic-link')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry application question', exact: true }).click();
  const completed = await answerApplicationAndReview(page, firstLesson);
  expect(completed.completedAt).not.toBeNull();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'review-exercise');
  await page.goBack();
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'complete');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Topic complete', exact: true })).toBeVisible();
  await expect(navigator.locator('.completed-dot')).toHaveCount(1);
  await navigator.getByRole('link', { name: '01. Agent identity objects Completed', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/identity-model$/u);
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'complete');
  await expect(page.getByRole('list', { name: `${firstLesson.shortTitle} table of contents`, exact: true })).toBeVisible();
  await page.goto(lessonStepPath(firstLesson.id, 'complete'));
  const nextTopic = agentLessons[1];
  if (!nextTopic) throw new Error('The module requires a next topic.');
  await page.getByRole('link', { name: `Next topic: ${nextTopic.shortTitle}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/learn/${nextTopic.id}$`, 'u'));
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-1');
  await expectAnswersWithheld(page, nextTopic);
  await page.getByRole('link', { name: 'Discuss this topic', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/discussions/agent-identity/page-${nextTopic.id}$`, 'u'));
  await expect(page.locator('.discussion')).toBeVisible();
  await page.locator('.discussion').getByRole('link', { name: 'Attached page', exact: true }).click();
  await expect(page.locator('.discussion')).toHaveCount(0);
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-1');
  await page.goto('/');
  await page.screenshot({ path: 'test-results/resource-kit-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('.registration-landing')).toBeVisible();
  await expect(navigator.locator('a[href^="/learn/"]')).toHaveCount(0);
  expect((await page.request.get('/api/catalog')).status()).toBe(401);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Use my passkey', exact: true }).click();
  await expect(page.getByRole('link', { name: `Signed in: ${handle}`, exact: true })).toBeVisible();
  await removeTestAccount(page, handle);
  await expect(page.getByText('This site provides free training', { exact: false })).toBeVisible();
  await expect(navigator.locator('a[href^="/learn/"]')).toHaveCount(0);
  await passkey.cdp.detach();
});

test('mobile navigation stays usable without horizontal overflow', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const navigator = page.getByRole('navigation', { name: 'Resource kit navigation' });
  await expect(navigator).toBeHidden();
  await page.locator('.mobile-nav-toggle').click();
  await expect(navigator).toBeVisible();
  await navigator.getByRole('link', { name: '01. Agent identity objects', exact: true }).click();
  await expect(page.getByRole('heading', { name: firstLesson.title, exact: true })).toBeVisible();
  await expect(navigator).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/resource-kit-mobile.png', fullPage: true });
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('Defender TI follows Next topic through all eight nugget sequences and records module completion', async ({ page }) => {
  test.setTimeout(180000);
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  const catalog = memberCatalogSchema.parse(await (await page.request.get('/api/catalog')).json());
  expect(catalog.lessons.filter((lesson) => lesson.trackId === 'defender-threat-intelligence')).toEqual(defenderLessons);
  await page.locator('.home').getByRole('link', { name: 'Microsoft Defender Threat Intelligence', exact: true }).click();
  const topicTable = page.getByRole('table', { name: 'Microsoft Defender Threat Intelligence topics', exact: true });
  await expect(topicTable.locator('tbody tr')).toHaveCount(8);
  const navigator = page.getByRole('navigation', { name: 'Resource kit navigation' });
  await navigator.getByRole('button', { name: 'Expand Microsoft Defender Threat Intelligence', exact: true }).click();
  await navigator.getByRole('button', { name: 'Index', exact: true }).click();
  await expect(navigator.locator('.index-list a')).toHaveCount(lessons.length);
  await navigator.getByRole('link', { name: 'Microsoft Graph Threat Intelligence API Access', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/mdti-graph-api$/u);
  await navigator.getByRole('button', { name: 'Search', exact: true }).click();
  await navigator.getByLabel('Find a concept').fill('TAXII');
  await navigator.getByRole('link', { name: 'Third-party API and data access', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/mdti-third-party-access$/u);
  await expect(page.locator('.gist-text, .code-examples')).toHaveCount(0);
  await navigator.getByRole('button', { name: 'Contents', exact: true }).click();

  await navigator.getByRole('link', { name: '01. Availability and E5 entitlement', exact: true }).click();
  for (const [lessonIndex, lesson] of defenderLessons.entries()) {
    await expect(page.getByRole('heading', { name: lesson.title, exact: true })).toBeVisible();
    await expect(page.locator('.gist-text, .code-examples')).toHaveCount(0);
    await answerPreparation(page, lesson, lessonIndex === 0);
    await readTopicNuggets(page, lesson);
    expect((await answerApplicationAndReview(page, lesson)).completedAt).not.toBeNull();
    const nextTopic = defenderLessons[lessonIndex + 1];
    if (nextTopic) await page.getByRole('link', { name: `Next topic: ${nextTopic.shortTitle}`, exact: true }).click();
  }
  const progress = z.array(progressSchema).parse(await (await page.request.get('/api/progress')).json());
  expect(progress.filter((entry) => defenderLessons.some((lesson) => lesson.id === entry.lessonId) && entry.completedAt !== null)).toHaveLength(8);
  await expect(page.locator('.topic-complete')).toContainText('Module complete. 8/8 topics complete.');
  await page.reload();
  await expect(page.locator('.topic-complete')).toContainText('Module complete. 8/8 topics complete.');
  await navigator.getByRole('button', { name: 'Expand Microsoft Defender Threat Intelligence', exact: true }).click();
  await expect(navigator.locator('.completed-dot')).toHaveCount(8);
  await navigator.getByRole('link', { name: 'References and review status', exact: true }).click();
  await expect(page.locator('article .notice')).not.toContainText('beta overview still carries');
  await expect(page.locator('article .notice')).toContainText('delegated ThreatIntelligence.Read');
  await expect(page.locator('article .notice')).toContainText('The concept page describes scopes and application roles');
  await expect(page.locator('.source-table tbody tr')).toHaveCount(sources.length);

  const inertCode = '<script>window.__srk_code_executed = true</script>';
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch();
    const content = memberCatalogSchema.parse(await response.json());
    content.lessons = content.lessons.map((lesson) => lesson.id !== 'mdti-hunting' ? lesson : {
      ...lesson,
      codeExamples: lesson.codeExamples?.map((example) => ({ ...example, code: `${example.code}\n${inertCode}` })),
    });
    await route.fulfill({ response, json: content });
  });
  await page.goto(lessonStepPath('mdti-hunting', 'example-1'));
  await expect(page.locator('.code-examples pre').first()).toContainText(inertCode);
  await expect(page.locator('.code-examples script')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.has(window, '__srk_code_executed'))).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.unroute('**/api/catalog');
  await removeTestAccount(page, handle);
  await expect(page.locator('.gist-text, .code-examples, .discussion')).toHaveCount(0);
  await passkey.cdp.detach();
});

test('Agent Identity uses the same six-topic sequence and cannot complete a module from browser flags', async ({ page }) => {
  test.setTimeout(180000);
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  const learner = await register(page, handle);
  if (!learner.user) throw new Error('The learner is required.');
  await page.goto(lessonStepPath(firstLesson.id, 'complete'));
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-1');
  await page.evaluate(({ lesson, learnerId }) => {
    window.history.replaceState({ lessonDraft: {
      learnerId, lessonId: lesson.id, revision: lesson.revision,
      preAnswers: lesson.preflight.map((question) => question.correct),
      postAnswers: lesson.application.map((question) => question.correct),
      prepared: true, applied: true, completedAt: 123,
    } }, '', `/learn/${lesson.id}?step=complete`);
  }, { lesson: firstLesson, learnerId: learner.user.id });
  await page.reload();
  await expect(page.locator('.lesson-nugget')).toHaveAttribute('data-step', 'pre-1');
  await expectAnswersWithheld(page, firstLesson);
  expect(z.array(progressSchema).parse(await (await page.request.get('/api/progress')).json())).toHaveLength(0);
  await page.evaluate(() => {
    const state = window.history.state;
    window.history.replaceState({ lessonDraft: { ...state.lessonDraft, learnerId: 'another-account' } }, '');
  });
  await page.reload();
  await expect(page.locator('.quiz-pre input:checked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  for (const [index, lesson] of agentLessons.entries()) {
    await expect(page.getByRole('heading', { name: lesson.title, exact: true })).toBeVisible();
    await answerPreparation(page, lesson);
    await readTopicNuggets(page, lesson);
    expect((await answerApplicationAndReview(page, lesson)).completedAt).not.toBeNull();
    const nextTopic = agentLessons[index + 1];
    if (nextTopic) await page.getByRole('link', { name: `Next topic: ${nextTopic.shortTitle}`, exact: true }).click();
  }
  await expect(page.locator('.topic-complete')).toContainText('Module complete. 6/6 topics complete.');
  await page.reload();
  await expect(page.locator('.topic-complete')).toContainText('Module complete. 6/6 topics complete.');
  const progress = z.array(progressSchema).parse(await (await page.request.get('/api/progress')).json());
  expect(progress.filter((entry) => agentLessons.some((lesson) => lesson.id === entry.lessonId) && entry.completedAt !== null)).toHaveLength(6);
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('technical-reference typography and page headings contain no promotional copy', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  const pages = [
    ['/', 'Security Resource Kit'],
    ['/about', 'About the Security Resource Kit'],
    ['/roadmap', 'Planned Topics'],
    ['/sources', 'References and Review Status'],
    ['/privacy', 'Privacy Notice'],
    ['/discussions', 'Discussions'],
  ] as const;
  for (const [path, heading] of pages) {
    await page.goto(path);
    const title = page.getByRole('heading', { name: heading, exact: true });
    await expect(title).toBeVisible();
    const typography = await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, size: parseFloat(style.fontSize), weight: style.fontWeight };
    });
    expect(typography.family, `${path} heading font`).toMatch(/^["']?Verdana["']?(?:\s*,|$)/iu);
    expect(typography.size).toBeLessThanOrEqual(18);
    expect(typography.weight).toBe('700');
    await expect(page.locator('body')).not.toContainText('Fewer words. Deeper understanding.');
    await expect(page.locator('body')).not.toContainText('The depth stays.');
    await expect(page.locator('body')).not.toContainText('No filler.');
    await expect(page.locator('body')).not.toContainText('authority theater');
  }
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('request boundaries and all content endpoints deny anonymous access', async ({ request: api }) => {
  expect((await api.get('/api/health')).status()).toBe(200);
  expect((await api.post('/api/auth/register/options', { headers: { ...headers(), Origin: 'https://attacker.example' }, data: {} })).status()).toBe(403);
  expect((await api.post('/api/auth/register/options', { headers: { 'Content-Type': 'application/json', Origin: origin }, data: {} })).status()).toBe(403);
  expect((await api.post('/api/auth/register/options', { headers: { ...headers(), 'Content-Type': 'text/plain' }, data: 'not-json' })).status()).toBe(415);
  expect((await api.post('/api/auth/register/options', {
    headers: headers(), data: { handle: 'valid-test', accepted: false, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
  })).status()).toBe(400);
  expect((await api.post('/api/auth/register/options', {
    headers: headers(), data: { handle: 'valid-test', accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, role: 'moderator' },
  })).status()).toBe(400);
  expect((await api.post('/api/auth/register/options', { headers: headers(), data: 'x'.repeat(33000) })).status()).toBe(413);
  expect((await api.post('/api/auth/login/verify', { headers: headers(), data: {} })).status()).toBe(400);
  expect((await api.get('/api/moderation')).status()).toBe(401);
  expect((await api.post('/api/discussions/home', { headers: headers(), data: { body: 'Unauthorized contribution.' } })).status()).toBe(401);
  expect((await api.get('/api/discussions/not-a-real-page')).status()).toBe(401);
  for (const path of ['/api/catalog', '/api/sources', '/api/progress', '/api/account', '/api/forums', '/api/forums/site', '/api/threads/page-home', `/api/comments/${crypto.randomUUID()}/replies`, '/api/future-content']) {
    expect((await api.get(path)).status(), path).toBe(401);
  }
  for (const id of discussionPageIds) {
    const response = await api.get(`/api/discussions/${id}`);
    expect(response.status(), id).toBe(401);
  }
  const health = await api.get('/api/health');
  expect(health.headers()['cache-control']).toBe('no-store');
  expect(health.headers()['x-content-type-options']).toBe('nosniff');
  expect(health.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  const document = await api.get('/');
  expect(document.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(document.headers()['content-security-policy']).not.toContain("'unsafe-inline'");
});

test('private contact is available without registration and never readable anonymously', async ({ page }) => {
  await page.goto('/contact');
  await expect(page.getByRole('heading', { name: 'Contact the Operator', exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Private account request submitted through the protected contact form.');
  await page.getByLabel('Reply email (optional)', { exact: true }).fill('reply@example.test');
  await page.getByRole('button', { name: 'Send private request', exact: true }).click();
  await expect(page.getByText('Request received.', { exact: false })).toBeVisible();
  expect((await page.request.get('/api/moderation/contacts')).status()).toBe(401);
  expect((await page.request.get('/api/contact')).status()).toBe(401);
  expect((await page.request.post('/api/contact', {
    headers: { ...headers(), Origin: 'https://attacker.example' },
    data: { message: 'A cross-site request that must be rejected.' },
  })).status()).toBe(403);
  expect((await page.request.post('/api/contact', {
    headers: headers(), data: { message: 'Private request with unexpected identity.', userId: 'another-user' },
  })).status()).toBe(400);
});

test('verified passkeys, server grading, ownership, moderation, reporting, revocation, and deletion', async ({ page, browser }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const otherHandle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  const learner = await register(page, handle);
  if (!learner.user) throw new Error('Missing learner.');
  const userId = z.uuid().parse(learner.user.id);
  expect((await page.request.get('/api/catalog')).status()).toBe(200);
  for (const id of discussionPageIds) {
    const response = await page.request.get(`/api/discussions/${id}`);
    expect(response.status()).toBe(200);
    expect(discussionSchema.safeParse(await response.json()).success).toBe(true);
  }
  const cookie = (await page.context().cookies()).find((value) => value.name === 'srk-session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  expect(cookie?.value).toMatch(/^[a-f0-9]{64}$/u);
  const accountKeysSchema = z.object({ passkeys: z.array(z.object({ id: z.string() })) });
  const originalKey = accountKeysSchema.parse(await (await page.request.get('/api/account')).json()).passkeys[0];
  if (!originalKey) throw new Error('Registration did not persist a passkey.');
  const extraToken = randomToken();
  const extraHash = await sha256(extraToken);
  const extraCsrf = randomToken();
  const time = Math.floor(Date.now() / 1000);
  localSql(`INSERT INTO sessions (token_hash, user_id, csrf_token, authenticated_at, expires_at) VALUES ('${extraHash}', '${userId}', '${extraCsrf}', ${time}, ${time + 3600});`);
  const extraContext = await browser.newContext();
  await extraContext.addCookies([{ name: 'srk-session', value: extraToken, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' }]);
  expect(sessionSchema.parse(await (await extraContext.request.get(`${origin}/api/auth/me`)).json()).user?.id).toBe(userId);
  expect((await page.request.delete(`/api/auth/passkeys/${originalKey.id}`, { headers: headers(learner.csrfToken), data: {} })).status()).toBe(409);
  expect(sessionSchema.parse(await (await extraContext.request.get(`${origin}/api/auth/me`)).json()).user?.id).toBe(userId);
  await page.getByRole('link', { name: `Signed in: ${handle}`, exact: true }).click();
  await passkey.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: passkey.authenticatorId });
  await addAuthenticator(passkey.cdp);
  await page.getByRole('button', { name: 'Add a backup passkey', exact: true }).click();
  await expect(page.getByText('Backup passkey added.', { exact: true })).toBeVisible();
  expect(accountKeysSchema.parse(await (await page.request.get('/api/account')).json()).passkeys).toHaveLength(2);
  expect((await page.request.delete(`/api/auth/passkeys/${originalKey.id}`, { headers: headers(learner.csrfToken), data: {} })).status()).toBe(200);
  expect(sessionSchema.parse(await (await extraContext.request.get(`${origin}/api/auth/me`)).json()).user).toBeNull();
  expect(sessionSchema.parse(await (await page.request.get('/api/auth/me')).json()).user?.id).toBe(userId);
  await extraContext.close();
  await page.goto('/');

  expect((await page.request.get('/api/moderation')).status()).toBe(403);
  expect((await page.request.get('/api/moderation/contacts')).status()).toBe(403);
  const privateMessage = 'A private security request that must not appear in any page discussion.';
  const privateRequest = await page.request.post('/api/contact', {
    headers: headers(learner.csrfToken), data: { message: privateMessage, replyEmail: 'reply@example.test' },
  });
  expect(privateRequest.status()).toBe(201);
  const privateReference = z.object({ received: z.literal(true), reference: z.uuid() }).parse(await privateRequest.json()).reference;
  expect((await page.request.post('/api/contact', {
    headers: headers(), data: { message: 'Missing CSRF token must not attach a private request to this user.' },
  })).status()).toBe(403);
  expect((await page.request.post('/api/discussions/home', { headers: headers('a'.repeat(64)), data: { body: 'Invalid security token.' } })).status()).toBe(403);
  expect((await page.request.post('/api/discussions/home', {
    headers: headers(learner.csrfToken), data: { body: `Bearer ${'x'.repeat(60)}` },
  })).status()).toBe(400);
  expect((await page.request.post(`/api/lessons/${firstLesson.id}/attempts`, {
    headers: headers(learner.csrfToken), data: { stage: 'post', revision: 1, answers: [0] },
  })).status()).toBe(409);
  expect((await page.request.post(`/api/lessons/${firstLesson.id}/attempts`, {
    headers: headers(learner.csrfToken), data: { stage: 'pre', revision: 1, answers: [0, 0], completedAt: 123 },
  })).status()).toBe(400);
  const wrong = await page.request.post(`/api/lessons/${firstLesson.id}/attempts`, {
    headers: headers(learner.csrfToken),
    data: { stage: 'pre', revision: firstLesson.revision, answers: firstLesson.preflight.map((question) => (question.correct + 1) % question.choices.length) },
  });
  expect(progressSchema.parse(await wrong.json()).preScore).toBe(0);
  const application = await page.request.post(`/api/lessons/${firstLesson.id}/attempts`, {
    headers: headers(learner.csrfToken),
    data: { stage: 'post', revision: firstLesson.revision, answers: firstLesson.application.map((question) => question.correct) },
  });
  expect(progressSchema.parse(await application.json()).completedAt).not.toBeNull();

  const inertText = '<img src=x onerror="window.__srk_xss=1"> is an inert synthetic security-test string.';
  await page.getByLabel(`Contribute as ${handle}`).fill(inertText);
  await page.getByRole('button', { name: 'Submit for moderation', exact: true }).click();
  await expect(page.getByText('Contribution saved for moderation.', { exact: false })).toBeVisible();
  await expect(page.locator('.comment-body')).toHaveText(inertText);
  expect(await page.locator('.comment-body img').count()).toBe(0);
  expect(await page.evaluate(() => Reflect.has(window, '__srk_xss'))).toBe(false);
  const own = discussionSchema.parse(await (await page.request.get('/api/discussions/home')).json());
  const contribution = own.comments.find((comment) => comment.body === inertText);
  if (!contribution) throw new Error('Pending contribution was not persisted.');
  expect(contribution.status).toBe('pending');

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  const otherCdp = await virtualPasskey(otherPage);
  const otherLearner = await register(otherPage, otherHandle);
  expect(discussionSchema.parse(await (await otherPage.request.get('/api/discussions/home')).json()).comments).toHaveLength(0);
  expect((await otherPage.request.delete(`/api/comments/${contribution.id}`, { headers: headers(otherLearner.csrfToken), data: {} })).status()).toBe(404);
  expect(z.array(progressSchema).parse(await (await otherPage.request.get('/api/progress')).json())).toHaveLength(0);
  expect((await otherPage.request.post('/api/discussions/not-a-real-page', {
    headers: headers(otherLearner.csrfToken), data: { body: 'A valid but unknown page contribution.' },
  })).status()).toBe(404);

  localSql(`UPDATE users SET role = 'moderator' WHERE id = '${userId}';`);
  await page.reload();
  await page.getByRole('link', { name: `Signed in: ${handle}`, exact: true }).click();
  await page.getByRole('button', { name: 'Load private requests', exact: true }).click();
  await expect(page.locator('.private-contact-queue')).toContainText(privateMessage);
  const privateEntry = page.locator('.private-contact-queue .comment').filter({ hasText: privateReference });
  await privateEntry.getByRole('button', { name: 'Mark resolved', exact: true }).click();
  await expect(privateEntry).toHaveCount(0);
  await page.getByRole('button', { name: 'Load pending and reported contributions', exact: true }).click();
  await expect(page.locator('.moderation .comment-body')).toHaveText(inertText);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await otherPage.reload();
  await expect(otherPage.locator('.comment-body')).toHaveText(inertText);
  expect(await otherPage.locator('.comment-body img').count()).toBe(0);
  await otherPage.getByRole('button', { name: 'Report', exact: true }).click();
  await otherPage.getByLabel('Reason for moderator review').fill('Synthetic markup requires a plain-text rendering check.');
  await otherPage.getByRole('button', { name: 'Send report', exact: true }).click();
  await expect(otherPage.getByText('Report sent to the moderation queue.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Load pending and reported contributions', exact: true }).click();
  await expect(page.getByText('Synthetic markup requires a plain-text rendering check.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await otherPage.reload();
  await expect(otherPage.locator('.comment-body')).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export my account data', exact: true }).click();
  const downloaded = await downloadPromise;
  const downloadedPath = await downloaded.path();
  if (!downloadedPath) throw new Error('Account export was not downloaded.');
  const exported = JSON.parse(await readFile(downloadedPath, 'utf8'));
  expect(exported.account.id).toBe(userId);
  expect(exported.consents[0].terms_version).toBe(TERMS_VERSION);
  expect(exported.contactRequests.some((entry: { message: string }) => entry.message === privateMessage)).toBe(true);
  expect(JSON.stringify(exported)).not.toContain('public_key');
  expect(JSON.stringify(exported)).not.toContain('token_hash');

  localSql(`UPDATE sessions SET authenticated_at = authenticated_at - 301 WHERE user_id = '${userId}';`);
  expect((await page.request.get('/api/account/export')).status()).toBe(403);
  await page.getByRole('button', { name: 'Sign in again for sensitive actions', exact: true }).click();
  await page.getByRole('button', { name: 'Use my passkey', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const newSession = sessionSchema.parse(await (await page.request.get('/api/auth/me')).json());
  expect(newSession.csrfToken).not.toBe(learner.csrfToken);
  expect((await page.context().cookies()).find((value) => value.name === 'srk-session')?.value).not.toBe(cookie?.value);
  expect((await page.request.post('/api/account/consent', {
    headers: headers(learner.csrfToken), data: { accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
  })).status()).toBe(403);

  await page.getByLabel(`Type ${handle} to confirm`, { exact: true }).fill(handle);
  await page.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();
  await expect(page.getByRole('link', { name: `Signed in: ${handle}`, exact: true })).toHaveCount(0);
  expect(sessionSchema.parse(await (await page.request.get('/api/auth/me')).json()).user).toBeNull();
  expect(discussionSchema.parse(await (await otherPage.request.get('/api/discussions/home')).json()).comments).toHaveLength(0);
  await otherPage.goto('/account');
  await otherPage.getByLabel(`Type ${otherHandle} to confirm`, { exact: true }).fill(otherHandle);
  await otherPage.getByRole('button', { name: 'Permanently delete my account', exact: true }).click();
  await expect(otherPage.getByRole('link', { name: `Signed in: ${otherHandle}`, exact: true })).toHaveCount(0);
  await otherCdp.cdp.detach();
  await otherContext.close();
  await passkey.cdp.detach();
});

test('central course categories aggregate the exact page conversation and member posting has no Turnstile', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  const robotRequests: string[] = [];
  page.on('request', (request) => { if (request.url().startsWith('https://challenges.cloudflare.com/')) robotRequests.push(request.url()); });
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), turnstileSiteKey: 'must-not-be-used-for-member-posts' } });
  });
  await page.goto('/discussions');
  const categories = page.getByRole('table', { name: 'Discussion categories', exact: true });
  await expect(categories.locator('tbody tr')).toHaveCount(5);
  await expect(categories).toContainText('6 topics');
  await expect(categories).toContainText('8 topics');
  const index = forumIndexSchema.parse(await (await page.request.get('/api/forums')).json());
  expect(index.categories.map((category) => category.id)).toEqual([
    ...tracks.filter((track) => track.status === 'available').map((track) => track.id), 'site', 'announcements',
  ]);
  expect(index.canAnnounce).toBe(false);
  await categories.getByRole('link', { name: 'Microsoft Defender Threat Intelligence', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Resource kit navigation' }).getByRole('link', { name: 'Discussion forums', exact: true })).toHaveAttribute('aria-current', 'location');
  const attached = page.getByRole('table', { name: 'Attached page discussions', exact: true });
  await expect(attached.locator('tbody tr')).toHaveCount(9);
  const hunting = defenderLessons.find((lesson) => lesson.id === 'mdti-hunting');
  if (!hunting) throw new Error('Missing hunting lesson.');
  await attached.getByRole('link', { name: hunting.title, exact: true }).click();
  await expect(page).toHaveURL(/\/discussions\/defender-threat-intelligence\/page-mdti-hunting$/u);
  await page.locator('.discussion').getByRole('link', { name: 'Attached page', exact: true }).click();
  await expect(page).toHaveURL(/\/learn\/mdti-hunting$/u);
  await expect(page.locator('.discussion')).toHaveCount(0);
  await page.goto('/discussions/defender-threat-intelligence/page-mdti-hunting');
  const inert = '<img src=x onerror=window.__srk_forum_xss=true> is an inert synthetic page question.';
  await page.getByLabel(`Contribute as ${handle}`, { exact: true }).fill(inert);
  await expect(page.locator('.discussion .anti-abuse, .discussion iframe')).toHaveCount(0);
  const submitted = page.waitForRequest((request) => request.url().endsWith('/api/discussions/mdti-hunting') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Submit for moderation', exact: true }).click();
  expect((await submitted).postDataJSON()).toEqual({ body: inert });
  await expect(page.locator('.discussion .status-tag')).toContainText('awaiting moderation');
  const direct = discussionSchema.parse(await (await page.request.get('/api/discussions/mdti-hunting')).json());
  expect(direct.comments).toHaveLength(1);
  const firstId = direct.comments[0]?.id;
  expect(direct.comments[0]).toMatchObject({ pageId: 'mdti-hunting', threadId: 'page-mdti-hunting', forumId: 'defender-threat-intelligence', parentId: null, depth: 0, status: 'pending', body: inert });
  await page.locator('.discussion').getByRole('link', { name: 'Attached page', exact: true }).click();
  await expect(page.locator('.discussion')).toHaveCount(0);
  await page.goto('/discussions/defender-threat-intelligence/page-mdti-hunting');
  await expect(page.locator('.threaded-comment .comment-body')).toHaveText(inert);
  await expect(page.locator('.threaded-comment img, .threaded-comment script')).toHaveCount(0);
  expect(discussionSchema.parse(await (await page.request.get('/api/threads/page-mdti-hunting')).json())).toEqual(direct);
  await page.getByLabel(`Contribute as ${handle}`, { exact: true }).fill('A second root contributed from the same forum conversation.');
  await page.getByRole('button', { name: 'Submit for moderation', exact: true }).click();
  await expect(page.locator('.threaded-comment')).toHaveCount(2);
  const combined = discussionSchema.parse(await (await page.request.get('/api/discussions/mdti-hunting')).json());
  expect(new Set(combined.comments.map((comment) => comment.id)).size).toBe(2);
  expect(combined.comments.some((comment) => comment.id === firstId)).toBe(true);
  const course = forumPageSchema.parse(await (await page.request.get('/api/forums/defender-threat-intelligence')).json());
  expect(course.pageDiscussions.find((thread) => thread.id === 'page-mdti-hunting')?.rootPosts).toBe(2);
  expect(course.pageDiscussions.some((thread) => thread.pageId === 'identity-model')).toBe(false);
  const site = forumPageSchema.parse(await (await page.request.get('/api/forums/site')).json());
  expect(site.pageDiscussions.map((thread) => thread.pageId)).toEqual(['home', 'about', 'terms', 'privacy', 'sources', 'roadmap', 'account']);
  expect(robotRequests).toEqual([]);
  await page.unroute('**/api/config');
  await removeTestAccount(page, handle);
  await expect(page.locator('.discussion, .forums-page')).toHaveCount(0);
  await passkey.cdp.detach();
});

test('independent questions and nested replies persist, remain plain text, and never bypass hidden parents', async ({ page, browser }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const otherHandle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  const author = await register(page, handle);
  if (!author.user) throw new Error('Missing question author.');
  await page.getByRole('button', { name: 'Discussions', exact: true }).click();
  await page.getByRole('table', { name: 'Discussion categories', exact: true }).getByRole('link', { name: 'Site discussions', exact: true }).click();
  const title = '<script>Inert independent question title</script>';
  const initialBody = '<script>window.__srk_thread_xss=true</script> is a synthetic question about a boundary.';
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Initial post', { exact: true }).fill(initialBody);
  await expect(page.locator('.thread-form .anti-abuse, .thread-form iframe')).toHaveCount(0);
  const createdResponse = page.waitForResponse((response) => response.url().endsWith('/api/forums/site/threads') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit question for moderation', exact: true }).click();
  const createdHttp = await createdResponse;
  expect(createdHttp.status()).toBe(201);
  expect(createdHttp.request().postDataJSON()).toEqual({ title, body: initialBody });
  const created = discussionSchema.parse(await createdHttp.json());
  const root = created.comments[0];
  if (!root) throw new Error('The initial question post is missing.');
  await expect(page).toHaveURL(new RegExp(`/discussions/site/${created.thread.id}$`, 'u'));
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  expect(root).toMatchObject({ pageId: null, threadId: created.thread.id, parentId: null, depth: 0, status: 'pending', body: initialBody });
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  const otherPasskey = await virtualPasskey(otherPage);
  const other = await register(otherPage, otherHandle);
  expect((await otherPage.request.get(`/api/threads/${created.thread.id}`)).status()).toBe(404);
  const privateForum = forumPageSchema.parse(await (await otherPage.request.get('/api/forums/site')).json());
  expect(privateForum.threads.some((thread) => thread.id === created.thread.id)).toBe(false);
  localSql(`UPDATE users SET role='moderator' WHERE id='${z.uuid().parse(author.user.id)}';`);
  await page.goto('/account');
  await page.getByRole('button', { name: 'Load pending and reported contributions', exact: true }).click();
  let queued = page.locator(`.moderation [data-comment-id="${root.id}"]`);
  await expect(queued.getByRole('link', { name: title, exact: true })).toHaveAttribute('href', `/discussions/site/${created.thread.id}`);
  await queued.getByRole('button', { name: 'Publish', exact: true }).click();
  await otherPage.goto(`/discussions/site/${created.thread.id}`);
  let rootArticle = otherPage.locator(`.threaded-comment[data-comment-id="${root.id}"]`);
  await expect(rootArticle.locator('.comment-body')).toHaveText(initialBody);
  await rootArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const replyBody = '<img src=x onerror=window.__srk_thread_xss=true> is an inert synthetic first reply.';
  await otherPage.getByLabel(`Reply as ${otherHandle}`, { exact: true }).fill(replyBody);
  const replyResponse = otherPage.waitForResponse((response) => response.url().endsWith(`/api/comments/${root.id}/replies`) && response.request().method() === 'POST');
  await otherPage.getByRole('button', { name: 'Submit reply for moderation', exact: true }).click();
  const replyHttp = await replyResponse;
  expect(replyHttp.request().postDataJSON()).toEqual({ body: replyBody });
  const reply = commentResponseSchema.parse(await replyHttp.json());
  expect(reply).toMatchObject({ threadId: root.threadId, parentId: root.id, depth: 1, status: 'pending' });
  await expect(otherPage.locator(`.threaded-comment[data-comment-id="${reply.id}"]`)).toBeVisible();
  expect(discussionSchema.parse(await (await page.request.get(`/api/comments/${root.id}/replies`)).json()).comments).toEqual([]);
  await page.getByRole('button', { name: 'Load pending and reported contributions', exact: true }).click();
  queued = page.locator(`.moderation [data-comment-id="${reply.id}"]`);
  await queued.getByText('Parent context (1)', { exact: true }).click();
  await expect(queued.locator('.contribution-context')).toContainText(initialBody);
  await queued.getByRole('button', { name: 'Publish', exact: true }).click();
  await otherPage.getByRole('button', { name: 'Refresh discussion', exact: true }).click();
  rootArticle = otherPage.locator(`.threaded-comment[data-comment-id="${root.id}"]`);
  await rootArticle.getByRole('button', { name: 'View replies (1)', exact: true }).click();
  const replyArticle = otherPage.locator(`.threaded-comment[data-comment-id="${reply.id}"]`);
  await expect(replyArticle).toHaveAttribute('data-depth', '1');
  await replyArticle.getByRole('button', { name: 'Reply', exact: true }).click();
  const nestedBody = 'A synthetic second-level reply retains the first reply as its parent.';
  await otherPage.getByLabel(`Reply as ${otherHandle}`, { exact: true }).fill(nestedBody);
  const nestedResponse = otherPage.waitForResponse((response) => response.url().endsWith(`/api/comments/${reply.id}/replies`) && response.request().method() === 'POST');
  await otherPage.getByRole('button', { name: 'Submit reply for moderation', exact: true }).click();
  const nested = commentResponseSchema.parse(await (await nestedResponse).json());
  expect(nested).toMatchObject({ parentId: reply.id, depth: 2, threadId: root.threadId, status: 'pending' });
  expect(discussionSchema.parse(await (await page.request.get(`/api/comments/${reply.id}/replies`)).json()).comments).toEqual([]);
  await page.getByRole('button', { name: 'Load pending and reported contributions', exact: true }).click();
  queued = page.locator(`.moderation [data-comment-id="${nested.id}"]`);
  await queued.getByText('Parent context (2)', { exact: true }).click();
  await expect(queued.locator('.contribution-context')).toContainText(replyBody);
  await expect(queued.locator('.contribution-context')).toContainText(initialBody);
  await queued.getByRole('button', { name: 'Publish', exact: true }).click();
  await otherPage.getByRole('button', { name: 'Refresh discussion', exact: true }).click();
  await otherPage.locator(`.threaded-comment[data-comment-id="${root.id}"]`).getByRole('button', { name: 'View replies (1)', exact: true }).click();
  await otherPage.locator(`.threaded-comment[data-comment-id="${reply.id}"]`).getByRole('button', { name: 'View replies (1)', exact: true }).click();
  const nestedArticle = otherPage.locator(`.threaded-comment[data-comment-id="${nested.id}"]`);
  await expect(nestedArticle.locator('.comment-body')).toHaveText(nestedBody);
  await expect(nestedArticle.getByRole('link', { name: 'parent post', exact: true })).toHaveAttribute('href', `#comment-${reply.id}`);
  await expect(otherPage.locator('.forums-page script, .threaded-comment img, .discussion .anti-abuse, .discussion iframe')).toHaveCount(0);
  expect(await otherPage.evaluate(() => Reflect.has(window, '__srk_thread_xss'))).toBe(false);
  expect((await page.request.post(`/api/moderation/${root.id}`, { headers: headers(author.csrfToken), data: { action: 'hide' } })).status()).toBe(200);
  await otherPage.reload();
  await expect(otherPage.locator('.threaded-comment')).toHaveCount(0);
  await expect(otherPage.locator('body')).not.toContainText(title);
  await expect(otherPage.locator('body')).not.toContainText(replyBody);
  expect((await otherPage.request.get(`/api/comments/${nested.id}/replies`)).status()).toBe(404);
  expect((await otherPage.request.post(`/api/comments/${reply.id}/report`, { headers: headers(other.csrfToken), data: { reason: 'A hidden branch report must not be accepted.' } })).status()).toBe(404);
  await removeTestAccount(page, handle);
  expect((await otherPage.request.get(`/api/threads/${created.thread.id}`)).status()).toBe(404);
  const exported = await (await otherPage.request.get('/api/account/export')).json();
  expect(exported.contributions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: reply.id, thread_id: created.thread.id, parent_id: root.id, depth: 1 }),
    expect.objectContaining({ id: nested.id, thread_id: created.thread.id, parent_id: reply.id, depth: 2 }),
  ]));
  expect(JSON.stringify(exported)).not.toContain(title);
  expect(JSON.stringify(exported)).not.toContain(initialBody);
  await removeTestAccount(otherPage, otherHandle);
  await otherPasskey.cdp.detach();
  await otherContext.close();
  await passkey.cdp.detach();
});

test('only the pinned personal owner creates announcements and ordinary member replies remain pending', async ({ page, browser }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const ownerHandle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  const ordinary = await register(page, handle);
  if (!ordinary.user) throw new Error('Missing ordinary member.');
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const ownerPasskey = await virtualPasskey(ownerPage);
  const owner = await register(ownerPage, ownerHandle);
  if (!owner.user) throw new Error('Missing owner test member.');
  const wrongHash = await sha256(JSON.stringify(['github', 'https://github.com', '123456789']));
  const ownerHash = await sha256(JSON.stringify(['github', 'https://github.com', MANAGEMENT_GITHUB_USER_ID]));
  const time = Math.floor(Date.now() / 1000);
  localSql(`UPDATE users SET role='moderator' WHERE id='${z.uuid().parse(ordinary.user.id)}';
    INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github','${wrongHash}','${ordinary.user.id}',${time});
    INSERT INTO social_identities (provider,identity_hash,user_id,created_at) VALUES ('github','${ownerHash}','${z.uuid().parse(owner.user.id)}',${time});`);
  await page.goto('/discussions/announcements');
  await expect(page.locator('.forums-page')).toContainText('Only the personal site owner can create announcements.');
  await expect(page.locator('.thread-form')).toHaveCount(0);
  expect((await page.request.post('/api/forums/announcements/threads', {
    headers: headers(ordinary.csrfToken), data: { title: 'A forbidden moderator announcement', body: 'Moderator role alone must not create an announcement.' },
  })).status()).toBe(403);
  expect((await page.request.get('/api/management/overview')).status()).toBe(403);
  await ownerPage.goto('/discussions/announcements');
  await expect(ownerPage.getByRole('link', { name: 'Site management', exact: true })).toBeVisible();
  await expect(ownerPage.getByRole('heading', { name: 'Create an announcement', exact: true })).toBeVisible();
  const title = 'A synthetic personal-owner announcement';
  const body = 'This synthetic owner announcement publishes its initial post immediately.';
  await ownerPage.getByLabel('Title', { exact: true }).fill(title);
  await ownerPage.getByLabel('Initial post', { exact: true }).fill(body);
  const announcedResponse = ownerPage.waitForResponse((response) => response.url().endsWith('/api/forums/announcements/threads') && response.request().method() === 'POST');
  await ownerPage.getByRole('button', { name: 'Publish announcement', exact: true }).click();
  const announcement = discussionSchema.parse(await (await announcedResponse).json());
  const root = announcement.comments[0];
  if (!root) throw new Error('Missing initial announcement.');
  expect(root).toMatchObject({ status: 'published', threadKind: 'announcement', pageId: null, depth: 0, body });
  expect(sessionSchema.parse(await (await ownerPage.request.get('/api/auth/me')).json()).user?.role).toBe('learner');
  const audit = z.array(z.object({ action: z.string(), recordId: z.string() })).parse(await (await ownerPage.request.get('/api/management/audit')).json());
  expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'publish', recordId: root.id })]));
  await page.goto(`/discussions/announcements/${announcement.thread.id}`);
  await expect(page.locator('.threaded-comment .comment-body')).toHaveText(body);
  await page.locator('.threaded-comment').getByRole('button', { name: 'Reply', exact: true }).click();
  const replyBody = 'A normal member reply to an announcement remains pending.';
  await page.getByLabel(`Reply as ${handle}`, { exact: true }).fill(replyBody);
  const repliedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/comments/${root.id}/replies`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Submit reply for moderation', exact: true }).click();
  const reply = commentResponseSchema.parse(await (await repliedResponse).json());
  expect(reply).toMatchObject({ parentId: root.id, depth: 1, status: 'pending', threadId: root.threadId });
  expect(discussionSchema.parse(await (await ownerPage.request.get(`/api/comments/${root.id}/replies`)).json()).comments).toEqual([]);
  const queue = z.array(commentResponseSchema).parse(await (await ownerPage.request.get('/api/management/contributions')).json());
  expect(queue.find((comment) => comment.id === reply.id)?.ancestors).toEqual([{
    id: root.id, parentId: null, depth: 0, handle: ownerHandle, body, status: 'published',
  }]);
  await ownerPage.goto('/discussions/announcements');
  await ownerPage.getByLabel('Title', { exact: true }).fill('An announcement after revocation must fail');
  await ownerPage.getByLabel('Initial post', { exact: true }).fill('The immutable owner link is removed before this submission.');
  localSql(`DELETE FROM social_identities WHERE user_id='${z.uuid().parse(owner.user.id)}';`);
  await ownerPage.getByRole('button', { name: 'Publish announcement', exact: true }).click();
  await expect(ownerPage.getByRole('alert')).toContainText('Site management access is not available');
  expect(forumPageSchema.parse(await (await page.request.get('/api/forums/announcements')).json()).threads.filter((thread) => thread.id === announcement.thread.id)).toHaveLength(1);
  await ownerPage.reload();
  await expect(ownerPage.locator('.thread-form')).toHaveCount(0);
  await expect(ownerPage.getByRole('link', { name: 'Site management', exact: true })).toHaveCount(0);
  await removeTestAccount(ownerPage, ownerHandle);
  const remaining = discussionSchema.parse(await (await page.request.get(`/api/threads/${announcement.thread.id}`)).json());
  expect(remaining.thread.title).toBe('Removed announcement');
  expect(remaining.comments[0]).toMatchObject({ id: root.id, status: 'removed', body: '', own: false, handle: 'Removed contribution' });
  expect(discussionSchema.parse(await (await page.request.get(`/api/comments/${root.id}/replies`)).json()).comments[0]).toMatchObject({ id: reply.id, parentId: root.id, status: 'pending' });
  expect(JSON.stringify(remaining)).not.toContain(ownerHandle);
  expect(JSON.stringify(remaining)).not.toContain(body);
  await removeTestAccount(page, handle);
  await ownerPasskey.cdp.detach();
  await ownerContext.close();
  await passkey.cdp.detach();
});

test('depth-sixteen discussion branches and paginated siblings retain their parents without mobile overflow', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  const identity = await register(page, handle);
  if (!identity.user) throw new Error('Missing deep-thread member.');
  const userId = z.uuid().parse(identity.user.id);
  const ids = Array.from({ length: 17 }, () => crypto.randomUUID());
  const rootId = ids[0];
  if (!rootId) throw new Error('Missing deep-thread root.');
  const time = Math.floor(Date.now() / 1000) - 100;
  const deepestBody = `<script>window.__srk_deep_thread=true</script> ${'synthetic'.repeat(130)}`;
  const sql = [`INSERT INTO comments (id,page_id,author_id,body,status,created_at) VALUES ('${rootId}','home','${userId}','Synthetic deep-thread root.','published',${time});`];
  for (let depth = 1; depth <= 16; depth++) {
    const id = ids[depth];
    const parentId = ids[depth - 1];
    if (!id || !parentId) throw new Error('Missing deep-thread relationship.');
    const body = depth === 16 ? deepestBody : `Synthetic nested reply level ${depth}.`;
    sql.push(`INSERT INTO discussion_nodes (id,thread_id,parent_id,depth,created_at) VALUES ('${id}','page-home','${parentId}',${depth},${time + depth});
      INSERT INTO comments (id,page_id,author_id,body,status,created_at) VALUES ('${id}','home','${userId}','${body}','published',${time + depth});`);
  }
  localSql(sql.join('\n'));
  const siblingIds = Array.from({ length: 35 }, () => crypto.randomUUID());
  for (let start = 0; start < siblingIds.length; start += 15) {
    localSql(siblingIds.slice(start, start + 15).map((id, offset) => {
      const index = start + offset;
      return `INSERT INTO discussion_nodes (id,thread_id,parent_id,depth,created_at) VALUES ('${id}','page-home','${rootId}',1,${time + 20 + index});
        INSERT INTO comments (id,page_id,author_id,body,status,created_at) VALUES ('${id}','home','${userId}','Synthetic direct sibling ${index}.','published',${time + 20 + index});`;
    }).join('\n'));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/discussions/site/page-home');
  const rootArticle = page.locator(`.threaded-comment[data-comment-id="${rootId}"]`);
  await rootArticle.getByRole('button', { name: 'View replies (36)', exact: true }).click();
  await expect(page.locator('.threaded-comment[data-depth="1"]')).toHaveCount(30);
  for (let depth = 1; depth < 16; depth++) {
    const article = page.locator(`.threaded-comment[data-comment-id="${ids[depth]}"]`);
    await expect(article).toHaveAttribute('data-depth', String(depth));
    await article.getByRole('button', { name: 'View replies (1)', exact: true }).click();
  }
  const deepest = page.locator(`.threaded-comment[data-comment-id="${ids[16]}"]`);
  await expect(deepest).toHaveAttribute('data-depth', '16');
  await expect(deepest.locator('.comment-body')).toHaveText(deepestBody);
  await expect(deepest.getByRole('link', { name: 'parent post', exact: true })).toHaveAttribute('href', `#comment-${ids[15]}`);
  await expect(deepest.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
  await expect(deepest).toContainText('Maximum reply depth reached');
  expect(await deepest.evaluate((element) => getComputedStyle(element.parentElement || element).marginLeft)).toBe('20px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.locator('.threaded-comment script, .discussion iframe, .discussion .anti-abuse')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.has(window, '__srk_deep_thread'))).toBe(false);
  await page.getByRole('button', { name: 'Load more replies to this post', exact: true }).click();
  await expect(page.locator('.threaded-comment[data-depth="1"]')).toHaveCount(36);
  await expect(page.locator('.threaded-comment')).toHaveCount(52);
  const first = discussionSchema.parse(await (await page.request.get(`/api/comments/${rootId}/replies`)).json());
  const second = discussionSchema.parse(await (await page.request.get(`/api/comments/${rootId}/replies?cursor=${encodeURIComponent(first.nextCursor || '')}`)).json());
  expect(first.comments).toHaveLength(30);
  expect(second.comments).toHaveLength(6);
  expect(second.nextCursor).toBeNull();
  expect([...first.comments, ...second.comments].map((comment) => comment.id)).toEqual([ids[1], ...siblingIds]);
  expect([...first.comments, ...second.comments].every((comment) => comment.parentId === rootId && comment.depth === 1)).toBe(true);
  const tooDeep = await page.request.post(`/api/comments/${ids[16]}/replies`, { headers: headers(identity.csrfToken), data: { body: 'An over-depth reply must fail without reparenting.' } });
  expect(tooDeep.status()).toBe(400);
  expect(await tooDeep.json()).toMatchObject({ error: expect.stringContaining('depth 16') });
  const attached = discussionSchema.parse(await (await page.request.get('/api/discussions/home')).json());
  const central = discussionSchema.parse(await (await page.request.get('/api/threads/page-home')).json());
  expect(central).toEqual(attached);
  expect(attached.comments.find((comment) => comment.id === rootId)).toMatchObject({ depth: 0, parentId: null, replyCount: 36 });
  await removeTestAccount(page, handle);
  await passkey.cdp.detach();
});

test('daily source maintenance is visible only after sign-in', async ({ page }) => {
  const handle = `e2e_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const passkey = await virtualPasskey(page);
  await register(page, handle);
  const api = page.request;
  const triggered = await api.get('/cdn-cgi/local/scheduled?format=json&cron=17%206%20*%20*%20*', { timeout: 60000 });
  expect(triggered.ok()).toBe(true);
  expect(z.object({ outcome: z.literal('ok'), noRetry: z.boolean() }).safeParse(await triggered.json()).success).toBe(true);
  const statuses = z.array(sourceStatusSchema).parse(await (await api.get('/api/sources')).json());
  expect(statuses).toHaveLength(sources.length);
  expect(statuses.every((status) => status.checkedAt !== null && status.status !== 'not-checked')).toBe(true);
  expect(statuses.filter((status) => status.status === 'unchanged' || status.status === 'changed').length).toBeGreaterThan(0);
  const ids = statuses.map((status) => status.sourceId);
  expect(new Set(ids).size).toBe(sources.length);
  await removeTestAccount(page, handle);
  expect((await api.get('/api/sources')).status()).toBe(401);
  await passkey.cdp.detach();
});
