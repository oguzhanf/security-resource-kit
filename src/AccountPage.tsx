import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { z } from 'zod';
import { acknowledgement, commentResponseSchema, privateContactSchema } from '../shared/api-schemas';
import { registrationOptionsSchema } from '../shared/passkey-schemas';
import type { Comment, PrivateContactRequest, SessionInfo, SiteConfig } from '../shared/contracts';
import { request, errorMessage } from './api';
import { PageLink } from './routing';
import { SOCIAL_PROVIDERS } from '../shared/contracts';
import { beginSocialSignIn } from './social-auth';
import { ContributionContext } from './ContributionContext';

const accountSchema = z.object({
  passkeys: z.array(z.object({ id: z.string(), deviceType: z.string(), backedUp: z.number(), createdAt: z.number() })),
  providers: z.array(z.object({ provider: z.enum(['microsoft', 'github']), createdAt: z.number() })),
});

export function AccountPage({ session, config, onSignIn, onRegister, onRefresh }: {
  session: SessionInfo | null;
  config: SiteConfig | null;
  onSignIn: () => void;
  onRegister: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [keys, setKeys] = useState<z.infer<typeof accountSchema>['passkeys']>([]);
  const [providers, setProviders] = useState<z.infer<typeof accountSchema>['providers']>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmHandle, setConfirmHandle] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [queue, setQueue] = useState<Comment[] | null>(null);
  const [contacts, setContacts] = useState<PrivateContactRequest[] | null>(null);
  const [keysRevision, setKeysRevision] = useState(0);
  const [publicHandle, setPublicHandle] = useState(session?.user?.handle || '');
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    request('/account', accountSchema, { signal: controller.signal }).then((data) => {
      setKeys(data.passkeys);
      setProviders(data.providers);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    });
    return () => controller.abort();
  }, [userId, keysRevision]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  if (!session?.user) return <article>
    <h1>Learner Account</h1>
    <p>An account records your learning progress and lets you contribute to moderated discussions. It does not verify employment or grant access to any Microsoft tenant.</p>
    <div className="button-row"><button className="primary" onClick={onRegister}>Register an account</button><button onClick={onSignIn}>Sign in</button></div>
  </article>;

  const { user } = session;
  return <article className="account-page">
    <p className="eyebrow">Account / {user.role}</p><h1>{user.handle}</h1>
    <p className="objective">Sign-in methods, versioned consent, and your learning record. Sensitive actions require a sign-in within five minutes.</p>
    <button onClick={onSignIn} disabled={busy}>Sign in again for sensitive actions</button>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success-notice" role="status">{notice}</p>}
    {session.managementLink && <section className="account-section">
      <h2>Site administration</h2>
      <p><PageLink pageId="management">Open site management: content editing, discussion moderation, private requests, accounts, and review history</PageLink>.</p>
      <p>Management authorization follows your verified personal GitHub identity, not your public site handle or moderator label.</p>
    </section>}
    <section className="account-section">
      <h2>Public site handle</h2>
      <p>Your site handle was chosen during registration. Signing in with GitHub does not replace it with your GitHub login. Changing it preserves your account, linked identities, discussions, and progress.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          const updated = await request('/account/handle', z.object({ handle: z.string() }), {
            method: 'POST', csrfToken: session.csrfToken, body: { handle: publicHandle },
          });
          await onRefresh();
          setPublicHandle(updated.handle);
          setNotice('Public handle updated. Your identity and learning records have not changed.');
        });
      }}>
        <label htmlFor="public-handle">Public site handle</label>
        <input id="public-handle" value={publicHandle} onChange={(event) => setPublicHandle(event.target.value)}
          minLength={3} maxLength={30} pattern="[a-z0-9][a-z0-9_-]*" required disabled={busy || session.needsConsent} />
        <p className="field-help">3-30 lowercase letters, numbers, underscores, or hyphens. The handle must be available. Requires a sign-in within five minutes.</p>
        <button type="submit" disabled={busy || session.needsConsent || publicHandle === user.handle}>Save public handle</button>
      </form>
    </section>
    {session.needsConsent && <section className="account-section">
      <h2>Updated participation policies</h2>
      <label className="consent-label"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
        <span>I accept the current <PageLink pageId="terms">terms</PageLink> and acknowledge the <PageLink pageId="privacy">privacy notice</PageLink>.</span></label>
      <button className="primary" disabled={busy || !accepted || !config} onClick={() => void perform(async () => {
        await request('/account/consent', acknowledgement('accepted'), {
          method: 'POST', csrfToken: session.csrfToken,
          body: { accepted, termsVersion: config?.termsVersion, privacyVersion: config?.privacyVersion },
        });
        await onRefresh();
        setNotice('Current policies accepted.');
      })}>Record acceptance</button>
    </section>}
    <section className="account-section"><h2>Linked accounts</h2>
      <p>Microsoft and GitHub accounts can be linked only after a recent sign-in. Accounts are not merged by email address or public handle.</p>
      {providers.length === 0 && <p>No external accounts linked.</p>}
      <ul className="passkey-list">{providers.map((entry) => <li key={entry.provider}>
        <strong>{SOCIAL_PROVIDERS.find((provider) => provider.id === entry.provider)?.name}</strong>
        <span>Linked {new Date(entry.createdAt * 1000).toISOString().slice(0, 10)}</span>
        <button disabled={busy || !session.authMethods.some((method) => method !== entry.provider)} onClick={() => void perform(async () => {
          await request(`/auth/social/${entry.provider}`, acknowledgement('removed'), { method: 'DELETE', csrfToken: session.csrfToken });
          setKeysRevision((value) => value + 1);
          await onRefresh();
          setNotice('Account link removed. Other sessions were revoked; provider authorization is managed separately.');
        })}>Unlink</button>
      </li>)}</ul>
      <div className="button-row">{config?.authProviders.filter((provider) => !providers.some((entry) => entry.provider === provider.id)).map((provider) =>
        <button key={provider.id} disabled={busy || session.needsConsent} onClick={() => void perform(async () => {
          await beginSocialSignIn(provider.id, { intent: 'link' }, session.csrfToken);
        })}>Link {provider.name}</button>)}</div>
    </section>
    <section className="account-section"><h2>Optional passkeys</h2>
      <p className="field-help">Keep more than one usable sign-in method. External account recovery is handled by its provider; there is no site password or email-reset bypass.</p>
      {keys.length === 0 && <p>No passkeys registered.</p>}
      <ul className="passkey-list">{keys.map((key) => <li key={key.id}>
        <code>{key.id.slice(0, 14)}...</code><span>{key.deviceType === 'multiDevice' ? 'Multi-device' : 'Single-device'} / {key.backedUp ? 'backup reported' : 'no backup reported'}</span>
        <button disabled={busy || session.authMethods.length <= 1 && keys.length <= 1} onClick={() => void perform(async () => {
          await request(`/auth/passkeys/${encodeURIComponent(key.id)}`, acknowledgement('removed'), { method: 'DELETE', csrfToken: session.csrfToken });
          setKeysRevision((value) => value + 1);
          await onRefresh();
          setNotice('Passkey removed. Other sessions were revoked.');
        })}>Remove</button>
      </li>)}</ul>
      <button disabled={busy || session.needsConsent} onClick={() => void perform(async () => {
        const options = await request('/auth/passkeys/options', registrationOptionsSchema, { method: 'POST', csrfToken: session.csrfToken });
        const response = await startRegistration({ optionsJSON: options });
        await request('/auth/passkeys/verify', acknowledgement('added'), { method: 'POST', csrfToken: session.csrfToken, body: response });
        setKeysRevision((value) => value + 1);
        await onRefresh();
        setNotice(keys.length ? 'Backup passkey added.' : 'Passkey added.');
      })}>{keys.length ? 'Add a backup passkey' : 'Add an optional passkey'}</button>
    </section>
    <section className="account-section"><h2>Your records and sessions</h2>
      <div className="button-row"><button disabled={busy} onClick={() => void perform(async () => {
        const data = await request('/account/export', z.record(z.string(), z.unknown()));
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `srk-${user.handle}.json`;
        link.click();
        URL.revokeObjectURL(url);
        setNotice('Your export was downloaded. Store it privately.');
      })}>Export my account data</button>
        <button disabled={busy} onClick={() => void perform(async () => {
          await request('/account/sessions/revoke', acknowledgement('signedOut'), { method: 'POST', csrfToken: session.csrfToken });
          await onRefresh();
        })}>Sign out every session</button></div>
    </section>
    {user.role === 'moderator' && <section className="account-section moderation">
      <h2>Moderation queue</h2><p>Approve only authorized public material. Re-authenticate before reviewing sensitive community actions.</p>
      <button disabled={busy || session.needsConsent} onClick={() => void perform(async () => {
        setQueue(await request('/moderation', z.array(commentResponseSchema)));
      })}>Load pending and reported contributions</button>
      {queue?.length === 0 && <p>No pending or reported contributions.</p>}
      {queue?.map((comment) => <article className="comment" key={comment.id} data-comment-id={comment.id}>
        <header><strong>{comment.handle}</strong><span>{comment.reports || 0} reports / {comment.status}</span></header>
        <ContributionContext comment={comment} />
        <p className="comment-body">{comment.body}</p><div className="button-row">{(['publish', 'hide'] as const).map((action) =>
          <button key={action} disabled={busy} onClick={() => void perform(async () => {
            await request(`/moderation/${comment.id}`, acknowledgement('reviewed'), { method: 'POST', csrfToken: session.csrfToken, body: { action } });
            setQueue((previous) => previous?.filter((entry) => entry.id !== comment.id) || []);
            setNotice(`Contribution ${action === 'publish' ? 'published' : 'hidden'}.`);
          })}>{action === 'publish' ? 'Publish' : 'Hide'}</button>)}</div>
        {!!comment.reportReasons?.length && <div className="notice"><strong>Latest private report reasons:</strong><ul>{comment.reportReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
      </article>)}
    </section>}
    {user.role === 'moderator' && <section className="account-section private-contact-queue">
      <h2>Private Contact Requests</h2>
      <p>These requests are visible only to moderators. Reply privately where an email address was supplied; do not copy request details into discussions.</p>
      <button disabled={busy || session.needsConsent} onClick={() => void perform(async () => {
        setContacts(await request('/moderation/contacts', z.array(privateContactSchema)));
      })}>Load private requests</button>
      {contacts?.length === 0 && <p>No unresolved requests.</p>}
      {contacts?.map((contact) => <article className="comment" key={contact.id}>
        <header><code>{contact.id}</code><time>{new Date(contact.createdAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC</time></header>
        {contact.replyEmail && <p>Reply address: {contact.replyEmail}</p>}
        <p className="comment-body">{contact.message}</p>
        <button disabled={busy} onClick={() => void perform(async () => {
          await request(`/moderation/contacts/${contact.id}/resolve`, acknowledgement('resolved'), { method: 'POST', csrfToken: session.csrfToken });
          setContacts((previous) => previous?.filter((entry) => entry.id !== contact.id) || []);
          setNotice('Private request marked resolved.');
        })}>Mark resolved</button>
      </article>)}
    </section>}
    <section className="account-section danger-zone"><h2>Delete account</h2>
      <p>This removes active account data, linked sign-in identities, passkeys, progress, contribution text and titles, and reports. Anonymous structural placeholders retain other members' original reply context; deleted pending or hidden branches stay unavailable. It does not delete your Microsoft or GitHub account. Provider backups and authorizations follow their separate policies.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          await request('/account', acknowledgement('deleted'), { method: 'DELETE', csrfToken: session.csrfToken, body: { confirmHandle } });
          await onRefresh();
        });
      }}>
        <label htmlFor="delete-confirm">Type <strong>{user.handle}</strong> to confirm</label>
        <input id="delete-confirm" value={confirmHandle} onChange={(event) => setConfirmHandle(event.target.value)} autoComplete="off" required disabled={busy} />
        <button className="danger" type="submit" disabled={busy || confirmHandle !== user.handle}>Permanently delete my account</button>
      </form>
    </section>
  </article>;
}
