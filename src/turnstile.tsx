import { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    theme: 'light';
    callback: (token: string) => void;
    'expired-callback': () => void;
    'error-callback': () => void;
  }): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Anti-abuse controls did not initialize.'));
    script.onerror = () => reject(new Error('Could not load the anti-abuse check. Reload the page and retry.'));
    document.head.append(script);
  });
  return loading;
}

export function Turnstile({ siteKey, action, onToken, resetKey }: {
  siteKey: string;
  action: 'register' | 'comment' | 'contact';
  onToken: (token: string) => void;
  resetKey: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!siteKey) return;
    let active = true;
    let widgetId: string | undefined;
    let api: TurnstileApi | undefined;
    onToken('');
    setError('');
    loadTurnstile().then((loaded) => {
      if (!active || !container.current) return;
      api = loaded;
      widgetId = loaded.render(container.current, {
        sitekey: siteKey, action, theme: 'light',
        callback: (token) => { if (active) onToken(token); },
        'expired-callback': () => { if (active) onToken(''); },
        'error-callback': () => {
          if (active) { onToken(''); setError('Anti-abuse verification failed. Reload and retry.'); }
        },
      });
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Anti-abuse verification is unavailable.');
    });
    return () => {
      active = false;
      if (api && widgetId !== undefined) api.remove(widgetId);
    };
  }, [siteKey, action, onToken, resetKey]);
  return <div className="anti-abuse"><div ref={container} />{error && <p className="error" role="alert">{error}</p>}</div>;
}
