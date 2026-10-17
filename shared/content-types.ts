export interface Choice {
  text: string;
  feedback: string;
}

export interface Question {
  id: string;
  scenario: string;
  prompt: string;
  choices: readonly Choice[];
  correct: number;
  sourceId: string;
}

export type LessonVisual = {
  id: string;
  stepId: string;
  title: string;
  caption: string;
  sourceId: string;
} & ({
  kind: 'diagram';
  nodes: readonly { id: string; label: string; detail: string; column: number; row: number }[];
  edges: readonly { from: string; to: string; label: string }[];
} | {
  kind: 'screenshot';
  src: string;
  alt: string;
  capturedAt: string;
  provenance: 'public-documentation-redacted' | 'tenant-redacted';
});

export interface Lesson {
  id: string;
  trackId: string;
  title: string;
  shortTitle: string;
  level: 400 | 500;
  minutes: number;
  revision: number;
  reviewedAt: string;
  objective: string;
  gist: string;
  prerequisites: readonly string[];
  tags: readonly string[];
  sourceIds: readonly string[];
  preflight: readonly Question[];
  application: readonly Question[];
  checkpoints: readonly string[];
  evidence: readonly { title: string; text: string; sourceId: string; documentationConflict?: boolean }[];
  exercise: { title: string; prompt: string; expected: string };
  codeExamples?: readonly { title: string; language: 'http' | 'kql' | 'json'; code: string; note: string; sourceId: string }[];
  visuals?: readonly LessonVisual[];
}

export interface Track {
  id: string;
  title: string;
  description: string;
  status: 'available' | 'planned';
  lessonIds: readonly string[];
}

export interface Source {
  id: string;
  title: string;
  url: string;
  upstream: string;
}

export interface MemberCatalog {
  lessons: Lesson[];
  tracks: Track[];
  sources: Source[];
  pageIds: string[];
}

export interface PublicTrack {
  id: string;
  title: string;
  status: 'available' | 'planned';
}
