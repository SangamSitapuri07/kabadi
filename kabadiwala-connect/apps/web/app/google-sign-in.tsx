'use client';

import { useEffect, useState } from 'react';

type SessionStatus = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';

async function getSession(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch('/api/auth/get-session', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Session unavailable');
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('authenticated' in result) || typeof result.authenticated !== 'boolean') {
    throw new Error('Invalid session response');
  }
  return result.authenticated;
}

export function GoogleSignIn() {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [busy, setBusy] = useState<'sign-in' | 'sign-out' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(signedIn => {
      if (!controller.signal.aborted) setStatus(signedIn ? 'signed-in' : 'signed-out');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('unavailable');
    });
    return () => controller.abort();
  }, []);

  async function retrySession() {
    setStatus('checking');
    setError('');
    try { setStatus(await getSession() ? 'signed-in' : 'signed-out'); }
    catch { setStatus('unavailable'); }
  }

  async function signIn() {
    setBusy('sign-in');
    setError('');
    try {
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      });
      if (!response.ok) throw new Error('Sign-in unavailable');
      const result = await response.json();
      const target = new URL(result.url);
      if (target.origin !== 'https://accounts.google.com' || target.username || target.password) throw new Error('Unexpected sign-in destination');
      window.location.assign(target.href);
    } catch {
      setError('Google sign-in is unavailable. Please try again later.');
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy('sign-out');
    setError('');
    try {
      const response = await fetch('/api/auth/sign-out', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!response.ok) throw new Error('Sign-out unavailable');
      const signedIn = await getSession();
      setStatus(signedIn ? 'signed-in' : 'signed-out');
      if (signedIn) setError('Sign-out could not be confirmed. Please try again.');
    } catch {
      // An interrupted request may have succeeded server-side. Don't claim
      // either signed-in or signed-out until the session can be checked.
      setStatus('unavailable');
      setError('Sign-out could not be confirmed. Check your connection and try again.');
    } finally { setBusy(null); }
  }

  return <div className="auth-action">
    <div aria-live="polite" role="status">
      {status === 'checking' && <p className="auth-status">Checking sign-in status…</p>}
      {status === 'signed-in' && <p className="auth-status">Signed in with Google</p>}
      {status === 'unavailable' && <p className="auth-status">Sign-in status is unavailable.</p>}
    </div>
    {status === 'signed-out' && <button type="button" onClick={signIn} disabled={busy !== null}>{busy === 'sign-in' ? 'Opening Google…' : 'Continue with Google'}</button>}
    {status === 'signed-in' && <button type="button" onClick={signOut} disabled={busy !== null}>{busy === 'sign-out' ? 'Signing out…' : 'Sign out'}</button>}
    {status === 'unavailable' && <button type="button" onClick={retrySession}>Try again</button>}
    <p className="auth-note">Development only. Sign-in and security are not ready for production.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
  </div>;
}
