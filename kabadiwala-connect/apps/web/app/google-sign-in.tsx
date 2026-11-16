'use client';

import { useState } from 'react';

export function GoogleSignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/sign-in/social', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      });
      if (!response.ok) throw new Error('Sign-in unavailable');
      const result = await response.json();
      const target = new URL(result.url);
      if (target.origin !== 'https://accounts.google.com') throw new Error('Unexpected sign-in destination');
      window.location.assign(target.href);
    } catch {
      setError('Google sign-in is unavailable. Please try again later.');
      setBusy(false);
    }
  }
  return <div className="auth-action">
    <button type="button" onClick={signIn} disabled={busy}>{busy ? 'Opening Google…' : 'Continue with Google'}</button>
    <p className="auth-note">Development only. Sign-in requires configuration and has not been verified with Google.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
  </div>;
}
