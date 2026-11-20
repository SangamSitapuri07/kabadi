'use client';
import { useEffect, useState } from 'react';

type Pickup = {
  id:string; status:'requested'|'accepted'|'collected'|'cancelled'; createdAt:string; estimatedGrams:number;
  // Null once retention has erased it; the money and timestamps stay.
  address:{name:string;addressLine:string;city:string;state:string;postalCode:string} | null;
  addressRedactedAt: string | null;
  material:string|null; categoryId:string|null; categoryName:string|null;
  rateId:string|null; paisePerKg:number|null; amountPaise:string|null;
  actualGrams:number|null; finalRateId:string|null; finalPaisePerKg:number|null;
  finalAmountPaise:string|null; collectedAt:string|null;
  cancelledAt:string|null; cancellationReason:string|null; releasedAt:string|null;
  dispute:{ status:'open'|'resolved'|'rejected'; raisedAt:string; reason:string; resolvedAt:string|null }|null;
  // A receipt only: how the collector was paid stays internal.
  payout:{ amountPaise:string; paidAt:string }|null;
};
type Estimate = { categoryId:string; categoryName:string; rateId:string; paisePerKg:number; amountPaise:string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Paise are integers from the server; format without floating-point division.
function rupees(amountPaise: string): string {
  const value = BigInt(amountPaise);
  const whole = value / 100n, fraction = value % 100n;
  return `₹${whole}.${fraction.toString().padStart(2, '0')}`;
}

export function TestPickups() {
  const [categoryId, setCategoryId] = useState('');
  const [grams, setGrams] = useState('');
  const [items, setItems] = useState<Pickup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [pending, setPending] = useState<{requestKey:string; categoryId:string; estimatedGrams:number} | null>(null);
  // What the server said about delivery. The two facts are kept apart on purpose:
  // in-app works, external channels do not exist.
  const [delivery, setDelivery] = useState<{inApp:boolean; external:string[]} | null>(null);

  // The delivery fact is fetched on mount, not on the first click: the customer
  // should know whether anything will reach them before they request a pickup.
  useEffect(() => { void readDelivery(); }, []);
  async function readDelivery() {
    try {
      const response = await fetch('/api/v1/customer/pickups', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      if (!response.ok) return;
      const json = await response.json();
      const n = json?.data?.notifications;
      setDelivery(n && n.configured === true && n.inApp === true && Array.isArray(n.external) && n.external.length === 0
        ? { inApp:true, external:[] } : null);
    } catch { /* the notice already says to check this page; nothing to add */ }
  }

  async function list() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/v1/customer/pickups', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      if (response.status === 503 && json?.error?.code === 'PICKUP_SCHEMA_OUTDATED') {
        setItems(null); setMessage('The pickup database is behind this build. Run the pickup migration, then reload.'); return;
      }
      if (!response.ok || !Array.isArray(json?.data?.pickups)) throw Error('unavailable');
      setItems(json.data.pickups);
      // Only a recognised report is trusted. Anything unexpected falls back to
      // claiming neither in-app nor external delivery, never to a comforting one.
      const n = json.data.notifications;
      setDelivery(n && n.configured === true && n.inApp === true && Array.isArray(n.external) && n.external.length === 0
        ? { inApp:true, external:[] } : null);
    } catch { setItems(null); setMessage('Test requests could not be loaded. Please try again.'); }
    finally { setBusy(false); }
  }

  // Cancelling is the customer's own call and is terminal. A collected request
  // cannot be cancelled, so the button is not offered once it is settled.
  async function cancel(item: Pickup) {
    if (!confirm('Cancel this request? A collected request cannot be cancelled, and this cannot be undone.')) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/customer/pickups/${item.id}/cancel`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:'{}', signal:AbortSignal.timeout(10000),
      });
      const json = await response.json();
      const code = json?.error?.code;
      if (response.status === 200 && json?.data?.cancelled === true) {
        setMessage(item.status === 'accepted'
          ? 'Request cancelled. A collector had accepted it, so it no longer appears in their queue.'
          : 'Request cancelled.');
        await list(); return;
      }
      if (response.status === 409 && code === 'ALREADY_COLLECTED') { setMessage('This request was already collected, so it cannot be cancelled.'); return; }
      if (response.status === 409 && code === 'ALREADY_CANCELLED') { setMessage('This request is already cancelled.'); return; }
      if (response.status === 404) { setMessage('That request no longer exists. Reload your list.'); return; }
      if (response.status === 401 || response.status === 403) { setMessage('Your sign-in or customer access could not be confirmed.'); return; }
      throw Error('unavailable');
    } catch { setMessage('The cancellation could not be confirmed. Check the list before trying again.'); }
    finally { setBusy(false); }
  }

  // A dispute is a request for review, not an edit: the amount stays exactly as
  // recorded until an admin decides, so both sides are looking at the same figure.
  async function dispute(item: Pickup) {
    const reason = prompt('What is wrong with this amount? (1 to 200 characters)')?.trim();
    if (!reason) return;
    if (Array.from(reason).length > 200) { setMessage('Keep the reason under 200 characters.'); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/customer/pickups/${item.id}/dispute`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ reason }), signal:AbortSignal.timeout(10000),
      });
      const json = await response.json();
      const code = json?.error?.code;
      if (response.status === 200 && json?.data?.raised === true) {
        setMessage('Dispute raised. The amount stays visible while an admin reviews it.');
        await list(); return;
      }
      if (response.status === 409 && code === 'DISPUTE_OPEN') { setMessage('A dispute is already open for this request.'); return; }
      if (response.status === 409 && code === 'NOT_COLLECTED') { setMessage('Only a collected request can be disputed.'); return; }
      if (response.status === 404) { setMessage('That request no longer exists. Reload your list.'); return; }
      if (response.status === 401 || response.status === 403) { setMessage('Your sign-in or customer access could not be confirmed.'); return; }
      throw Error('unavailable');
    } catch { setMessage('The dispute could not be confirmed. Check the list before trying again.'); }
    finally { setBusy(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(grams);
    if (!pending && (!uuid.test(categoryId) || !Number.isInteger(amount) || amount < 1 || amount > 10000000)) {
      setMessage('Choose a category and enter a whole number of grams between 1 and 10000000.'); return;
    }
    const request = pending ?? { requestKey:crypto.randomUUID(), categoryId, estimatedGrams:amount };
    setPending(request); setBusy(true); setMessage(''); setEstimate(null);
    try {
      const response = await fetch('/api/v1/customer/pickups', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request), signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      const code = json?.error?.code;
      if (response.status === 409 && code === 'PROFILE_REQUIRED') { setPending(null); setMessage('Save customer details before creating a test request.'); return; }
      if (response.status === 409 && code === 'REQUEST_CONFLICT') { setPending(null); setMessage('Request key conflict. Check the list before starting another request.'); return; }
      if (response.status === 409 && code === 'UNKNOWN_CATEGORY') { setPending(null); setMessage('That category is no longer available. Enter the category ID again.'); setCategoryId(''); return; }
      if (response.status === 409 && code === 'NO_RATE') { setPending(null); setMessage('No rate is active for that category yet, so no estimate can be made.'); return; }
      if (response.status === 401 || response.status === 403) { setPending(null); setMessage('Your sign-in or customer access could not be confirmed.'); return; }
      if (!response.ok || typeof json?.data?.created !== 'boolean' || !json.data.estimate) throw Error('unavailable');
      const saved: Estimate = json.data.estimate;
      // Amounts must arrive as decimal strings; a JSON number would lose
      // precision or hide a server bug, so it is rejected rather than coerced.
      if (!uuid.test(saved.categoryId) || !uuid.test(saved.rateId) ||
          typeof saved.amountPaise !== 'string' || !/^\d{1,16}$/.test(saved.amountPaise) ||
          !Number.isInteger(saved.paisePerKg) || saved.paisePerKg < 0 || saved.paisePerKg > 1000000000) throw Error('invalid');
      setPending(null); setGrams('');
      setEstimate(saved);
      setItems(null);
      setMessage('Test request saved. This estimate is not a final price and no collector will be notified.');
    } catch {
      setMessage('Save could not be confirmed. Retry the same request, or check the list before starting another.');
    } finally { setBusy(false); }
  }

  // Category IDs are entered directly because there is no public category
  // listing yet; the admin view above shows them for development use.
  return <section className="customer-profile">
    <h2>Test pickup requests</h2>
    <p>Development only: use fictional details. This is not a real booking — no scheduling, collector dispatch, cancellation or payment exists.</p>
    <p>The saved customer address is copied when the request is created. Save any address changes first. If a save is interrupted and you refresh or leave this tab, check your test requests before creating another.</p>
    <p>The price is an <strong>estimate</strong>: the server picks the rate active at request time and stores it with the request. Weight is confirmed by a collector later, and the final amount will use the collection-time rate.</p>
    <form onSubmit={submit}><fieldset disabled={busy || pending !== null}>
      <label>Scrap category ID<input required value={categoryId} autoComplete="off" placeholder="Paste the category ID from the test catalog" onChange={e => setCategoryId(e.target.value.trim())} /></label>
      <label>Estimated weight in grams<input required type="number" min="1" max="10000000" step="1" value={grams} onChange={e => setGrams(e.target.value)} /></label>
    </fieldset><button type="submit" disabled={busy}>{pending ? 'Retry same test request' : 'Save test request'}</button></form>
    <p role="status">{message}</p>
    {/* NOTIFICATIONS: deferred. This notice must be removed only when a real
        channel exists and the server reports configured:true -- not before. */}
    {/* In-app exists; external delivery does not. Say both, always. */}
    <p className="notifications-placeholder">
      {/* Only an explicit in-app report earns the promise; anything else, and
          the "not loaded yet" state, falls back to telling the customer to look. */}
      <strong>{delivery?.inApp === true ? 'Updates appear in this app only.' : 'Check this page for the current status.'}</strong>{' '}
      {delivery?.inApp
        ? 'When your request is accepted, collected, corrected or paid you will get an in-app notification. '
        : ''}
      There is no email, SMS or WhatsApp message, so nothing reaches you while you are signed out.
    </p>
    {estimate && <p className="estimate" role="status">
      Estimated {rupees(estimate.amountPaise)} for {estimate.categoryName} at {rupees(String(estimate.paisePerKg))} per kg. Rate reference {estimate.rateId.slice(0, 8)}… included in the request.
    </p>}
    <button type="button" onClick={list} disabled={busy}>Load my test requests</button>
    {items !== null && <div><p>Most recent 50 requests:</p>{items.length === 0 ? <p>No test requests found.</p> : <ul>{items.map(item => {
      const priced = item.categoryName !== null && item.amountPaise !== null && item.paisePerKg !== null;
      const summary = priced
        ? `${item.categoryName} — ${item.estimatedGrams} g — estimated ${rupees(item.amountPaise!)} at ${rupees(String(item.paisePerKg))}/kg`
        : `${item.material} — ${item.estimatedGrams} g — no estimate (older request)`;
      const saved = `${item.status} · saved ${new Date(item.createdAt).toLocaleString()}`;
      const where = item.address
        ? `${item.address.name}, ${item.address.addressLine}, ${item.address.city}, ${item.address.state}, ${item.address.postalCode}`
        : 'Address removed after the retention period; the amount is unchanged.';
      // Once collected, the measured weight and the rate in force at collection
      // are the final amount. Until then the only figure on screen is an estimate.
      const final = item.status === 'collected' && item.finalAmountPaise !== null &&
        item.finalPaisePerKg !== null && item.actualGrams !== null
        ? `Final amount ${rupees(item.finalAmountPaise)}: ${item.actualGrams} g at ${rupees(String(item.finalPaisePerKg))}/kg (collection-time rate).`
        : null;
      // Cancellation is explained in the row, not only in a status word.
      const cancelled = item.status === 'cancelled'
        ? `Cancelled${item.cancellationReason ? `: ${item.cancellationReason}` : ''}${item.cancelledAt ? ` · ${new Date(item.cancelledAt).toLocaleString()}` : ''}`
        : null;
      const canCancel = item.status === 'requested' || item.status === 'accepted';
      return <li key={item.id}>
        <span>{summary}</span>
        <br /><span>{saved}</span>
        <br /><span>{where}</span>
        {final && <><br /><strong>{final}</strong></>}
        {cancelled && <><br /><span>{cancelled}</span></>}
        {item.dispute && <><br /><span>Dispute {item.dispute.status}: {item.dispute.reason}</span></>}
        {item.payout && <><br /><span>Payment recorded: {rupees(item.payout.amountPaise)} on {new Date(item.payout.paidAt).toLocaleDateString()}</span></>}
        {canCancel && <><br /><button type="button" onClick={() => cancel(item)} disabled={busy}>Cancel this request</button></>}
        {item.status === 'collected' && (!item.dispute || item.dispute.status === 'rejected') &&
          <><br /><button type="button" onClick={() => dispute(item)} disabled={busy}>Dispute this amount</button></>}
      </li>;
    })}</ul>}</div>}
  </section>;
}
