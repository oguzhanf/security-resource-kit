import { useState } from 'react';
import { z } from 'zod';
import type { SessionInfo, SiteConfig } from '../shared/contracts';
import { errorMessage, request } from './api';
import { PageLink } from './routing';
import { Turnstile } from './turnstile';

const receiptSchema = z.object({ received: z.literal(true), reference: z.uuid() });

export function ContactPage({ config, session }: { config: SiteConfig | null; session: SessionInfo | null }) {
  const [message, setMessage] = useState('');
  const [replyEmail, setReplyEmail] = useState('');
  const [token, setToken] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState('');
  const available = config?.environment === 'local' || !!config?.turnstileSiteKey;
  async function submit() {
    setBusy(true);
    setError('');
    setReceipt('');
    try {
      const result = await request('/contact', receiptSchema, {
        method: 'POST', csrfToken: session?.csrfToken,
        body: { message, replyEmail, turnstileToken: token },
      });
      setReceipt(result.reference);
      setMessage('');
      setReplyEmail('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }
  return <article className="contact-page">
    <h1>Contact the Operator</h1>
    <p>Send an account, privacy, or security request. Messages are private and are not posted to discussions. Do not include passwords, live tokens, or confidential incident data.</p>
    {!available ? <p>Contact is currently unavailable.</p> : <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor="contact-message">Message</label>
      <textarea id="contact-message" value={message} onChange={(event) => setMessage(event.target.value)} minLength={10} maxLength={2000} rows={6} required disabled={busy} />
      <label htmlFor="contact-email">Reply email (optional)</label>
      <input id="contact-email" type="email" value={replyEmail} onChange={(event) => setReplyEmail(event.target.value)} maxLength={254} autoComplete="email" disabled={busy} />
      <p className="field-help">Provide an email address only if you want a direct reply. Requests are retained for up to 90 days. See the <PageLink pageId="privacy">privacy notice</PageLink>.</p>
      <Turnstile siteKey={config?.turnstileSiteKey || ''} action="contact" onToken={setToken} resetKey={revision} />
      <button className="primary" type="submit" disabled={busy || (!!config?.turnstileSiteKey && !token)}>{busy ? 'Sending...' : 'Send private request'}</button>
    </form>}
    {error && <p className="error" role="alert">{error}</p>}
    {receipt && <p className="success-notice" role="status">Request received. Reference: <code>{receipt}</code>.</p>}
  </article>;
}
