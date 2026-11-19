'use client';
import { useState } from 'react';

type Pickup = {
  id:string; status:'requested'|'accepted'|'collected'|'cancelled'; createdAt:string; estimatedGrams:number;
  address:{name:string;addressLine:string;city:string;state:string;postalCode:string};
  material:string|null; categoryId:string|null; categoryName:string|null;
  rateId:string|null; paisePerKg:number|null; amountPaise:string|null;
  actualGrams:number|null; finalRateId:string|null; finalPaisePerKg:number|null;
  finalAmountPaise:string|null; collectedAt:string|null;
  cancelledAt:string|null; cancellationReason:string|null; releasedAt:string|null;
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
      const where = `${item.address.name}, ${item.address.addressLine}, ${item.address.city}, ${item.address.state}, ${item.address.postalCode}`;
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
        {canCancel && <><br /><button type="button" onClick={() => cancel(item)} disabled={busy}>Cancel this request</button></>}
      </li>;
    })}</ul>}</div>}
  </section>;
}
