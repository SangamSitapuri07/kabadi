'use client';

import { useEffect, useRef, useState } from 'react';
import { TestPickups } from './test-pickups';
import { CatalogViewer } from './catalog-viewer';
import { CollectorQueue } from './collector-queue';
import { DisputeAdmin } from './dispute-admin';
import { PayoutAdmin } from './payout-admin';
import { NotificationInbox } from './notification-inbox';
import { LotBoard } from './lot-board';

type SessionStatus = 'checking' | 'signed-out' | 'signed-in' | 'unavailable';
type Details = { name: string; addressLine: string; city: string; state: string; postalCode: string };
const blankDetails = (): Details => ({ name: '', addressLine: '', city: '', state: '', postalCode: '' });
function isDetails(value: unknown): value is Details {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const limits = { name: 100, addressLine: 200, city: 100, state: 100, postalCode: 20 } as const;
  return (Object.keys(limits) as (keyof typeof limits)[]).every(key => {
    const field = fields[key];
    return typeof field === 'string' && !/[\uD800-\uDFFF]/u.test(field) && !!field.trim() &&
      Array.from(field.trim()).length <= limits[key] && !/[\u0000-\u001f\u007f-\u009f]/u.test(field.trim());
  });
}

// Why a session check failed, kept apart because the three cases have different
// causes and the user cannot act on "unavailable":
//   unreachable  the request never completed (web server down or hung)
//   status       the bridge answered an unexpected HTTP status
//   malformed    a 200 whose body is not the shape the bridge promises
class SessionError extends Error {
  constructor(readonly kind: 'unreachable' | 'status' | 'malformed', readonly status?: number) {
    super(kind);
  }
}

async function getSession(signal?: AbortSignal): Promise<boolean> {
  let response: Response;
  try { response = await fetch('/api/auth/get-session', { cache: 'no-store', signal }); }
  catch { throw new SessionError('unreachable'); }
  if (!response.ok) throw new SessionError('status', response.status);
  let result: unknown;
  try { result = await response.json(); } catch { throw new SessionError('malformed', response.status); }
  if (!result || typeof result !== 'object' || !('authenticated' in result) || typeof result.authenticated !== 'boolean') {
    throw new SessionError('malformed', response.status);
  }
  return result.authenticated;
}

// The chain, highest last. Kept in the same order as the API's CHAIN_ROLES so a
// panel and the server cannot disagree about which tier this account sells at.
const CHAIN_ORDER = ['customer', 'collector', 'shop', 'mandi', 'recycler'] as const;

function sellingTier(roles: string[] | null): string | null {
  if (!roles) return null;
  let highest: string | null = null;
  for (const role of CHAIN_ORDER) {
    // A customer holds no stock, so only collector and above count here.
    if (role === 'customer') continue;
    if (roles.includes(role)) highest = role;
  }
  return highest;
}

export function GoogleSignIn() {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [busy, setBusy] = useState<'sign-in' | 'sign-out' | 'customer-setup' | 'profile-load' | 'profile-save' | 'dev-signin' | null>(null);
  const [error, setError] = useState('');
  // The measured reason the session could not be read. Null when it was read.
  const [sessionProblem, setSessionProblem] = useState<{ kind: string; status?: number } | null>(null);
  // This is the outcome of an action, not a durable authorization status.
  const [customerSetup, setCustomerSetup] = useState<'none' | 'completed'>('none');
  const setupGeneration = useRef(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [details, setDetails] = useState<Details>(blankDetails);
  const [profileMessage, setProfileMessage] = useState('');
  // Which panels to show. `null` means "not answered yet": no panel is shown on
  // an assumption, and a failed read leaves every panel hidden rather than
  // showing admin tools to whoever happens to be signed in. Nothing here is an
  // authorization decision -- every route still checks its own grant.
  const [roles, setRoles] = useState<string[] | null>(null);
  // Development sign-in: creates a disposable @example.test identity so three
  // tiers can be tested without three Google accounts -- and signs back in to one
  // already created, because walking material up the chain means switching
  // identities and a form that only creates is a one-way door.
  const [devOpen, setDevOpen] = useState(false);
  // Which of the two things the form is for. Creating names a role; signing in
  // does not, because the account already has one and this form must never look
  // like it can change it.
  const [devMode, setDevMode] = useState<'create' | 'sign-in'>('create');
  // Whether this session came from the test-account form rather than Google, so
  // the status line can say which. Display only: the server decides identity.
  const [devSignedIn, setDevSignedIn] = useState(false);
  const [devEmail, setDevEmail] = useState('');
  // What this test identity IS. The role is chosen before the account exists, so
  // the account is created with its tier rather than being created empty and then
  // needing a database-side grant before anything works.
  const [devRole, setDevRole] = useState('customer');
  const [devPassword, setDevPassword] = useState('');
  const [devMessage, setDevMessage] = useState('');
  const [devAvailable, setDevAvailable] = useState<boolean | null>(null);
  function clearProfile() { setProfileOpen(false); setDetails(blankDetails()); setProfileMessage(''); }

  // Another tab may change the session. Discard a previous result and ignore
  // any in-flight result if this page was hidden; it isn't an identity check.
  useEffect(() => {
    const invalidate = () => {
      if (document.visibilityState === 'hidden') {
        setupGeneration.current++;
        setCustomerSetup('none');
        clearProfile();
      }
    };
    document.addEventListener('visibilitychange', invalidate);
    return () => { setupGeneration.current++; document.removeEventListener('visibilitychange', invalidate); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(signedIn => {
      if (controller.signal.aborted) return;
      setSessionProblem(null);
      setStatus(signedIn ? 'signed-in' : 'signed-out');
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setSessionProblem(failure instanceof SessionError
        ? { kind: failure.kind, status: failure.status }
        : { kind: 'malformed' });
      setStatus('unavailable');
    });
    return () => controller.abort();
  }, []);

  // Creating a test identity, or signing back in to one. The API refuses unless
  // DEV_SIGNIN_ENABLED=yes made it available, so a failure here is reported,
  // never worked around.
  async function devSignIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy('dev-signin'); setDevMessage('');
    const creating = devMode === 'create';
    try {
      const response = await fetch('/api/v1/dev/sign-in', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // The role is sent only when creating. Sending it while signing in would
        // imply this form could set a tier on an account that already has one.
        body: JSON.stringify(creating
          ? { action: 'create', email: devEmail, password: devPassword, role: devRole }
          : { action: 'sign-in', email: devEmail, password: devPassword }),
        signal: AbortSignal.timeout(15000),
      });
      const json: unknown = await response.json();
      if (response.status === 503) { setDevAvailable(false); setBusy(null); return; }
      // Either success means a session was set, so the panels are re-read from
      // the server rather than assumed.
      if (response.status === 201 || response.status === 200) {
        setDevPassword(''); setDevOpen(false); setDevSignedIn(true);
        await refreshSession();
        return;
      }
      const message = (json as { error?: { message?: string } })?.error?.message;
      // A taken address while creating is a nudge, not a failure: the account is
      // there, so switch the form to signing in and keep the email typed.
      if (creating && response.status === 409 && message?.includes('already exists')) {
        setDevMode('sign-in');
        setDevMessage('That test account already exists. Enter its password to sign in.');
        setBusy(null); return;
      }
      setDevMessage(message ?? (creating ? 'That test account could not be created.' : 'That account could not be signed in to.'));
      setBusy(null);
    } catch {
      setDevMessage(creating ? 'That test account could not be created.' : 'That account could not be signed in to.');
      setBusy(null);
    }
  }

  // The session and the roles are both re-read from the server after sign-in:
  // this component never decides for itself that an identity now exists.
  async function refreshSession() {
    try {
      const signedIn = await getSession();
      setStatus(signedIn ? 'signed-in' : 'signed-out');
      if (signedIn) await loadRoles(); else setRoles(null);
    } catch { setStatus('unavailable'); setRoles(null); }
    finally { setBusy(null); }
  }

  async function loadRoles() {
    try {
      const response = await fetch('/api/v1/account/roles', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) { setRoles([]); return; }
      const json = await response.json();
      const reported = json?.data?.roles;
      // The same six roles the API knows. An unknown value is dropped rather
      // than trusted: this list only decides which panels mount, and every route
      // still checks its own grant.
      setRoles(Array.isArray(reported)
        ? reported.filter((r: unknown) => typeof r === 'string' &&
            ['customer', 'collector', 'shop', 'mandi', 'recycler', 'admin'].includes(r))
        : []);
    } catch { setRoles([]); }
  }
  // Re-read on every sign-in, and forget on sign-out: a stale list must never
  // outlive the session it described.
  useEffect(() => {
    if (status === 'signed-in') void loadRoles();
    else if (status === 'signed-out') { setRoles(null); setDevSignedIn(false); }
  }, [status]);

  async function retrySession() {
    setStatus('checking');
    setError('');
    setSessionProblem(null);
    setupGeneration.current++;
    setCustomerSetup('none');
    clearProfile();
    try { setStatus(await getSession() ? 'signed-in' : 'signed-out'); }
    catch { setStatus('unavailable'); }
    setRoles(null);
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
    clearProfile();
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
    clearProfile();
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

  async function loadProfile() {
    setBusy('profile-load'); setError(''); setProfileMessage('');
    const generation = ++setupGeneration.current;
    try {
      const response = await fetch('/api/v1/account/customer/details', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (generation !== setupGeneration.current) return;
      if (response.status === 401) { clearProfile(); setStatus('unavailable'); setError('Your sign-in could not be confirmed. Please check it and try again.'); return; }
      if (response.status === 403) { clearProfile(); setError('Customer details are not available for this account.'); return; }
      const data: unknown = await response.json();
      if (generation !== setupGeneration.current) return;
      if (!response.ok || !data || typeof data !== 'object' || !('data' in data) || !data.data || typeof data.data !== 'object' || !('details' in data.data)) throw new Error('Invalid response');
      const value = data.data.details;
      if (value !== null && !isDetails(value)) throw new Error('Invalid details');
      setDetails(value === null ? blankDetails() : { name: value.name, addressLine: value.addressLine, city: value.city, state: value.state, postalCode: value.postalCode });
      setProfileOpen(true);
    } catch { if (generation === setupGeneration.current) { clearProfile(); setError('Customer details could not be loaded. Please try again.'); } }
    finally { setBusy(null); }
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('profile-save'); setError(''); setProfileMessage('');
    const generation = ++setupGeneration.current;
    try {
      const response = await fetch('/api/v1/account/customer/details', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details), signal: AbortSignal.timeout(10000) });
      if (generation !== setupGeneration.current) return;
      if (response.status === 401) { clearProfile(); setStatus('unavailable'); setError('Your sign-in could not be confirmed. Please check it and try again.'); return; }
      if (response.status === 403) { clearProfile(); setError('Customer details are not available for this account.'); return; }
      if (response.status === 400) { setError('Please check all fields and try again.'); return; }
      const data: unknown = await response.json();
      if (generation !== setupGeneration.current) return;
      if (!response.ok || !data || typeof data !== 'object' || !('data' in data) || !data.data || typeof data.data !== 'object' || !('saved' in data.data) || data.data.saved !== true) throw new Error('Save not confirmed');
      setProfileMessage('Customer details saved.');
    } catch { if (generation === setupGeneration.current) setError('Save could not be confirmed. Please try again.'); }
    finally { setBusy(null); }
  }

  return <div className="auth-action">
    <div aria-live="polite" role="status">
      {status === 'checking' && <p className="auth-status">Checking sign-in status…</p>}
      {/* After a test sign-in the session belongs to an @example.test identity,
          so claiming Google would be a small lie on the one screen where the
          owner is checking that switching identities actually worked. */}
      {status === 'signed-in' && <p className="auth-status" data-test-identity={devSignedIn || undefined}>
        {devSignedIn ? 'Signed in as a test account' : 'Signed in with Google'}
      </p>}
      {status === 'unavailable' && <p className="auth-status">Sign-in status is unavailable.</p>}
    </div>
    {status === 'signed-out' && <button type="button" onClick={signIn} disabled={busy !== null}>{busy === 'sign-in' ? 'Opening Google…' : 'Continue with Google'}</button>}
    {/* Development sign-in. It creates an @example.test identity with a password,
        which is only possible when the API was started with DEV_SIGNIN_ENABLED=yes
        on a local origin. The form is not a fallback: if the API refuses, it says
        so and stays shut. */}
    {status === 'signed-out' && <div className="dev-signin">
      {!devOpen && <>
        <button type="button" onClick={() => { setDevOpen(true); setDevMode('create'); }} disabled={busy !== null}>
          Create a test account (development only)
        </button>
        {/* Walking material up the chain means switching identities, so signing
            back in is a first-class action, not something to be discovered. */}
        <button type="button" onClick={() => { setDevOpen(true); setDevMode('sign-in'); }} disabled={busy !== null}>
          Sign in as a test account (development only)
        </button>
      </>}
      {devOpen && <form onSubmit={devSignIn}>
        <h2>{devMode === 'create' ? 'Create a test account' : 'Sign in as a test account'}</h2>
        <p>Development only. These accounts are disposable and use a reserved address domain. Never use them for real data.</p>
        <fieldset disabled={busy !== null}>
          {devMode === 'create' && <label>I am a
            {/* The five chain roles. Choosing one creates the account with that
                tier, so the screen the account lands on matches what was picked.
                Absent when signing in: that account already has its tier. */}
            <select value={devRole} onChange={event => { setDevRole(event.target.value); setDevMessage(''); }}>
              <option value="customer">Customer — I have scrap to sell</option>
              <option value="collector">Collector — I collect from customers</option>
              <option value="shop">Shop — I buy from collectors</option>
              <option value="mandi">Mandi — I buy from shops</option>
              <option value="recycler">Recycler — I buy from mandis</option>
            </select>
          </label>}
          <label>Email
            <input type="email" required autoComplete="off"
              placeholder={devMode === 'sign-in' ? 'shop1@example.test'
                : devRole === 'customer' ? 'customer1@example.test' : `${devRole}1@example.test`}
              value={devEmail} maxLength={80}
              onChange={event => { setDevEmail(event.target.value); setDevMessage(''); }} />
          </label>
          <label>Password
            <input type="password" required autoComplete={devMode === 'create' ? 'new-password' : 'current-password'}
              minLength={12} maxLength={200}
              value={devPassword}
              onChange={event => { setDevPassword(event.target.value); setDevMessage(''); }} />
          </label>
          <button type="submit">{busy === 'dev-signin'
            ? devMode === 'create' ? 'Creating…' : 'Signing in…'
            : devMode === 'create' ? 'Create and sign in' : 'Sign in'}</button>
          <button type="button" onClick={() => {
            // Switch action without losing the typed address, and clear the
            // message: the previous one described the other action.
            setDevMode(devMode === 'create' ? 'sign-in' : 'create'); setDevMessage('');
          }}>{devMode === 'create' ? 'I already have one' : 'Create a new one'}</button>
          <button type="button" onClick={() => { setDevOpen(false); setDevMessage(''); }}>Cancel</button>
        </fieldset>
        <p role="status" aria-live="polite">{devMessage}</p>
        {devAvailable === false && <p>Development sign-in is not enabled on this server.</p>}
      </form>}
    </div>}
    {status === 'signed-in' && <>
      <button type="button" onClick={signOut} disabled={busy !== null}>{busy === 'sign-out' ? 'Signing out…' : 'Sign out'}</button>
      {roles === null && <p className="auth-status">Loading your account…</p>}
      {roles !== null && roles.length === 0 && <p className="auth-status">
        This account has no roles yet, so there is nothing to show here. An administrator can grant a role.
      </p>}
      {roles?.includes('customer') && <div className="customer-setup">
        <p>Set up a customer account to prepare for future pickup requests.</p>
        <button type="button" onClick={setupCustomer} disabled={busy !== null}>{busy === 'customer-setup' ? 'Setting up…' : 'Set up customer account'}</button>
        <div role="status" aria-live="polite">{customerSetup === 'completed' && <p>Customer setup completed for this sign-in.</p>}</div>
        {customerSetup === 'completed' && !profileOpen && <button type="button" onClick={loadProfile} disabled={busy !== null}>{busy === 'profile-load' ? 'Loading…' : 'Open customer profile'}</button>}
        {profileOpen && <form className="customer-profile" onSubmit={saveProfile}>
          <h2>Customer details</h2>
          <p>For development testing only. Please use fictional details, not real personal information.</p>
          <fieldset disabled={busy !== null}>
            {([['name', 'Name', 100], ['addressLine', 'Pickup address', 200], ['city', 'City', 100], ['state', 'State', 100], ['postalCode', 'Postal code', 20]] as const).map(([key, label, limit]) =>
              <label key={key}>{label}<input name={key} value={details[key]} maxLength={limit} required autoComplete="off" onChange={event => { setDetails({ ...details, [key]: event.target.value }); setProfileMessage(''); }} /></label>)}
            <button type="submit">{busy === 'profile-save' ? 'Saving…' : 'Save customer details'}</button>
          </fieldset>
          <p role="status" aria-live="polite">{profileMessage}</p>
        </form>}
        {customerSetup === 'completed' && <TestPickups />}
      </div>}
      {/* A collector sees the open queue and their own claims. */}
      {busy !== 'sign-out' && roles?.includes('collector') && <CollectorQueue disabled={busy !== null} />}
      {/* Every tier that holds material shares one board: they hold the same
          capability, and the tier above each is the server's decision, not the
          panel's. A collector is in the chain too -- they sell to a shop.
          ONE board, at the HIGHEST tier the account holds: an account with two
          tiers used to render two identical boards from the same endpoint, each
          with its own Sell button. The highest tier is also the tier the API
          sells at, so the panel and the server agree on who this person is. */}
      {busy !== 'sign-out' && sellingTier(roles) !== null &&
        <LotBoard tier={sellingTier(roles)!} disabled={busy !== null} />}
      {/* Admin tools only for admins. The catalogue is read/write for admins and
          read-only for everyone else, so it stays visible to all signed-in
          accounts, as before. */}
      {busy !== 'sign-out' && <CatalogViewer disabled={busy !== null} />}
      {busy !== 'sign-out' && roles?.includes('admin') && <DisputeAdmin disabled={busy !== null} />}
      {busy !== 'sign-out' && roles?.includes('admin') && <PayoutAdmin disabled={busy !== null} />}
      {/* Everyone has an inbox; it is the only panel that is universal. */}
      {busy !== 'sign-out' && roles !== null && <NotificationInbox disabled={busy !== null} />}
    </>}
    {status === 'unavailable' && <div className="auth-unavailable">
      <button type="button" onClick={retrySession}>Try again</button>
      {/* Three different failures used to show one sentence, which told nobody
          anything. Each cause now says what it is and what to do. */}
      {sessionProblem?.kind === 'status' && sessionProblem.status === 404 &&
        <p role="status">The API does not recognise the session endpoint (404). The API process is probably running an older build: rebuild it and restart.</p>}
      {sessionProblem?.kind === 'status' && sessionProblem.status === 503 &&
        <p role="status">The API says sign-in is not configured (503). Start the API with <code>AUTH_ENABLED=true</code> and complete its configuration.</p>}
      {sessionProblem?.kind === 'status' && sessionProblem.status !== 404 && sessionProblem.status !== 503 &&
        <p role="status">The session endpoint answered HTTP {sessionProblem.status}.</p>}
      {sessionProblem?.kind === 'unreachable' &&
        <p role="status">The web app could not reach its API. Check that the API is running on port 4000 and that <code>API_INTERNAL_ORIGIN</code> points at it.</p>}
      {sessionProblem?.kind === 'malformed' &&
        <p role="status">The session endpoint answered with something unreadable. Check the API process output for an error.</p>}
      {sessionProblem === null && <p role="status">The session could not be read.</p>}
    </div>}
    <p className="auth-note">Development only. Sign-in and security are not ready for production.</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
  </div>;
}
