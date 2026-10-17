export const ISSUE_REPOSITORY = 'oguzhanf/security-resource-kit';

export function trainingIssueUrl(lessonId: string, revision: number, stepId: string): string {
  const url = new URL(`https://github.com/${ISSUE_REPOSITORY}/issues/new`);
  url.searchParams.set('title', `Training correction: ${lessonId} / ${stepId}`);
  url.searchParams.set('body', `Topic: ${lessonId}\nRevision: ${revision}\nSubsection: ${stepId}\n\nWhat needs correcting?\n\nExpected behavior or public primary reference:\n\nUse only synthetic examples. This issue is PUBLIC. Do not include usernames, email addresses, tenant IDs, screenshots containing personal data, credentials, or incident records. Report private security/privacy concerns through the site's private Contact form.`);
  return url.href;
}
