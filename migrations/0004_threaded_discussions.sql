CREATE TABLE discussion_threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'question', 'announcement')),
  page_id TEXT UNIQUE,
  forum_id TEXT,
  root_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  CHECK (
    (kind = 'page' AND page_id IS NOT NULL AND forum_id IS NULL AND root_id IS NULL) OR
    (kind IN ('question', 'announcement') AND page_id IS NULL AND forum_id IS NOT NULL AND root_id IS NOT NULL)
  )
);
CREATE INDEX discussion_threads_forum_idx ON discussion_threads(forum_id, created_at, id);

-- Relationships contain no author or contribution text and survive account/content deletion.
CREATE TABLE discussion_nodes (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES discussion_threads(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES discussion_nodes(id),
  depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 16),
  created_at INTEGER NOT NULL,
  removed_visible INTEGER NOT NULL DEFAULT 0 CHECK (removed_visible IN (0, 1)),
  CHECK ((parent_id IS NULL AND depth = 0) OR (parent_id IS NOT NULL AND depth > 0))
);
CREATE INDEX discussion_nodes_children_idx ON discussion_nodes(thread_id, parent_id, created_at, id);
CREATE INDEX discussion_nodes_parent_idx ON discussion_nodes(parent_id, created_at, id);

ALTER TABLE comments ADD COLUMN title TEXT CHECK (title IS NULL OR length(title) BETWEEN 5 AND 160);

-- Add metadata without rebuilding comments or touching report FKs and review history.
INSERT INTO discussion_threads (id, kind, page_id, created_at)
  SELECT 'page-' || page_id, 'page', page_id, MIN(created_at) FROM comments GROUP BY page_id;
INSERT INTO discussion_nodes (id, thread_id, parent_id, depth, created_at)
  SELECT id, 'page-' || page_id, NULL, 0, created_at FROM comments;

CREATE TRIGGER discussion_nodes_validate
BEFORE INSERT ON discussion_nodes
WHEN NOT EXISTS (
  SELECT 1 FROM discussion_threads t WHERE t.id = NEW.thread_id AND (
    (NEW.parent_id IS NULL AND NEW.depth = 0 AND (t.kind = 'page' OR t.root_id = NEW.id)) OR
    (NEW.parent_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM discussion_nodes p
      WHERE p.id = NEW.parent_id AND p.thread_id = NEW.thread_id AND p.depth + 1 = NEW.depth
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Invalid discussion ancestry');
END;

CREATE TRIGGER discussion_nodes_immutable
BEFORE UPDATE OF id, thread_id, parent_id, depth, created_at ON discussion_nodes
BEGIN
  SELECT RAISE(ABORT, 'Discussion ancestry is immutable');
END;

CREATE TRIGGER comments_validate_discussion
BEFORE INSERT ON comments
WHEN EXISTS (
  SELECT 1 FROM discussion_nodes n JOIN discussion_threads t ON t.id = n.thread_id
  WHERE n.id = NEW.id AND (
    NEW.page_id != COALESCE(t.page_id, '') OR
    (NEW.title IS NOT NULL AND (t.kind = 'page' OR t.root_id != NEW.id))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Contribution does not match its discussion');
END;

-- Direct legacy inserts remain coherent page roots when optional metadata is omitted.
CREATE TRIGGER comments_attach_legacy_discussion
AFTER INSERT ON comments
WHEN NOT EXISTS (SELECT 1 FROM discussion_nodes WHERE id = NEW.id)
BEGIN
  INSERT OR IGNORE INTO discussion_threads (id, kind, page_id, created_at)
    VALUES ('page-' || NEW.page_id, 'page', NEW.page_id, NEW.created_at);
  INSERT INTO discussion_nodes (id, thread_id, parent_id, depth, created_at)
    VALUES (NEW.id, 'page-' || NEW.page_id, NULL, 0, NEW.created_at);
END;

CREATE TRIGGER comments_removal_visibility
AFTER UPDATE OF status ON comments
WHEN NEW.status = 'removed' AND OLD.status != 'removed'
BEGIN
  UPDATE discussion_nodes SET removed_visible = (OLD.status = 'published') WHERE id = OLD.id;
END;

CREATE TRIGGER comments_deletion_visibility
BEFORE DELETE ON comments
WHEN OLD.status != 'removed'
BEGIN
  UPDATE discussion_nodes SET removed_visible = (OLD.status = 'published') WHERE id = OLD.id;
END;
