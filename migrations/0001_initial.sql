PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
  role TEXT NOT NULL DEFAULT 'learner' CHECK (role IN ('learner', 'moderator')),
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

CREATE TABLE consents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, terms_version, privacy_version)
);

CREATE TABLE auth_challenges (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login', 'add-passkey')),
  challenge TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expiry_idx ON auth_challenges(expires_at);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  pre_answers TEXT NOT NULL,
  pre_score INTEGER NOT NULL,
  post_answers TEXT,
  post_score INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, lesson_id, revision)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'hidden', 'removed')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX comments_page_idx ON comments(page_id, status, created_at, id);
CREATE INDEX comments_author_idx ON comments(author_id, created_at);
CREATE INDEX comments_moderation_idx ON comments(status, created_at);

CREATE TABLE reports (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, reporter_id)
);
CREATE INDEX reports_comment_idx ON reports(comment_id);

CREATE TABLE moderation_audit (
  id TEXT PRIMARY KEY,
  moderator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  comment_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('publish', 'hide')),
  created_at INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  bucket_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_expiry_idx ON rate_limits(expires_at);

CREATE TABLE source_checks (
  source_id TEXT PRIMARY KEY,
  observed_hash TEXT,
  baseline_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unchanged', 'changed', 'unavailable')),
  checked_at INTEGER NOT NULL
);
