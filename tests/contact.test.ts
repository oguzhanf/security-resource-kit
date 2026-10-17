import { describe, expect, it } from 'vitest';
import { contactRequestSchema } from '../server/contact';

describe('private contact input boundaries', () => {
  it('accepts a private request without requiring an account or email', () => {
    expect(contactRequestSchema.parse({ message: 'Please review the account data deletion process.' }).replyEmail).toBeUndefined();
    expect(contactRequestSchema.safeParse({ message: 'A private account request.', replyEmail: 'reply@example.test' }).success).toBe(true);
  });

  it('rejects invalid addresses, unbounded content, secret material, and identity injection', () => {
    const message = 'Please review this private request.';
    expect(contactRequestSchema.safeParse({ message, replyEmail: 'invalid' }).success).toBe(false);
    expect(contactRequestSchema.safeParse({ message: 'x'.repeat(2001) }).success).toBe(false);
    expect(contactRequestSchema.safeParse({ message: 'short' }).success).toBe(false);
    expect(contactRequestSchema.safeParse({ message, userId: 'another-user' }).success).toBe(false);
    expect(contactRequestSchema.safeParse({ message: `Bearer ${'a'.repeat(40)}` }).success).toBe(false);
    expect(contactRequestSchema.safeParse({ message: `private${String.fromCharCode(0)}message` }).success).toBe(false);
  });
});
