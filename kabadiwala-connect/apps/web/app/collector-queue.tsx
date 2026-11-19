'use client';
import { useState } from 'react';

// Mirrors the collector bridge contract. Amounts are decimal strings so no
// floating-point rupee conversion happens in the browser.
type CollectorPickup = {
  id:string; status:'requested'|'accepted'|'collected'|'cancelled'; createdAt:string; estimatedGrams:number;
  address:{name:string;addressLine:string;city:string;state:string;postalCode:string};
  categoryId:string; categoryName:string; rateId:string; paisePerKg:number; amountPaise:string;
  actualGrams:number|null; finalRateId:string|null; finalPaisePerKg:number|null;
  finalAmountPaise:string|null; collectedAt:string|null;
  cancelledAt:string|null; cancellationReason:string|null; releasedAt:string|null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rupees(amountPaise: string): string {
  const value = BigInt(amountPaise);
  const whole = value / 100n, fraction = value % 100n;
  return `₹${whole}.${fraction.toString().padStart(2, '0')}`;
}

function parse(value: unknown): CollectorPickup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!uuid.test(String(v.id ?? '')) || !['requested','accepted','collected','cancelled'].includes(String(v.status)) ||
      typeof v.createdAt !== 'string' || !Number.isInteger(v.estimatedGrams) ||
      !uuid.test(String(v.categoryId ?? '')) || !uuid.test(String(v.rateId ?? '')) ||
      typeof v.categoryName !== 'string' || !Number.isInteger(v.paisePerKg) ||
      typeof v.amountPaise !== 'string' || !/^\d{1,16}$/.test(v.amountPaise) ||
      !v.address || typeof v.address !== 'object') return null;
  const address = v.address as Record<string, unknown>;
  const fields = ['name','addressLine','city','state','postalCode'] as const;
  if (fields.some(f => typeof address[f] !== 'string' || !(address[f] as string).trim())) return null;
  if (v.status === 'collected') {
    if (!Number.isInteger(v.actualGrams) || !uuid.test(String(v.finalRateId ?? '')) ||
        !Number.isInteger(v.finalPaisePerKg) || typeof v.finalAmountPaise !== 'string' ||
        !/^\d{1,16}$/.test(v.finalAmountPaise) || typeof v.collectedAt !== 'string') return null;
  }
  return {
    id: v.id as string, status: v.status as CollectorPickup['status'], createdAt: v.createdAt,
    estimatedGrams: v.estimatedGrams as number,
    address: { name: address.name as string, addressLine: address.addressLine as string, city: address.city as string,
      state: address.state as string, postalCode: address.postalCode as string },
    categoryId: v.categoryId as string, categoryName: v.categoryName as string, rateId: v.rateId as string,
    paisePerKg: v.paisePerKg as number, amountPaise: v.amountPaise as string,
    actualGrams: (v.actualGrams as number | null) ?? null, finalRateId: (v.finalRateId as string | null) ?? null,
    finalPaisePerKg: (v.finalPaisePerKg as number | null) ?? null,
    finalAmountPaise: (v.finalAmountPaise as string | null) ?? null,
    collectedAt: (v.collectedAt as string | null) ?? null,
    cancelledAt: (v.cancelledAt as string | null) ?? null,
    cancellationReason: (v.cancellationReason as string | null) ?? null,
    releasedAt: (v.releasedAt as string | null) ?? null,
  };
}

// A collector only sees their own queue; the collector grant is checked by the
// API, so this panel simply reports what the API decided.
export function CollectorQueue({ disabled }: { disabled: boolean }) {
  const [items, setItems] = useState<CollectorPickup[] | null>(null);
  const [view, setView] = useState<'open'|'mine'>('open');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [grams, setGrams] = useState<Record<string,string>>({});

  // `after` carries a confirmation through the reload so accepting a request is
  // not silently followed by an empty status line.
  async function load(next: 'open'|'mine', after = '') {
    setBusy(true); setMessage(after); setView(next);
    try {
      const response = await fetch(`/api/v1/collector/pickups?view=${next}`, { cache:'no-store', signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      if (response.status === 403) { setItems(null); setMessage('This account does not have collector access.'); return; }
      if (response.status === 503 && json?.error?.code === 'PICKUP_SCHEMA_OUTDATED') {
        setItems(null); setMessage('The pickup database is behind this build. Run the pickup migration, then reload.'); return;
      }
      if (!response.ok || !Array.isArray(json?.data?.pickups)) throw Error('unavailable');
      const parsed = json.data.pickups.map(parse);
      if (parsed.some((p: CollectorPickup | null) => p === null)) throw Error('invalid');
      setItems(parsed as CollectorPickup[]);
      if (after) setMessage(after);
    } catch { setItems(null); setMessage('The collector queue could not be loaded. Please try again.'); }
    finally { setBusy(false); }
  }

  async function act(id: string, action: 'accept'|'collect'|'release') {
    if (action === 'release' && !confirm('Release this request back to the open queue? It stops being yours and another collector can take it.')) return;
    const payload = action === 'collect' ? { actualGrams: Number(grams[id]) } : {};
    if (action === 'collect') {
      const value = Number(grams[id]);
      if (!Number.isInteger(value) || value < 1 || value > 10000000) {
        setMessage('Enter the measured weight in whole grams between 1 and 10000000.'); return;
      }
      if (!confirm(`Record ${value} g collected? The final amount is calculated at the rate in force now and cannot be edited.`)) return;
    }
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/collector/pickups/${id}/${action}`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(10000),
      });
      const json = await response.json();
      const code = json?.error?.code;
      if (response.status === 200 && action === 'release') {
        await load('open', 'Request released. It is back in the open queue for any collector.'); return;
      }
      if (response.status === 200 && action === 'accept') {
        await load('mine', 'Request accepted. Record the weight when you collect it.'); return;
      }
      if (response.status === 200 && json?.data?.collected === true) {
        setGrams(g => ({ ...g, [id]: '' }));
        await load('mine', `Collected ${json.data.actualGrams} g. Final amount ${rupees(json.data.finalAmountPaise)} at ${rupees(String(json.data.finalPaisePerKg))}/kg.`);
        return;
      }
      if (response.status === 409 && code === 'ALREADY_ACCEPTED') { setMessage('Another collector already accepted this request. Refresh the open queue.'); return; }
      if (response.status === 409 && code === 'ALREADY_COLLECTED') { setMessage('This request was already collected. No second amount was recorded.'); return; }
      if (response.status === 409 && code === 'NOT_ACCEPTED') { setMessage('Accept the request before recording a collection.'); return; }
      if (response.status === 409 && code === 'NO_RATE') { setMessage('No rate is in force for this category, so it cannot be settled.'); return; }
      if (response.status === 409 && code === 'LEGACY_REQUEST') { setMessage('Older free-text requests cannot be priced.'); return; }
      if (response.status === 409 && code === 'OWN_REQUEST') { setMessage('You cannot accept your own request; another collector has to take it.'); return; }
      if (response.status === 409 && code === 'REQUEST_CANCELLED') { setMessage('The customer cancelled this request. Nothing more to do.'); return; }
      if (response.status === 409 && code === 'NOT_YOUR_CLAIM') { setMessage('Another collector now holds this request. Refresh your queue.'); return; }
      if (response.status === 403) { setMessage('This account does not have collector access.'); return; }
      if (response.status === 401) { setMessage('Your sign-in could not be confirmed.'); return; }
      if (response.status === 404) { setMessage('That request no longer exists. Refresh the queue.'); return; }
      if (response.status === 503 && code === 'PICKUP_SCHEMA_OUTDATED') { setMessage('The pickup database is behind this build. Run the pickup migration, then reload.'); return; }
      throw Error('unavailable');
    } catch { setMessage('The action could not be confirmed. Check the queue before trying again.'); }
    finally { setBusy(false); }
  }

  // Cancelled claims are not work for this collector any more; they are shown
  // only so a request does not vanish without explanation.
  const shown = items === null ? null : items.filter(p => view === 'open'
    ? p.status === 'requested'
    : p.status === 'accepted' || p.status === 'collected' || p.status === 'cancelled');

  return <section className="collector-queue">
    <h2>Collector queue</h2>
    <p>Development only. Accepting claims the request for your account. Recording a collection fixes the final amount at the rate in force at that moment.</p>
    <div className="collector-actions">
      <button type="button" onClick={() => load('open')} disabled={disabled || busy}>Open requests</button>
      <button type="button" onClick={() => load('mine')} disabled={disabled || busy}>My accepted and collected</button>
    </div>
    <p role="status" aria-live="polite">{message}</p>
    {shown !== null && <div>
      <p>{view === 'open' ? 'Unclaimed requests, oldest first:' : 'Your most recent 50 requests:'}</p>
      {shown.length === 0 ? <p>{view === 'open' ? 'No open requests right now.' : 'No accepted or collected requests yet.'}</p> : <ul className="collector-list">{shown.map(item => {
        const where = `${item.address.name}, ${item.address.addressLine}, ${item.address.city}, ${item.address.state}, ${item.address.postalCode}`;
        return <li key={item.id}>
          <span>{item.categoryName} — {item.estimatedGrams} g — estimate {rupees(item.amountPaise)} at {rupees(String(item.paisePerKg))}/kg</span>
          <br /><span>{where}</span>
          <br /><span>{item.status} · saved {new Date(item.createdAt).toLocaleString()}</span>
          {item.status === 'requested' && <div>
            <button type="button" onClick={() => act(item.id, 'accept')} disabled={disabled || busy}>Accept this request</button>
          </div>}
          {item.status === 'accepted' && <div>
            <button type="button" onClick={() => act(item.id, 'release')} disabled={disabled || busy}>Release this request</button>
            <label>Actual weight in grams
              <input type="number" min="1" max="10000000" step="1" value={grams[item.id] ?? ''} autoComplete="off"
                onChange={e => setGrams(g => ({ ...g, [item.id]: e.target.value }))} />
            </label>
            <button type="button" onClick={() => act(item.id, 'collect')} disabled={disabled || busy}>Record collection</button>
          </div>}
          {item.status === 'collected' && item.finalAmountPaise !== null && item.finalPaisePerKg !== null && item.actualGrams !== null && <span>
            Final: {item.actualGrams} g at {rupees(String(item.finalPaisePerKg))}/kg = {rupees(item.finalAmountPaise)}
            {item.collectedAt ? ` · collected ${new Date(item.collectedAt).toLocaleString()}` : ''}
          </span>}
        </li>;
      })}</ul>}
    </div>}
  </section>;
}
