import { useEffect, useRef, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { acknowledgement } from '../shared/api-schemas';
import { authenticationOptionsSchema, registrationOptionsSchema } from '../shared/passkey-schemas';
import type { SessionInfo, SiteConfig, SocialProviderId } from '../shared/contracts';
import { errorMessage, request } from './api';
import { Turnstile } from './turnstile';
import { beginSocialSignIn } from './social-auth';

export function AuthDialog({ mode, config, session, onClose, onAuthenticated }: {
  mode: 'register' | 'login' | null;
  config: SiteConfig | null;
  session: SessionInfo | null;
  onClose: () => void;
  onAuthenticated: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [handle, setHandle] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [token, setToken] = useState('');
  const [captchaRevision, setCaptchaRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [busyMethod, setBusyMethod] = useState('');
  const [error, setError] = useState('');
  const supported = browserSupportsWebAuthn();
  const providers = (config?.authProviders || []).filter((provider) =>
    !session?.user || mode === 'register' || session.authMethods.includes(provider.id));
  const canUsePasskey = supported && (!session?.user || mode === 'register' || session.authMethods.includes('passkey'));
  useEffect(() => {
    const element = dialog.current;
    if (mode && element && !element.open) {
      setError('');
      setAccepted(false);
      element.showModal();
    } else if (!mode && element?.open) element.close();
  }, [mode]);

  async function submit(provider?: SocialProviderId) {
    if (!mode || !config?.registrationEnabled || (!provider && !canUsePasskey)) return;
    setBusy(true);
    setBusyMethod(provider || 'passkey');
    setError('');
    try {
      if (provider) {
        await beginSocialSignIn(provider, mode === 'register' ? {
          intent: 'register', handle, accepted, termsVersion: config.termsVersion,
          privacyVersion: config.privacyVersion, turnstileToken: token,
        } : { intent: session?.user ? 'reauth' : 'login' }, session?.csrfToken);
        return;
      } else if (mode === 'register') {
        const options = await request('/auth/register/options', registrationOptionsSchema, {
          method: 'POST',
          body: { handle, accepted, termsVersion: config.termsVersion, privacyVersion: config.privacyVersion, turnstileToken: token },
        });
        const credential = await startRegistration({ optionsJSON: options });
        await request('/auth/register/verify', acknowledgement('registered'), { method: 'POST', body: credential });
      } else {
        const options = await request('/auth/login/options', authenticationOptionsSchema, { method: 'POST' });
        const credential = await startAuthentication({ optionsJSON: options });
        await request('/auth/login/verify', acknowledgement('authenticated'), { method: 'POST', body: credential });
      }
      await onAuthenticated();
      onClose();
    } catch (failure) {
      setError(failure instanceof DOMException && failure.name === 'NotAllowedError'
        ? 'The passkey operation was cancelled or timed out. Start again when ready.'
        : errorMessage(failure));
    } finally {
      setBusy(false);
      setCaptchaRevision((value) => value + 1);
    }
  }

  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="auth-title" onCancel={(event) => {
    if (busy) event.preventDefault();
    else onClose();
  }}>
    <div className="dialog-title"><span id="auth-title">{mode === 'register' ? 'Register a learner account' : 'Sign in'}</span>
      <button type="button" onClick={onClose} disabled={busy} aria-label="Close sign-in dialog">X</button></div>
    <div className="dialog-body">
        {!config?.registrationEnabled ? <>
          <p>{mode === 'register' ? 'Registration is currently unavailable.' : 'Sign-in is currently unavailable.'}</p>
          <div className="dialog-actions"><button type="button" onClick={onClose}>Close</button></div>
        </> : <>
        <p>{mode === 'register' ? 'Choose a public handle, accept the participation policies, and select a sign-in method. Employment is not verified.'
          : session?.user ? 'Use a method already linked to your account. Sensitive actions require a sign-in within five minutes.'
            : 'Use the account or passkey you registered with this site.'}</p>
      {!supported && <p className="field-help">This browser cannot use passkeys. Use an available account sign-in method.</p>}
      <form onSubmit={(event) => {
        event.preventDefault();
        const button = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
        const method = button instanceof HTMLButtonElement ? button.value : providers[0]?.id || 'passkey';
        const provider = providers.find((entry) => entry.id === method);
        if (method !== 'passkey' && !provider) { setError('Choose an available sign-in method.'); return; }
        void submit(provider?.id);
      }}>
        {mode === 'register' && <>
          <label className="field-label" htmlFor="register-handle">Public handle</label>
          <input id="register-handle" name="handle" value={handle} onChange={(event) => setHandle(event.target.value)} minLength={3} maxLength={30}
            pattern={'[a-zA-Z0-9][a-zA-Z0-9_\\-]*'} placeholder="e.g. threat-modeler" autoComplete="off" required disabled={busy} />
          <p className="field-help">3-30 characters: letters, numbers, hyphen, underscore. Visible on approved contributions.</p>
          <label className="consent-label"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} required disabled={busy} />
            <span>I am 18 or older, accept the <a href="/terms" target="_blank" rel="noopener noreferrer">Terms of participation</a>, and acknowledge the <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy notice</a>. I will share only authorized, public material.</span></label>
          {config?.registrationEnabled && <Turnstile siteKey={config.turnstileSiteKey} action="register" onToken={setToken} resetKey={captchaRevision} />}
        </>}
        {providers.length > 0 && <div className="social-auth-methods">
          {providers.map((provider) => <button key={provider.id} className="primary" type="submit" value={provider.id}
            disabled={busy || (mode === 'register' && (!accepted || (!!config.turnstileSiteKey && !token)))}>
            {busy && busyMethod === provider.id ? `Opening ${provider.name}...` : `${mode === 'register' ? 'Continue' : 'Sign in'} with ${provider.name}`}
          </button>)}
        </div>}
        <p className="field-help">{providers.length > 0 ? 'Passkeys are optional. Manage linked accounts and backup methods in My account.'
          : 'Keep a usable backup sign-in method. There is no site password or email-reset fallback.'}</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          {(!session?.user || mode === 'register' || session.authMethods.includes('passkey')) && <button type="submit" value="passkey" disabled={busy || !canUsePasskey || !config?.registrationEnabled ||
            (mode === 'register' && (!accepted || (!!config.turnstileSiteKey && !token)))}>
            {busy && busyMethod === 'passkey' ? 'Waiting for passkey...' : mode === 'register' ? 'Accept & create passkey' : 'Use my passkey'}
          </button>}</div>
      </form>
      </>}
    </div>
  </dialog>;
}
