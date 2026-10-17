import { describe, expect, it } from 'vitest';
import { PRIVACY_VERSION, TERMS_VERSION } from '../shared/contracts';
import { commentSchema, containsLikelySecret, handleSchema, hasDisallowedControl, questionThreadSchema, registrationStartSchema } from '../server/validation';

describe('registration and discussion input', () => {
  it('requires actual versioned policy acceptance and rejects role injection', () => {
    const input = { handle: 'Threat-Modeler', accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION };
    expect(registrationStartSchema.parse(input).handle).toBe('threat-modeler');
    expect(registrationStartSchema.safeParse({ ...input, accepted: false }).success).toBe(false);
    expect(registrationStartSchema.safeParse({ ...input, termsVersion: 'outdated' }).success).toBe(false);
    expect(registrationStartSchema.safeParse({ ...input, role: 'moderator' }).success).toBe(false);
  });

  it('reserves impersonation-prone handles and keeps identifiers bounded', () => {
    for (const handle of ['admin', 'MICROSOFT', 'support', 'a', 'a'.repeat(31), '<script>', 'two words', '_prefix']) {
      expect(handleSchema.safeParse(handle).success, handle).toBe(false);
    }
    expect(handleSchema.safeParse('blue-team_01').success).toBe(true);
  });

  it('rejects likely secrets before a contribution reaches moderation', () => {
    for (const text of [
      '-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----',
      `Bearer ${'a'.repeat(40)}`, `ghp_${'a'.repeat(30)}`, `github_pat_${'a'.repeat(30)}`,
      `AccountKey=${'a'.repeat(40)}`,
      `eyJ${'a'.repeat(30)}.${'b'.repeat(40)}.${'c'.repeat(40)}`,
    ]) {
      expect(containsLikelySecret(text)).toBe(true);
      expect(commentSchema.safeParse({ body: text }).success).toBe(false);
    }
    expect(containsLikelySecret('Use a synthetic token with <redacted> values.')).toBe(false);
  });

  it('accepts plain-text lab discussion, including markup that must remain inert', () => {
    expect(commentSchema.safeParse({ body: 'How does the blueprint boundary affect the resource audit trail?' }).success).toBe(true);
    expect(commentSchema.safeParse({ body: '<img src=x onerror=alert(1)> is an inert synthetic test string.' }).success).toBe(true);
    expect(commentSchema.safeParse({ body: 'short' }).success).toBe(false);
    expect(commentSchema.safeParse({ body: 'x'.repeat(2001) }).success).toBe(false);
  });

  it('permits line breaks and tabs but rejects hidden control characters', () => {
    expect(hasDisallowedControl('line one\nline two\tvalue\r\n')).toBe(false);
    expect(hasDisallowedControl(`hidden${String.fromCharCode(0)}control`)).toBe(true);
    expect(hasDisallowedControl(String.fromCharCode(127))).toBe(true);
    expect(commentSchema.safeParse({ body: `A synthetic${String.fromCharCode(0)}question.` }).success).toBe(false);
  });

  it('requires a bounded, single-line, secret-free question title and initial post', () => {
    const question = { title: 'A synthetic boundary question', body: 'Which boundary should this synthetic example use?' };
    expect(questionThreadSchema.parse(question)).toEqual(question);
    for (const title of ['', 'tiny', 'a'.repeat(161), 'A multiline\ntitle', 'A hidden\u0000title', `ghp_${'x'.repeat(30)}`]) {
      expect(questionThreadSchema.safeParse({ ...question, title }).success, title).toBe(false);
    }
    expect(questionThreadSchema.safeParse({ ...question, body: 'short' }).success).toBe(false);
    for (const field of ['parentId', 'forumId', 'status', 'role', 'depth', 'turnstileToken']) {
      expect(questionThreadSchema.safeParse({ ...question, [field]: 'injected' }).success, field).toBe(false);
    }
    expect(commentSchema.safeParse({ body: question.body, parentId: crypto.randomUUID() }).success).toBe(false);
  });
});
