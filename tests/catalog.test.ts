import { describe, expect, it } from 'vitest';
import { grade, lessons, pageIds, sources, tracks, wordCount } from '../shared/catalog';
import baselines from '../shared/source-baselines.json' with { type: 'json' };
import allowedSources from '../shared/source-allowlist.json' with { type: 'json' };

describe('editorial and curriculum invariants', () => {
  it('starts with a complete advanced Agent Identity path, not an introductory placeholder', () => {
    const agentLessons = lessons.filter((lesson) => lesson.trackId === 'agent-identity');
    expect(agentLessons.length).toBeGreaterThanOrEqual(6);
    expect(agentLessons.some((lesson) => lesson.level === 400)).toBe(true);
    expect(agentLessons.filter((lesson) => lesson.level === 500).length).toBeGreaterThanOrEqual(4);
    expect(tracks.find((track) => track.id === 'agent-identity')?.lessonIds).toEqual(agentLessons.map((lesson) => lesson.id));
    expect(tracks.filter((track) => track.status === 'planned').every((track) => track.lessonIds.length === 0)).toBe(true);
  });

  it('publishes a separate ordered eight-topic Defender TI course without moving Agent Identity', () => {
    const defenderTrack = tracks.find((track) => track.id === 'defender-threat-intelligence');
    expect(defenderTrack?.status).toBe('available');
    expect(defenderTrack?.lessonIds).toEqual([
      'mdti-entitlement', 'mdti-graph-api', 'mdti-entity-investigation', 'mdti-infrastructure',
      'mdti-hunting', 'mdti-indicator-management', 'mdti-third-party-access', 'mdti-case-workflow',
    ]);
    const defenderLessons = lessons.filter((lesson) => lesson.trackId === defenderTrack?.id);
    expect(defenderLessons).toHaveLength(8);
    expect(defenderLessons.filter((lesson) => lesson.level === 500)).toHaveLength(6);
    expect(defenderLessons.flatMap((lesson) => lesson.preflight)).toHaveLength(16);
    expect(defenderLessons.flatMap((lesson) => lesson.application)).toHaveLength(8);
    for (const track of tracks.filter((entry) => entry.status === 'available')) {
      expect(track.lessonIds).toEqual(lessons.filter((lesson) => lesson.trackId === track.id).map((lesson) => lesson.id));
    }
  });

  it('has unique stable IDs and an attached discussion identity for every published page', () => {
    expect(new Set(lessons.map((lesson) => lesson.id)).size).toBe(lessons.length);
    expect(new Set(tracks.map((track) => track.id)).size).toBe(tracks.length);
    expect(lessons.every((lesson) => tracks.some((track) => track.id === lesson.trackId && track.status === 'available'))).toBe(true);
    for (const id of [
      'home', 'about', 'terms', 'privacy', 'roadmap', 'sources', 'account',
      ...tracks.filter((track) => track.status === 'available').map((track) => `track-${track.id}`),
      ...lessons.map((lesson) => lesson.id),
    ]) {
      expect(pageIds.has(id)).toBe(true);
    }
    expect(pageIds.has('made-up-page')).toBe(false);
  });

  it('flags the current documentation conflict instead of presenting false certainty', () => {
    const inheritance = lessons.find((lesson) => lesson.id === 'permission-inheritance');
    expect(inheritance?.evidence.some((entry) => entry.title === 'Documentation mismatch to verify' && entry.documentationConflict)).toBe(true);
    const entitlement = lessons.find((lesson) => lesson.id === 'mdti-entitlement');
    expect(entitlement?.gist).toContain('retired on August 1, 2026');
    expect(entitlement?.gist).toContain('without a separate TI API license');
    expect(entitlement?.gist).toContain('ISOC remains a separate preview');
    const entitlementEvidence = entitlement?.evidence.find((entry) => entry.sourceId === 'ti-graph-beta');
    expect(entitlementEvidence?.documentationConflict).not.toBe(true);
    expect(entitlementEvidence?.text).toContain('Both current v1.0 and beta overviews');
    expect(entitlementEvidence?.text).toContain('without a separate API license');
    const api = lessons.find((lesson) => lesson.id === 'mdti-graph-api');
    expect(api?.evidence.some((entry) => entry.documentationConflict &&
      entry.text.includes('delegated ThreatIntelligence.Read') && entry.text.includes('Read.All for both'))).toBe(true);
    expect(api?.evidence.some((entry) => entry.text.includes('Security Reader'))).toBe(true);
  });

  it('uses canonical HTTPS public Microsoft source URLs without credentials or alternate ports', () => {
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
    for (const source of sources) {
      const upstream = new URL(source.upstream);
      expect(upstream.protocol).toBe('https:');
      expect(allowedSources.some((rule) => upstream.hostname === rule.host && upstream.pathname.startsWith(rule.pathPrefix))).toBe(true);
      expect(upstream.username || upstream.password || upstream.port).toBe('');
      expect(upstream.hash).toBe('');
      const reference = new URL(source.url);
      expect(reference.protocol).toBe('https:');
      expect(reference.hostname).toBe('learn.microsoft.com');
      expect(reference.username || reference.password || reference.port).toBe('');
      if (upstream.hostname === 'learn.microsoft.com') {
        expect(upstream.searchParams.get('accept')).toBe('text/markdown');
        if (upstream.pathname.startsWith('/en-us/graph/api/')) {
          expect(upstream.searchParams.get('view')).toBe(reference.searchParams.get('view'));
          expect(['graph-rest-1.0', 'graph-rest-beta']).toContain(upstream.searchParams.get('view'));
        }
      }
      expect(Object.hasOwn(baselines, source.id)).toBe(true);
    }
  });

  it('separates TI reads, hunting, ingestion, and third-party distribution with documented examples', () => {
    const api = lessons.find((lesson) => lesson.id === 'mdti-graph-api');
    expect(api?.gist).toContain('ThreatIntelligence.Read.All application permission');
    expect(api?.codeExamples?.some((example) => example.code.includes('/hosts/ioc-lab.example/reputation'))).toBe(true);
    const passiveDns = lessons.find((lesson) => lesson.id === 'mdti-infrastructure')?.codeExamples?.[0];
    expect(passiveDns).toBeDefined();
    const passiveDnsUrl = new URL(passiveDns?.code.slice(4) || 'https://invalid.example');
    expect(passiveDnsUrl.searchParams.get('$filter')).toBe("recordType eq 'A'");
    const hunting = lessons.find((lesson) => lesson.id === 'mdti-hunting');
    expect(hunting?.gist).toContain('ThreatHunting.Read.All');
    expect(hunting?.gist).toContain('fall back to the primary workspace');
    const request = hunting?.codeExamples?.find((example) => example.language === 'http');
    expect(request?.code.split('\n')[0]).toBe('POST https://graph.microsoft.com/v1.0/security/runHuntingQuery');
    const body = JSON.parse(request?.code.split('\n\n')[1] || '{}');
    expect(Object.keys(body).sort()).toEqual(['Query', 'Timespan']);
    expect(body.Timespan).toBe('P7D');
    expect(body.Query).toContain('192.0.2.10');
    expect(body.Query).toContain('ReportId');
    const query = hunting?.codeExamples?.find((example) => example.language === 'kql');
    expect(query?.code).toContain('parse_url(RemoteUrl).Host');
    expect(query?.code).toContain('Timestamp >= ValidFrom and Timestamp < ValidUntil');
    expect(lessons.find((lesson) => lesson.id === 'mdti-indicator-management')?.gist).toContain('Microsoft Sentinel Contributor at the workspace');
    const thirdParty = lessons.find((lesson) => lesson.id === 'mdti-third-party-access');
    expect(thirdParty?.codeExamples?.[0]?.code).toContain('/intelProfiles/{intelligenceProfileId}/indicators');
    expect(thirdParty?.gist).toContain('not hunting, workspace-write, or unrestricted redistribution permission');
    expect(thirdParty?.evidence.some((entry) => entry.text.includes('TAXII 2.1'))).toBe(true);
  });

  for (const lesson of lessons) {
    describe(lesson.id, () => {
      it('keeps the actual gist within the 100-word ceiling', () => {
        expect(wordCount(lesson.gist)).toBeLessThanOrEqual(100);
        expect(wordCount(lesson.gist)).toBeGreaterThan(40);
        expect(Number.isInteger(lesson.revision) && lesson.revision > 0).toBe(true);
        expect(lesson.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(lesson.reviewedAt <= new Date().toISOString().slice(0, 10)).toBe(true);
      });

      it('has scenario-first preparation, transfer, and nontrivial feedback on every option', () => {
        expect(lesson.preflight.length).toBeGreaterThanOrEqual(2);
        expect(lesson.application.length).toBeGreaterThanOrEqual(1);
        for (const question of [...lesson.preflight, ...lesson.application]) {
          expect(question.scenario.length).toBeGreaterThan(30);
          expect(question.choices.length).toBeGreaterThanOrEqual(3);
          expect(question.correct).toBeGreaterThanOrEqual(0);
          expect(question.correct).toBeLessThan(question.choices.length);
          expect(question.choices.every((choice) => choice.feedback.length > 30)).toBe(true);
          expect(lesson.sourceIds).toContain(question.sourceId);
        }
        expect(grade(lesson.preflight, lesson.preflight.map((question) => question.correct))).toBe(lesson.preflight.length);
        expect(grade(lesson.preflight, lesson.preflight.map((question) => (question.correct + 1) % question.choices.length))).toBe(0);
      });

      it('links evidence and prerequisites to real, reviewed catalog objects', () => {
        for (const id of lesson.sourceIds) {
          expect(sources.some((source) => source.id === id)).toBe(true);
          expect(Object.hasOwn(baselines, id)).toBe(true);
        }
        for (const id of lesson.prerequisites) {
          const prerequisite = lessons.findIndex((entry) => entry.id === id);
          expect(prerequisite).toBeGreaterThanOrEqual(0);
          expect(prerequisite).toBeLessThan(lessons.findIndex((entry) => entry.id === lesson.id));
        }
        for (const evidence of lesson.evidence) expect(lesson.sourceIds).toContain(evidence.sourceId);
        for (const example of lesson.codeExamples || []) {
          expect(lesson.sourceIds).toContain(example.sourceId);
          expect(['http', 'kql', 'json']).toContain(example.language);
          expect(example.code.length).toBeGreaterThan(20);
          expect(example.note.length).toBeGreaterThan(30);
          expect(example.code).not.toMatch(/Authorization:\s*Bearer|client_secret|access_token|refresh_token/iu);
          if (example.language === 'http') {
            const [method, target] = (example.code.split('\n')[0] || '').split(' ');
            expect(['GET', 'POST']).toContain(method);
            const url = new URL(target || 'https://invalid.example');
            expect(url.origin).toBe('https://graph.microsoft.com');
            expect(url.pathname.startsWith('/v1.0/security/')).toBe(true);
            expect(url.username || url.password || url.port).toBe('');
          }
        }
      });
    });
  }
});
