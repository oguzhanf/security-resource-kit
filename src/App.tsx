import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { acknowledgement, configSchema, memberCatalogSchema, progressSchema, publicOutlineSchema, sessionSchema, sourceStatusSchema } from '../shared/api-schemas';
import { PUBLIC_PAGE_IDS } from '../shared/access-policy';
import type { Lesson, MemberCatalog, PublicTrack } from '../shared/content-types';
import type { Progress, SessionInfo, SiteConfig, SourceStatus } from '../shared/contracts';
import { AccountPage } from './AccountPage';
import { AuthDialog } from './AuthDialog';
import { Discussion } from './Discussion';
import { ContactPage } from './ContactPage';
import { LessonView } from './LessonView';
import { Navigation } from './Navigation';
import { errorMessage, request } from './api';
import { PrivacyPage, TermsPage } from './legal';
import { AboutPage, HomePage, RegistrationPage, RoadmapPage, SourcesPage, TrackPage } from './pages';
import { discussionRoute, navigate, PageLink, usePage } from './routing';
import { socialSignInFailure } from './social-auth';
import { ManagementPage } from './ManagementPage';
import { ForumsPage } from './ForumsPage';

export function App() {
  const pageId = usePage();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [catalog, setCatalog] = useState<MemberCatalog | null>(null);
  const [outline, setOutline] = useState<PublicTrack[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[]>([]);
  const [serviceError, setServiceError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reloadServices, setReloadServices] = useState(0);
  const [authMode, setAuthMode] = useState<'register' | 'login' | null>(null);
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [authFailure, setAuthFailure] = useState(() => socialSignInFailure(window.location.search));
  const lessons = catalog?.lessons || [];
  const tracks = catalog?.tracks || [];
  const lesson = lessons.find((entry) => entry.id === pageId);
  const activeTrack = tracks.find((track) => track.status === 'available' && pageId === `track-${track.id}`);
  const lessonTrack = lesson ? tracks.find((track) => track.id === lesson.trackId) : undefined;
  const forumRoute = discussionRoute(pageId);
  const forumTitle = forumRoute?.threadId ? 'Discussion thread'
    : forumRoute?.forumId ? tracks.find((track) => track.id === forumRoute.forumId)?.title ||
      ({ site: 'Site discussions', announcements: 'Announcements' } as Record<string, string>)[forumRoute.forumId] || 'Discussion category'
    : forumRoute ? 'Discussions' : null;
  const pageTitle = !session?.user && !PUBLIC_PAGE_IDS.has(pageId) ? 'Registration required' : forumTitle || lesson?.shortTitle || activeTrack?.title || ({
    home: 'Overview', 'track-agent-identity': 'Agent Identity', sources: 'References',
    roadmap: 'Planned topics', about: 'About', account: 'My account', management: 'Site management', terms: 'Terms', privacy: 'Privacy', contact: 'Contact',
  } as Record<string, string>)[pageId] || 'Page not found';

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has('authError')) {
      url.searchParams.delete('authError');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  useEffect(() => {
    document.title = `${pageTitle} - Security Resource Kit`;
    setMobileNavigation(false);
  }, [pageTitle]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setServiceError('');
    async function load() {
      const errors: string[] = [];
      const [configuration, identity, publicOutline] = await Promise.allSettled([
        request('/config', configSchema, { signal: controller.signal }),
        request('/auth/me', sessionSchema, { signal: controller.signal }),
        request('/outline', publicOutlineSchema, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      if (configuration.status === 'fulfilled') setConfig(configuration.value);
      else errors.push(`Configuration: ${errorMessage(configuration.reason)}`);
      if (publicOutline.status === 'fulfilled') setOutline(publicOutline.value);
      else errors.push(`Content outline: ${errorMessage(publicOutline.reason)}`);
      setCatalog(null);
      setSourceStatuses([]);
      setProgress([]);
      if (identity.status === 'fulfilled') {
        setSession(identity.value);
        if (identity.value.user && !identity.value.needsConsent) {
          try {
            const [content, records, statuses] = await Promise.all([
              request('/catalog', memberCatalogSchema, { signal: controller.signal }),
              request('/progress', z.array(progressSchema), { signal: controller.signal }),
              request('/sources', z.array(sourceStatusSchema), { signal: controller.signal }),
            ]);
            if (!controller.signal.aborted) {
              setCatalog(content);
              setProgress(records);
              setSourceStatuses(statuses);
            }
          } catch (failure) {
            if (!controller.signal.aborted) errors.push(`Member content: ${errorMessage(failure)}`);
          }
        }
      } else {
        setSession(null);
        errors.push(`Account connection: ${errorMessage(identity.reason)}`);
      }
      if (!controller.signal.aborted) { setServiceError(errors.join(' ')); setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [reloadServices]);

  const refreshSession = useCallback(async () => {
    const next = await request('/auth/me', sessionSchema);
    setSession(next);
    setCatalog(null);
    setProgress([]);
    setSourceStatuses([]);
    if (next.user && !next.needsConsent) {
      const [content, records, statuses] = await Promise.all([
        request('/catalog', memberCatalogSchema),
        request('/progress', z.array(progressSchema)),
        request('/sources', z.array(sourceStatusSchema)),
      ]);
      setCatalog(content);
      setProgress(records);
      setSourceStatuses(statuses);
    } else if (!next.user) {
      navigate('home');
    }
  }, []);

  useEffect(() => {
    const expire = () => {
      setSession({ user: null, csrfToken: null, authMethods: [] });
      setCatalog(null);
      setProgress([]);
      setSourceStatuses([]);
      setServiceError('Your session has ended. Sign in to access the Resource Kit.');
      navigate('home');
    };
    window.addEventListener('srk-session-expired', expire);
    const delay = session?.user && session.expiresAt ? Math.max(0, session.expiresAt * 1000 - Date.now()) : null;
    const timer = delay === null ? undefined : window.setTimeout(expire, Math.min(delay, 2147483647));
    return () => {
      window.removeEventListener('srk-session-expired', expire);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session?.user, session?.expiresAt]);

  async function recordAttempt(stage: 'pre' | 'post', answers: number[]) {
    if (!lesson) throw new Error('Lesson not found.');
    if (loading || !session?.user) throw new Error('Registration and sign-in are required.');
    const result = await request(`/lessons/${lesson.id}/attempts`, progressSchema, {
        method: 'POST', csrfToken: session.csrfToken, body: { stage, revision: lesson.revision, answers },
      });
    const updated = [...progress.filter((record) => record.lessonId !== result.lessonId), result];
    setProgress(updated);
  }

  async function signOut() {
    setSigningOut(true);
    setServiceError('');
    try {
      await request('/auth/logout', acknowledgement('signedOut'), { method: 'POST', csrfToken: session?.csrfToken });
      await refreshSession();
    } catch (failure) { setServiceError(errorMessage(failure)); }
    finally { setSigningOut(false); }
  }

  let content;
  const member = !!session?.user && !!catalog && !session.needsConsent;
  const contentSaved = (updated: Lesson) => setCatalog((previous) => previous ? {
    ...previous, lessons: previous.lessons.map((entry) => entry.id === updated.id ? updated : entry),
  } : null);
  const activeProgress = lesson ? progress.find((record) => record.lessonId === lesson.id && record.revision === lesson.revision) : undefined;
  if (pageId === 'terms') content = <TermsPage config={config} />;
  else if (pageId === 'privacy') content = <PrivacyPage config={config} />;
  else if (pageId === 'contact') content = <ContactPage config={config} session={session} />;
  else if (pageId === 'account' && session?.user) content = <AccountPage key={session.user.id} session={session} config={config}
    onSignIn={() => setAuthMode('login')} onRegister={() => setAuthMode('register')} onRefresh={refreshSession} />;
  else if (pageId === 'management') content = session?.user && session.managementLink && !session.needsConsent
    ? <ManagementPage key={session.user.id} session={session} catalog={catalog} onContentSaved={contentSaved} onSignIn={() => setAuthMode('login')} onRefresh={refreshSession} />
    : <article><h1>Access unavailable</h1><p>Site management is not available to this account.</p></article>;
  else if (!member) content = <RegistrationPage onRegister={() => setAuthMode('register')} onSignIn={() => setAuthMode('login')} registrationEnabled={!!config?.registrationEnabled} />;
  else if (forumRoute && session) content = <ForumsPage key={`${pageId}:${session.user?.id}`} forumId={forumRoute.forumId}
    threadId={forumRoute.threadId} session={session} config={config} />;
  else if (lesson && catalog && session?.user) content = <LessonView key={`${lesson.id}:${lesson.revision}:${session.user.id}`} learnerId={session.user.id} lesson={lesson} progress={activeProgress} records={progress} sourceStatuses={sourceStatuses} catalog={catalog} onAttempt={recordAttempt} session={session} onContentSaved={contentSaved} />;
  else if (pageId === 'home' && catalog) content = <HomePage progress={progress} catalog={catalog} />;
  else if (activeTrack && catalog) content = <TrackPage progress={progress} track={activeTrack} catalog={catalog} />;
  else if (pageId === 'sources' && catalog) content = <SourcesPage statuses={sourceStatuses} catalog={catalog} />;
  else if (pageId === 'roadmap' && catalog) content = <RoadmapPage catalog={catalog} />;
  else if (pageId === 'about') content = <AboutPage config={config} />;
  else content = <article><h1>Page Not Found</h1><p><PageLink pageId="home">Return to the Resource Kit</PageLink>.</p></article>;

  return <div className="resource-kit">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="site-header">
      <div className="title-bar"><span className="kit-mark" aria-hidden="true">RK</span><span>Security Resource Kit</span><span className="title-bar-meta">Microsoft security technologies</span></div>
      <div className="brand-bar"><PageLink pageId="home" className="wordmark"><strong>Security Resource Kit</strong></PageLink>
        <div className="identity-controls">{session?.user ? <>
          {session.managementLink && <a className="management-link" href={session.managementLink.href}>{session.managementLink.label}</a>}
          <PageLink pageId="account" className="signed-in">Signed in: {session.user.handle}</PageLink><button onClick={() => void signOut()} disabled={signingOut}>{signingOut ? 'Signing out...' : 'Sign out'}</button></>
          : <><button onClick={() => setAuthMode('login')} disabled={loading}>Sign in</button><button className="primary" onClick={() => setAuthMode('register')} disabled={loading}>Register</button></>}</div>
      </div>
      <div className="toolbar" aria-label="Resource kit tools">
        <button className="mobile-nav-toggle" onClick={() => setMobileNavigation(!mobileNavigation)} aria-expanded={mobileNavigation} aria-controls="site-navigation">Contents</button>
        <button onClick={() => navigate('home')}><span className="toolbar-symbol" aria-hidden="true">H</span>Home</button>
        {member && <>
          <button onClick={() => navigate('home')}><span className="icon-book" aria-hidden="true" />Topics</button>
          <button onClick={() => navigate('sources')}><span className="icon-document" aria-hidden="true" />References</button>
          <button onClick={() => navigate('discussions')}><span className="icon-discussion" aria-hidden="true" />Discussions</button>
          <button onClick={() => window.print()}><span className="toolbar-symbol" aria-hidden="true">P</span>Print</button>
        </>}
        <span className="toolbar-divider" /><span className="toolbar-address">Resource Kit / {lessonTrack ? `${lessonTrack.title} / ` : ''}{pageTitle}</span>
      </div>
    </header>
    <div className="workspace">
      <aside id="site-navigation" className={`sidebar ${mobileNavigation ? 'mobile-open' : ''}`}><Navigation pageId={pageId} progress={progress} catalog={member ? catalog : null} outline={outline} onNavigate={() => setMobileNavigation(false)} /></aside>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <div className="breadcrumb"><PageLink pageId="home">Resource Kit</PageLink>{pageId !== 'home' && <> / {lessonTrack && <><PageLink pageId={`track-${lessonTrack.id}`}>{lessonTrack.title}</PageLink> / </>}{pageTitle}</>}
          <span className="practice-label">{session?.user ? 'Signed in' : 'Registration required'}</span></div>
        {loading && <p className="connection-status" role="status">Connecting to community services...</p>}
        {authFailure && <p className="error" role="alert">{authFailure} <button onClick={() => setAuthFailure('')}>Dismiss</button></p>}
        {serviceError && <div className="notice" role="alert"><strong>Service connection unavailable.</strong> {serviceError} <button onClick={() => setReloadServices((value) => value + 1)}>Retry connection</button></div>}
        {session?.needsConsent && <p className="notice">Participation policies changed. <PageLink pageId="account">Review and accept the current versions</PageLink> before recording progress or contributing.</p>}
        <div className="page-content">{content}</div>
        {member && session && !lesson && catalog?.pageIds.includes(pageId) && <Discussion key={`${pageId}:${session.user?.id}`} pageId={pageId} session={session} config={config} />}
        <footer className="page-footer"><span>Security Resource Kit</span><span>{member && <><PageLink pageId="about">About</PageLink> / </>}<PageLink pageId="terms">Terms</PageLink> / <PageLink pageId="privacy">Privacy</PageLink> / <PageLink pageId="contact">Contact</PageLink></span></footer>
      </main>
    </div>
    <footer className="status-bar"><span>{loading ? 'Connecting...' : serviceError ? 'Connection unavailable' : member ? 'Ready' : 'Sign in required'}</span><span>{member ? `${lessons.length} topics` : 'Free registration'}</span><span>Security Resource Kit</span></footer>
    <AuthDialog mode={authMode} config={config} session={session} onClose={() => { setAuthMode(null); setAuthFailure(''); }} onAuthenticated={refreshSession} />
  </div>;
}
