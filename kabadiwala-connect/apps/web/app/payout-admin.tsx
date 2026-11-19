'use client';
import { useState } from 'react';

// Mirrors the admin payout bridge. Amounts are decimal strings so that no
// floating-point rupee arithmetic happens in the browser.
type Due = {
  id:string; categoryName:string; estimatedGrams:number; actualGrams:number;
  finalPaisePerKg:number; amountPaise:string; collectedAt:string;
  address:{name:string;addressLine:string;city:string;state:string;postalCode:string};
};
// The server owns this list; the fallback only keeps the control usable if an
// older API answers without it. Sending an unknown value is refused upstream.
const FALLBACK_METHODS = ['cash','transfer','adjustment'] as const;
type Method = typeof FALLBACK_METHODS[number];
// What the API reports about the payment rail. There is no provider yet, and the
// screen says so rather than leaving an admin to assume a transfer happened.
type Payment = { configured: boolean; name: string | null; methods: readonly string[] };
const methodLabel = (method: string) =>
  method === 'cash' ? 'Cash' : method === 'transfer' ? 'Bank transfer' : method === 'adjustment' ? 'Adjustment' : method;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function rupees(amountPaise: string): string {
  const value = BigInt(amountPaise);
  return `₹${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

// Recording a payout is bookkeeping, not a transfer: nothing is sent to a bank,
// a wallet or a payment provider from here. An admin states that a collector was
// paid, how, and with what evidence. The amount is whatever the settlement says.
//
// PLACEHOLDER: the payment mechanism is not decided. This component must keep
// saying so (see the banner it renders) until a provider is actually wired up.
export function PayoutAdmin({ disabled }: { disabled: boolean }) {
  const [items, setItems] = useState<Due[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [payment, setPayment] = useState<Payment | null>(null);
  const [methods, setMethods] = useState<Record<string,Method>>({});
  const [references, setReferences] = useState<Record<string,string>>({});

  // `after` carries the confirmation through the reload that follows a payment.
  async function load(after = '') {
    setBusy(true); setMessage(after);
    try {
      const response = await fetch('/api/v1/admin/payouts', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      if (response.status === 403) { setItems(null); setMessage('This account does not have admin access.'); return; }
      if (response.status === 503 && json?.error?.code === 'PICKUP_SCHEMA_OUTDATED') {
        setItems(null); setMessage('The pickup database is behind this build. Run the pickup migration, then reload.'); return;
      }
      if (!response.ok || !Array.isArray(json?.data?.dues)) throw Error('unavailable');
      // A missing or malformed payment block is treated as "no provider", which
      // is the safe assumption: never claim money moved when it did not.
      const reported = json.data.payment;
      const methods = Array.isArray(reported?.methods) && reported.methods.length &&
        reported.methods.every((m: unknown) => typeof m === 'string' && (FALLBACK_METHODS as readonly string[]).includes(m))
        ? reported.methods as Method[] : [...FALLBACK_METHODS];
      setPayment({ configured: reported?.configured === true, name: typeof reported?.name === 'string' ? reported.name : null, methods });
      const parsed = json.data.dues.map((v: unknown) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const d = v as Record<string, unknown>;
        // A row without an amount is not payable, so it is dropped rather than
        // shown with a blank where the money should be.
        if (!uuid.test(String(d.id ?? '')) || typeof d.amountPaise !== 'string' ||
            !/^\d{1,16}$/.test(d.amountPaise) || !Number.isInteger(d.actualGrams) ||
            !Number.isInteger(d.finalPaisePerKg) || typeof d.collectedAt !== 'string') return null;
        return d as unknown as Due;
      });
      if (parsed.some((p: Due | null) => p === null)) throw Error('invalid');
      setItems(parsed as Due[]);
      if (after) setMessage(after);
    } catch { setItems(null); setMessage('The payout queue could not be loaded. Please try again.'); }
    finally { setBusy(false); }
  }

  async function pay(item: Due) {
    const method: Method = methods[item.id] ?? 'cash';
    const reference = (references[item.id] ?? '').trim();
    // The amount is restated in full because this is a record of money handed
    // over, and the admin should be confirming a number they can see.
    const detail = reference ? ` Reference: ${reference}.` : '';
    if (!confirm(`Record that this collector was paid ${rupees(item.amountPaise)} by ${method}? This records the payment; it does not send any money.${detail}`)) return;
    // No amount is sent: the server pays exactly what the settlement recorded.
    const payload: Record<string, unknown> = { method };
    if (reference) payload.reference = reference;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/admin/payouts/${item.id}/pay`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(10000),
      });
      const json = await response.json();
      const code = json?.error?.code;
      if (response.status === 200 && json?.data?.paid === true) {
        setReferences(r => ({ ...r, [item.id]: '' }));
        await load(`Payout recorded: ${rupees(json.data.amountPaise)} by ${json.data.method}. No money was moved by this application.`);
        return;
      }
      if (response.status === 409 && code === 'ALREADY_PAID') { await load('That payout was already recorded. Nothing was changed.'); return; }
      if (response.status === 409 && code === 'DISPUTE_OPEN') { setMessage('An open dispute must be resolved before this amount can be paid.'); return; }
      if (response.status === 409 && code === 'NOT_COLLECTED') { setMessage('That request has not been collected, so nothing is owed yet.'); return; }
      if (response.status === 403) { setMessage('This account does not have admin access.'); return; }
      if (response.status === 401) { setMessage('Your sign-in could not be confirmed.'); return; }
      if (response.status === 404) { setMessage('That request no longer exists. Refresh the queue.'); return; }
      throw Error('unavailable');
    } catch { setMessage('The payout could not be confirmed. Check the queue before trying again.'); }
    finally { setBusy(false); }
  }

  return <section className="payout-admin">
    <h2>Collector payouts due</h2>
    <p>Development only. Recording a payout does not transfer money: it records that a collector was paid, by what method, and on whose authority. The amount is the frozen settlement from collection time, or the corrected amount if a dispute was resolved.</p>
    {/* PLACEHOLDER: the payment rail is undecided. This banner is the honest
        state of the system, and it must be replaced when a provider is wired up
        -- not merely hidden. */}
    <p className="payout-placeholder"><strong>Payment method not implemented yet.</strong>{' '}
      {payment === null ? 'This build records payouts by hand and moves no money.'
        : payment.configured && payment.name ? `Connected provider: ${payment.name}.`
        : 'No payment provider is connected. Every payout below is a manual record; nothing is sent to a bank, a wallet or a provider.'}</p>
    <button type="button" onClick={() => load()} disabled={disabled || busy}>Load unpaid dues</button>
    <p role="status" aria-live="polite">{message}</p>
    {items !== null && <div>
      {items.length === 0 ? <p>No unpaid dues.</p> : <ul>{items.map(item => {
        const where = `${item.address.name}, ${item.address.addressLine}, ${item.address.city}, ${item.address.state}, ${item.address.postalCode}`;
        return <li key={item.id}>
          <span>{item.categoryName} — {item.actualGrams} g at {rupees(String(item.finalPaisePerKg))}/kg</span>
          <br /><span>Amount due: {rupees(item.amountPaise)}</span>
          <br /><span>{where}</span>
          <br /><span>Collected {new Date(item.collectedAt).toLocaleString()}{item.estimatedGrams ? ` · customer estimated ${item.estimatedGrams} g` : ''}</span>
          <div>
            <label>Paid by
              <select value={methods[item.id] ?? 'cash'} onChange={e => setMethods(m => ({ ...m, [item.id]: e.target.value as Method }))}>
                {(payment?.methods ?? FALLBACK_METHODS).map(method =>
                  <option key={method} value={method}>{methodLabel(method)}</option>)}
              </select>
            </label>
            <label>Reference (optional)
              <input type="text" maxLength={100} value={references[item.id] ?? ''} autoComplete="off"
                onChange={e => setReferences(r => ({ ...r, [item.id]: e.target.value }))} />
            </label>
            <button type="button" onClick={() => pay(item)} disabled={disabled || busy}>Record this payout</button>
          </div>
        </li>;
      })}</ul>}
    </div>}
  </section>;
}
