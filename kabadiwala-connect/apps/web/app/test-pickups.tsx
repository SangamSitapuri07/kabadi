'use client';
import { useState } from 'react';

type Pickup = { id:string; material:string; estimatedGrams:number; status:'requested'; createdAt:string; address:{name:string;addressLine:string;city:string;state:string;postalCode:string} };
export function TestPickups() {
  const [material, setMaterial] = useState('');
  const [grams, setGrams] = useState('');
  const [items, setItems] = useState<Pickup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{requestKey:string; material:string; estimatedGrams:number} | null>(null);
  async function list() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/v1/customer/pickups', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      if (!response.ok || !Array.isArray(json?.data?.pickups)) throw Error('unavailable');
      setItems(json.data.pickups);
    } catch { setItems(null); setMessage('Test requests could not be loaded. Please try again.'); }
    finally { setBusy(false); }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(grams);
    if (!pending && (!material.trim() || Array.from(material.trim()).length > 100 || !Number.isInteger(amount) || amount < 1 || amount > 10000000)) { setMessage('Enter a material and a whole number of grams between 1 and 10000000.'); return; }
    const request = pending ?? {requestKey:crypto.randomUUID(), material:material.trim(), estimatedGrams:amount};
    setPending(request); setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/v1/customer/pickups', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(request), signal:AbortSignal.timeout(10000)});
      const json = await response.json();
      if (response.status === 409 && json?.error?.code === 'PROFILE_REQUIRED') { setPending(null); setMessage('Save customer details before creating a test request.'); return; }
      if (response.status === 409 && json?.error?.code === 'REQUEST_CONFLICT') { setMessage('Request key conflict. Check the list before starting another request.'); return; }
      if (!response.ok || json?.data?.created !== true) throw Error('unavailable');
      setPending(null); setMaterial(''); setGrams(''); setItems(null);
      setMessage('Test request saved. No collector will be notified or dispatched.');
    } catch { setMessage('Save could not be confirmed. Retry the same request, or check the list before starting another.'); }
    finally { setBusy(false); }
  }
  return <section className="customer-profile">
    <h2>Test pickup requests</h2>
    <p>Development only: use fictional details. This is not a real booking; scheduling, rates, cancellation and collector dispatch are not available.</p>
    <p>The saved customer address is copied when the request is created. Save any address changes first. If a save is interrupted and you refresh or leave this tab, check your test requests before creating another to avoid duplicates.</p>
    <form onSubmit={submit}><fieldset disabled={busy || pending !== null}>
      <label>Material description<input required maxLength={100} value={material} onChange={e => setMaterial(e.target.value)} /></label>
      <label>Estimated weight in grams<input required type="number" min="1" max="10000000" step="1" value={grams} onChange={e => setGrams(e.target.value)} /></label>
    </fieldset><button type="submit" disabled={busy}>{pending ? 'Retry same test request' : 'Save test request'}</button></form>
    <p role="status">{message}</p>
    <button type="button" onClick={list} disabled={busy}>Load my test requests</button>
    {items !== null && <div><p>Most recent 50 requests:</p>{items.length === 0 ? <p>No test requests found.</p> : <ul>{items.map(item => <li key={item.id}><strong>{item.material}</strong> — {item.estimatedGrams} g — {item.status}<br />Saved {new Date(item.createdAt).toLocaleString()}<br />{item.address.name}, {item.address.addressLine}, {item.address.city}, {item.address.state}, {item.address.postalCode}</li>)}</ul>}</div>}
  </section>;
}
