import { describe, expect, it } from 'vitest';
import { acknowledgement, commentResponseSchema, discussionSchema, memberCatalogSchema } from '../shared/api-schemas';
import { lessons, pageIds, sources, tracks } from '../shared/catalog';

describe('mutation acknowledgements', () => {
  it('requires the exact true flag for the requested operation', () => {
    const schema = acknowledgement('deleted');
    expect(schema.safeParse({ deleted: true }).success).toBe(true);
    expect(schema.safeParse({ deleted: false }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ error: 'not deleted' }).success).toBe(false);
    expect(schema.safeParse({ registered: true }).success).toBe(false);
  });

  describe('thread relationship contracts', () => {
    const id = '71a5be34-05a8-4c8e-b69c-96a9fca9d6d3';
    const replyId = '49c2b44a-9b1d-40a1-b529-b25ef3d36b71';
    const comment = {
      id, pageId: 'home', threadId: 'page-home', forumId: 'site', threadTitle: 'Overview', threadKind: 'page',
      parentId: null, depth: 0, replyCount: 0, handle: 'member', body: 'A synthetic discussion root.',
      status: 'published', createdAt: 100, own: false,
    };
    const thread = { id: 'page-home', forumId: 'site', pageId: 'home', kind: 'page', title: 'Overview', rootCommentId: null };

    it('rejects wrong depths, incomplete ancestor context and personal removed content', () => {
      expect(commentResponseSchema.safeParse(comment).success).toBe(true);
      expect(commentResponseSchema.safeParse({ ...comment, depth: 1 }).success).toBe(false);
      expect(commentResponseSchema.safeParse({ ...comment, parentId: replyId }).success).toBe(false);
      expect(commentResponseSchema.safeParse({ ...comment, parentId: replyId, depth: 17 }).success).toBe(false);
      expect(commentResponseSchema.safeParse({ ...comment, status: 'removed' }).success).toBe(false);
      expect(commentResponseSchema.safeParse({ ...comment, status: 'removed', body: '', own: true }).success).toBe(false);
      expect(commentResponseSchema.safeParse({ ...comment, status: 'removed', body: '', handle: 'Removed contribution' }).success).toBe(true);
      const reply = { ...comment, id: replyId, parentId: id, depth: 1 };
      expect(commentResponseSchema.safeParse({ ...reply, ancestors: [] }).success).toBe(false);
      expect(commentResponseSchema.safeParse({ ...reply, ancestors: [{ id, parentId: null, depth: 0, handle: 'member', body: comment.body, status: 'published' }] }).success).toBe(true);
    });

    it('rejects a mismatched thread, duplicate posts, and invalid page/question identities', () => {
      const page = { thread, comments: [comment], nextCursor: null };
      expect(discussionSchema.safeParse(page).success).toBe(true);
      expect(discussionSchema.safeParse({ ...page, comments: [comment, comment] }).success).toBe(false);
      expect(discussionSchema.safeParse({ ...page, comments: [{ ...comment, forumId: 'announcements' }] }).success).toBe(false);
      expect(discussionSchema.safeParse({ ...page, thread: { ...thread, id: 'duplicate-page' } }).success).toBe(false);
      expect(discussionSchema.safeParse({ ...page, thread: { ...thread, kind: 'question', rootCommentId: id } }).success).toBe(false);
    });
  });

  describe('member curriculum contract', () => {
    it('preserves optional examples and catalog-driven documentation conflicts', () => {
      const parsed = memberCatalogSchema.parse({ lessons, tracks, sources, pageIds: [...pageIds] });
      expect(parsed.lessons).toEqual(lessons);
      expect(parsed.tracks).toEqual(tracks);
      const api = parsed.lessons.find((lesson) => lesson.id === 'mdti-graph-api');
      expect(api?.codeExamples).toHaveLength(2);
      expect(api?.evidence.some((entry) => entry.documentationConflict)).toBe(true);
      expect(parsed.lessons.find((lesson) => lesson.id === 'identity-model')?.codeExamples).toBeUndefined();
    });

    it('rejects executable example languages rather than treating them as supported content', () => {
      expect(memberCatalogSchema.safeParse({
        lessons: [{
          ...lessons[0],
          codeExamples: [{ title: 'Invalid example', language: 'html', code: '<script>notSupported()</script>', note: 'Not a supported example language.', sourceId: 'ti-host' }],
        }],
        tracks, sources, pageIds: [...pageIds],
      }).success).toBe(false);
    });
  });
});
