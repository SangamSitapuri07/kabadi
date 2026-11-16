'use client';

import { useEffect, useRef, useState } from 'react';

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
  const [busy, setBusy] = useState<'sign-in' | 'sign-out' | 'customer-setup' | null>(null);
  const [error, setError] = useState('');
  // This is the outcome of an action, not a durable authorization status.
  const [customerSetup, setCustomerSetup] = useState<'none' | 'completed'>('none');
  const setupGeneration = useRef(0);

  // Another tab may change the session. Discard a previous result and ignore
  // any in-flight result if this page was hidden; it isn't an identity check.
  useEffect(() => {
    const invalidate = () => {
      if (document.visibilityState === 'hidden') {
        setupGeneration.current++;
        setCustomerSetup('none');
      }
    };
    document.addEventListener('visibilitychange', invalidate);
    return () => { setupGeneration.current++; document.removeEventListener('visibilitychange', invalidate); };
  }, []);

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
    setupGeneration.current++;
    setCustomerSetup('none');
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
    setupGeneration.current++;
    setCustomerSetup('none');
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

  async function setupCustomer() {
    setBusy('customer-setup');
    setError('');
    setCustomerSetup('none');
    const generation = ++setupGeneration.current;
    try {
      const response = await fetch('/api/v1/account/customer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data: unknown = await response.json();
      if (generation !== setupGeneration.current) return;
      if (response.status === 401) {
        setStatus('unavailable');
        setError('Your sign-in could not be confirmed. Please check it and try again.');
        return;
      }
      if (response.status === 403 && data && typeof data === 'object' && 'error' in data &&
          data.error && typeof data.error === 'object' && 'code' in data.error && data.error.code === 'FORBIDDEN') {
        setError('Customer setup is not allowed for this account.');
        return;
      }
      if (!response.ok || !data || typeof data !== 'object' || !('data' in data) || !data.data ||
          typeof data.data !== 'object' || !('customer' in data.data) || data.data.customer !== 'ready') {
        throw new Error('Customer setup not confirmed');
      }
      setCustomerSetup('completed');
    } catch {
      if (generation === setupGeneration.current) {
        // A timed-out request may have succeeded. Retrying is safe and does not
        // promise that this attempt failed or that an account is active.
        setError('Customer setup could not be confirmed. Please try again later.');
      }
    } finally { setBusy(null); }
  }

  return <div className="auth-action">
    <div aria-live="polite" role="status">
      {status === 'checking' && <p className="auth-status">Checking sign-in status…</p>}
      {status === 'signed-in' && <p className="auth-status">Signed in with Google</p>}
      {status === 'unavailable' && <p className="auth-status">Sign-in status is unavailable.</p>}
    </div>
    {status === 'signed-out' && <button type="button" onClick={signIn} disabled={busy !== null}>{busy === 'sign-in' ? 'Opening Google…' : 'Continue with Google'}</button>}
    {status === 'signed-in' && <>
      <button type="button" onClick={signOut} disabled={busy !== null}>{busy === 'sign-out' ? 'Signing out…' : 'Sign out'}</button>
      <div className="customer-setup">
        <p>Set up a customer account to prepare for future pickup requests.</p>
        <button type="button" onClick={setupCustomer} disabled={busy !== null}>{busy === 'customer-setup' ? 'Setting up…' : 'Set up customer account'}</button>
        <div role="status" aria-live="polite">{customerSetup === 'completed' && <p>Customer setup completed for this sign-in. Pickup requests are not available yet.</p>}</div>
      </div>
    </>}
    {status === 'unavailable' && <button type="button" onClick={retrySession}>Try again</button>}
    <p className="auth-note">Development only. Sign-in and security are not ready for production.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
  </div>;
}
