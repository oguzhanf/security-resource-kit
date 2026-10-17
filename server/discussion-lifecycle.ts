export function pruneEmptyDiscussionBranches(
  db: D1Database,
  affectedThreadsSql: string,
  bindings: (string | number)[],
  excludedAuthor?: string,
): D1PreparedStatement {
  return db.prepare(`WITH RECURSIVE affected AS (${affectedThreadsSql}),
    retained(id, thread_id, parent_id, depth) AS (
      SELECT n.id, n.thread_id, n.parent_id, n.depth
      FROM discussion_nodes n JOIN comments c ON c.id = n.id
      WHERE n.thread_id IN (SELECT thread_id FROM affected) AND c.status != 'removed'
        ${excludedAuthor ? 'AND c.author_id != ?' : ''}
      UNION
      SELECT n.id, n.thread_id, n.parent_id, n.depth FROM discussion_nodes n
      JOIN retained child ON n.id = child.parent_id AND n.thread_id = child.thread_id AND n.depth = child.depth - 1
    )
    DELETE FROM discussion_nodes WHERE thread_id IN (SELECT thread_id FROM affected)
      AND id NOT IN (SELECT id FROM retained)`)
    .bind(...bindings, ...(excludedAuthor ? [excludedAuthor] : []));
}
