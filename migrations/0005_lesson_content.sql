CREATE TABLE lesson_content (
  lesson_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE lesson_content_history (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  reason TEXT NOT NULL,
  editor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (lesson_id, revision)
);
