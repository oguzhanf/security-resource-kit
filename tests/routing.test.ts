import { describe, expect, it } from 'vitest';
import { discussionRoute, forumPageId, pathFor, threadPageId } from '../src/routing';

describe('member discussion routes', () => {
  it('maps categories and stored page/question conversations without treating them as lessons', () => {
    const id = '71a5be34-05a8-4c8e-b69c-96a9fca9d6d3';
    expect(pathFor('discussions')).toBe('/discussions');
    expect(pathFor(forumPageId('agent-identity'))).toBe('/discussions/agent-identity');
    expect(pathFor(threadPageId('defender-threat-intelligence', 'page-mdti-hunting'))).toBe('/discussions/defender-threat-intelligence/page-mdti-hunting');
    expect(pathFor(threadPageId('site', id))).toBe(`/discussions/site/${id}`);
    expect(discussionRoute('discussions')).toEqual({ forumId: null, threadId: null });
    expect(discussionRoute(forumPageId('announcements'))).toEqual({ forumId: 'announcements', threadId: null });
    expect(discussionRoute(threadPageId('site', id))).toEqual({ forumId: 'site', threadId: id });
    expect(discussionRoute('identity-model')).toBeNull();
    expect(discussionRoute('forum:../management')).toBeNull();
    expect(pathFor('thread:site:<script>')).toBe('/');
    expect(pathFor('track-agent-identity')).toBe('/tracks/agent-identity');
    expect(pathFor('mdti-hunting')).toBe('/learn/mdti-hunting');
  });
});
