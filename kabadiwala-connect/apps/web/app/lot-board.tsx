'use client';
import { useCallback, useEffect, useState } from 'react';

// What this account is holding, and the one thing it can do with it: sell part
// or all of a lot one tier up. Every holding tier -- collector, shop, mandi and
// recycler -- uses this same board because they hold the same capability; which
// tier sits above them is the server's decision, not this component's.
type Lot = {
  id: string; material: string; grams: number; costPaise: string; status: 'held';
  createdAt: string; parentLotId: string | null; sourcePickupId: string | null;
};
type Sale = {
  id: string; lotId: string; grams: number; buyerTier: string | null;
  // Null when this account was not one of the two parties to the trade.
  pricePaise: string | null; buyerLotId: string | null; recordedAt: string;
  party: 'seller' | 'buyer' | 'observer';
};

// Paise are integers from the server; format without floating-point division.
function rupees(amountPaise: string): string {
  const value = BigInt(amountPaise);
  return `₹${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
// Grams are integers too: 2,300 g is 2.3 kg, never a rounded 2. String work, not
// division, so a weight can never drift through binary floating point.
function kilograms(grams: number): string {
  const whole = Math.trunc(grams / 1000);
  // Three places is a gram; trailing zeros are noise (2300 g is 2.3 kg, not 2.300).
  const rest = (grams % 1000).toString().padStart(3, '0').replace(/0+$/, '');
  return rest === '' ? `${whole} kg` : `${whole}.${rest} kg`;
}
const money = /^\d{1,16}$/;

export function LotBoard({ tier, disabled }: { tier: string; disabled: boolean }) {
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selling, setSelling] = useState<Lot | null>(null);
  const [grams, setGrams] = useState('');
  const [price, setPrice] = useState('');
  const [history, setHistory] = useState<{ lotId: string; sales: Sale[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/lots', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const json: unknown = await response.json();
      const data = (json as { data?: { lots?: unknown } })?.data;
      setLots(response.ok && Array.isArray(data?.lots) ? data.lots as Lot[] : []);
      if (!response.ok) setMessage('Your holdings could not be read.');
    } catch { setLots([]); setMessage('Your holdings could not be read.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The recycler has nothing above it, so the board says so instead of showing a
  // button that could only ever fail.
  const terminal = tier === 'recycler';

  async function openHistory(lot: Lot) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/lots/${lot.id}/history`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const json: unknown = await response.json();
      const sales = (json as { data?: { sales?: unknown } })?.data?.sales;
      if (response.ok && Array.isArray(sales)) setHistory({ lotId: lot.id, sales: sales as Sale[] });
      else setMessage('That lot\'s history could not be read.');
    } catch { setMessage('That lot\'s history could not be read.'); }
    finally { setBusy(false); }
  }

  async function sell(event: React.FormEvent) {
    event.preventDefault();
    if (!selling) return;
    const weight = Number(grams);
    // Validate locally only to avoid a pointless round trip. The server decides.
    if (!Number.isInteger(weight) || weight < 1 || weight > selling.grams) {
      setMessage(`Enter a whole number of grams from 1 to ${selling.grams}.`); return;
    }
    if (!money.test(price)) { setMessage('Enter the price in paise, as a whole number.'); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/v1/lots/sell', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lotId: selling.id, grams: weight, pricePaise: price }),
        signal: AbortSignal.timeout(10000) });
      const json: unknown = await response.json();
      const sold = (json as { data?: { sold?: boolean; grams?: number; buyerTier?: string } })?.data;
      if (response.ok && sold?.sold === true && Number.isInteger(sold.grams)) {
        setMessage(`Sold ${kilograms(sold.grams!)} to the ${sold.buyerTier} tier.`);
        setSelling(null); setGrams(''); setPrice('');
        await load();
      } else {
        const error = (json as { error?: { message?: string } })?.error;
        setMessage(error?.message ?? 'That sale was refused.');
      }
    } catch { setMessage('That sale could not be completed.'); }
    finally { setBusy(false); }
  }

  const blocked = disabled || busy;
  return (
    <section className="lot-board" aria-labelledby={`lots-${tier}`}>
      <h2 id={`lots-${tier}`}>Stock in your custody</h2>
      <p className="lot-note">
        {terminal
          ? 'A recycler is the end of the chain: material is processed here, not sold onward.'
          : `You can sell a lot upward one tier at a time. Who buys is decided by the platform.`}
      </p>
      {lots === null && <p className="auth-status">Loading your stock…</p>}
      {lots !== null && lots.length === 0 && <p className="auth-status">You are not holding any lots yet.</p>}
      {lots !== null && lots.length > 0 && <ul className="lot-list">
        {lots.map(lot => <li key={lot.id}>
          <div>
            <strong>{lot.material}</strong>
            <span>{kilograms(lot.grams)} · cost {rupees(lot.costPaise)}</span>
            {lot.parentLotId && <span className="lot-origin">received from an earlier sale</span>}
          </div>
          <div className="lot-actions">
            <button type="button" onClick={() => void openHistory(lot)} disabled={blocked}>History</button>
            {!terminal && <button type="button" disabled={blocked} onClick={() => {
              setSelling(lot); setGrams(String(lot.grams)); setPrice(lot.costPaise); setMessage(''); setHistory(null);
            }}>Sell</button>}
          </div>
        </li>)}
      </ul>}

      {selling && <form className="lot-sell" onSubmit={sell}>
        <h3>Sell {selling.material} upward</h3>
        <p>You hold {kilograms(selling.grams)}. Selling less keeps the rest in your custody.</p>
        <label>Weight in grams
          <input inputMode="numeric" value={grams} maxLength={8} required
            onChange={event => setGrams(event.target.value.replace(/\D/g, ''))} />
        </label>
        <label>Price in paise
          <input inputMode="numeric" value={price} maxLength={16} required
            onChange={event => setPrice(event.target.value.replace(/\D/g, ''))} />
        </label>
        <p className="lot-preview">{money.test(grams) && Number(grams) > 0 ? `${kilograms(Number(grams))} for ${money.test(price) ? rupees(price) : '—'}` : 'Enter a weight and a price.'}</p>
        <fieldset disabled={blocked}>
          <button type="submit">{busy ? 'Selling…' : 'Confirm sale'}</button>
          <button type="button" onClick={() => { setSelling(null); setMessage(''); }}>Cancel</button>
        </fieldset>
      </form>}

      {history && <div className="lot-history">
        <h3>Custody history</h3>
        {history.sales.length === 0 && <p className="auth-status">This lot has not changed hands yet.</p>}
        <ol>{history.sales.map(sale => <li key={sale.id}>
          <span>{kilograms(sale.grams)} to the {sale.buyerTier ?? 'terminal'} tier</span>
          <span>{new Date(sale.recordedAt).toLocaleDateString()}</span>
          {/* Another party's price is withheld by the server, not hidden here. */}
          <span>{sale.pricePaise === null ? 'price not shown' : rupees(sale.pricePaise)}
            {sale.party !== 'observer' && ` (you were the ${sale.party})`}</span>
        </li>)}</ol>
        <button type="button" onClick={() => setHistory(null)}>Close</button>
      </div>}

      <p role="status" aria-live="polite">{message}</p>
    </section>
  );
}
