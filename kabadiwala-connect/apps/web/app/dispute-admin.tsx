'use client';
import { useState } from 'react';

// Mirrors the admin dispute bridge. Every amount is a decimal string so no
// floating-point rupee arithmetic happens in the browser.
type Dispute = {
  id:string; categoryName:string; estimatedGrams:number; actualGrams:number;
  finalPaisePerKg:number; finalAmountPaise:string;
  address:{name:string;addressLine:string;city:string;state:string;postalCode:string};
  dispute:{ reason:string; raisedAt:string };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rupees(amountPaise: string): string {
  const value = BigInt(amountPaise);
  return `₹${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

// An admin resolves by accepting a corrected weight. The price is never supplied
// from here: the server re-prices at the rate frozen when the pickup happened.
export function DisputeAdmin({ disabled }: { disabled: boolean }) {
  const [items, setItems] = useState<Dispute[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [grams, setGrams] = useState<Record<string,string>>({});

  // `after` carries the confirmation through the reload that follows a decision.
  async function load(after = '') {
    setBusy(true); setMessage(after);
    try {
      const response = await fetch('/api/v1/admin/disputes', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      if (response.status === 403) { setItems(null); setMessage('This account does not have admin access.'); return; }
      if (response.status === 503 && json?.error?.code === 'PICKUP_SCHEMA_OUTDATED') {
        setItems(null); setMessage('The pickup database is behind this build. Run the pickup migration, then reload.'); return;
      }
      if (!response.ok || !Array.isArray(json?.data?.disputes)) throw Error('unavailable');
      const parsed = json.data.disputes.map((v: unknown) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const d = v as Record<string, unknown>;
        if (!uuid.test(String(d.id ?? '')) || !Number.isInteger(d.actualGrams) ||
            !Number.isInteger(d.finalPaisePerKg) || typeof d.finalAmountPaise !== 'string' ||
            !/^\d{1,16}$/.test(d.finalAmountPaise) || !d.dispute || typeof d.dispute !== 'object') return null;
        return d as unknown as Dispute;
      });
      if (parsed.some((p: Dispute | null) => p === null)) throw Error('invalid');
      setItems(parsed as Dispute[]);
      if (after) setMessage(after);
    } catch { setItems(null); setMessage('The dispute queue could not be loaded. Please try again.'); }
    finally { setBusy(false); }
  }

  async function act(id: string, action: 'resolve'|'reject') {
    let payload: Record<string, unknown> = {};
    if (action === 'resolve') {
      const value = Number(grams[id]);
      if (!Number.isInteger(value) || value < 1 || value > 10000000) {
        setMessage('Enter the corrected weight in whole grams between 1 and 10000000.'); return;
      }
      if (!confirm(`Correct the weight to ${value} g? The amount is recalculated at the rate frozen at collection time and this cannot be undone.`)) return;
      payload = { correctedGrams: value };
    } else if (!confirm('Reject this dispute? The original amount stays exactly as recorded.')) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/admin/disputes/${id}/${action}`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(10000),
      });
      const json = await response.json();
      const code = json?.error?.code;
      if (response.status === 200 && json?.data?.resolved === true) {
        setGrams(g => ({ ...g, [id]: '' }));
        await load(`Dispute resolved. Corrected ${json.data.actualGrams} g, final amount ${rupees(json.data.finalAmountPaise)} at ${rupees(String(json.data.finalPaisePerKg))}/kg.`);
        return;
      }
      if (response.status === 200 && json?.data?.rejected === true) {
        await load('Dispute rejected. The original amount is unchanged.'); return;
      }
      if (response.status === 409 && code === 'SAME_WEIGHT') { setMessage('That is the weight already recorded; nothing was changed.'); return; }
      if (response.status === 409 && code === 'NO_OPEN_DISPUTE') { setMessage('That dispute is no longer open. Refresh the queue.'); return; }
      if (response.status === 403) { setMessage('This account does not have admin access.'); return; }
      if (response.status === 401) { setMessage('Your sign-in could not be confirmed.'); return; }
      if (response.status === 404) { setMessage('That request no longer exists. Refresh the queue.'); return; }
      throw Error('unavailable');
    } catch { setMessage('The action could not be confirmed. Check the queue before trying again.'); }
    finally { setBusy(false); }
  }

  return <section className="dispute-admin">
    <h2>Disputed amounts</h2>
    <p>Development only. Resolving accepts a corrected weight and recalculates the amount at the rate that was frozen when the pickup was collected — not today&apos;s rate.</p>
    <button type="button" onClick={() => load()} disabled={disabled || busy}>Load open disputes</button>
    <p role="status" aria-live="polite">{message}</p>
    {items !== null && <div>
      {items.length === 0 ? <p>No open disputes.</p> : <ul>{items.map(item => {
        const where = `${item.address.name}, ${item.address.addressLine}, ${item.address.city}, ${item.address.state}, ${item.address.postalCode}`;
        return <li key={item.id}>
          <span>{item.categoryName} — recorded {item.actualGrams} g at {rupees(String(item.finalPaisePerKg))}/kg = {rupees(item.finalAmountPaise)}</span>
          <br /><span>Customer estimate was {item.estimatedGrams} g</span>
          <br /><span>{where}</span>
          <br /><span>Customer says: {item.dispute.reason} · raised {new Date(item.dispute.raisedAt).toLocaleString()}</span>
          <div>
            <label>Corrected weight in grams
              <input type="number" min="1" max="10000000" step="1" value={grams[item.id] ?? ''} autoComplete="off"
                onChange={e => setGrams(g => ({ ...g, [item.id]: e.target.value }))} />
            </label>
            <button type="button" onClick={() => act(item.id, 'resolve')} disabled={disabled || busy}>Correct the weight</button>
            <button type="button" onClick={() => act(item.id, 'reject')} disabled={disabled || busy}>Reject the dispute</button>
          </div>
        </li>;
      })}</ul>}
    </div>}
  </section>;
}
