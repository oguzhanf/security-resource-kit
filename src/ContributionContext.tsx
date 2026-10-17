import type { Comment } from '../shared/contracts';
import { PageLink, threadPageId } from './routing';

export function ContributionContext({ comment }: { comment: Comment }) {
  return <div className="contribution-context">
    <p><PageLink pageId={threadPageId(comment.forumId, comment.threadId)}>{comment.threadTitle}</PageLink>
      {comment.pageId && <> / <PageLink pageId={comment.pageId}>Attached page</PageLink></>}</p>
    <p className="field-help">{comment.parentId ? <>Reply level {comment.depth}; parent <code>{comment.parentId}</code></> : 'Root post'} / {comment.threadKind}</p>
    {!!comment.ancestors?.length && <details>
      <summary>Parent context ({comment.ancestors.length})</summary>
      <ol>{comment.ancestors.map((ancestor) => <li key={ancestor.id}>
        <strong>{ancestor.handle}</strong> / {ancestor.status} / level {ancestor.depth} / <code>{ancestor.id}</code>
        <p className="comment-body">{ancestor.status === 'removed' ? 'Contribution removed; original parent relationship retained.' : ancestor.body}</p>
      </li>)}</ol>
    </details>}
  </div>;
}
