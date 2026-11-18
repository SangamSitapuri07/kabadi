'use client';
import { useEffect, useRef, useState } from 'react';

// Development-only admin catalog writer. The API authorizes every write; the
// form is not itself a permission check. Retry keys are held only in memory and
// are reused only after an uncertain result with identical input, because the
// API replays a committed success for the same key and payload.
type Pending = { kind: 'category'; key: string; name: string } | { kind: 'rate'; key: string; categoryId: string; effectiveFrom: string; paisePerKg: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Admin writes require a future UTC start formatted to the millisecond. The
// default is refreshed at submit time: a value computed on mount silently
// expires while the page sits open, which reads as a confusing rejection.
const DEFAULT_START_MINUTES = 10;
function futureUtc(offsetMinutes = DEFAULT_START_MINUTES): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  at.setUTCSeconds(0, 0);
  return at.toISOString();
}

export function CatalogAdmin({ categoryId, disabled = false }: { categoryId: string | null; disabled?: boolean }) {
  const [name, setName] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(futureUtc);
  const [rupeesPerKg, setRupeesPerKg] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  // True once the operator edits the start time; until then it is refreshed
  // automatically so the default cannot go stale.
  const [startEdited, setStartEdited] = useState(false);
  const generation = useRef(0);

  // Never keep an uncertain write's inputs on screen after the tab is hidden;
  // a late response must not be reported as a fresh success.
  useEffect(() => {
    const invalidate = () => {
      if (document.visibilityState === 'hidden') {
        generation.current++;
        setPending(null); setMessage(''); setBusy(false);
      }
    };
    document.addEventListener('visibilitychange', invalidate);
    return () => { generation.current++; document.removeEventListener('visibilitychange', invalidate); };
  }, []);

  async function send(request: Pending) {
    const current = ++generation.current;
    // Hold the exact key and inputs so an uncertain write can be retried
    // without creating a duplicate.
    setPending(request); setBusy(true); setMessage('');
    try {
      if (request.kind === 'category') {
        const response = await fetch('/api/v1/admin/catalog/categories', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key },
          body: JSON.stringify({ name: request.name }),
          signal: AbortSignal.timeout(10000),
        });
        const json: unknown = await response.json();
        if (current !== generation.current) return;
        if (response.status === 401 || response.status === 403) { setPending(null); setMessage('Admin access is required to change the catalog.'); return; }
        if (response.status === 409) {
          const code = (json as { error?: { code?: string } })?.error?.code;
          setPending(null);
          setMessage(code === 'CATEGORY_EXISTS' ? 'That category already exists.' : 'This retry key was used for a different write. Check the catalog before retrying.');
          return;
        }
        if (!response.ok) throw Error('unavailable');
        setPending(null); setName('');
        setMessage('Category saved. Load the catalog to confirm it.');
      } else {
        const response = await fetch(`/api/v1/admin/catalog/categories/${encodeURIComponent(request.categoryId)}/rates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.key },
          body: JSON.stringify({ effectiveFrom: request.effectiveFrom, paisePerKg: request.paisePerKg }),
          signal: AbortSignal.timeout(10000),
        });
        const json: unknown = await response.json();
        if (current !== generation.current) return;
        if (response.status === 401 || response.status === 403) { setPending(null); setMessage('Admin access is required to change the catalog.'); return; }
        if (response.status === 409) {
          const code = (json as { error?: { code?: string } } | null)?.error?.code;
          setPending(null);
          setMessage(code === 'INVALID_RATE_TIME'
            ? 'Rate time must be in the future and later than every existing rate for this category.'
            : 'This retry key was used for a different write. Check the rates before retrying.');
          return;
        }
        if (!response.ok) throw Error('unavailable');
        setPending(null); setRupeesPerKg('');
        setMessage('Rate saved. Load the rates to confirm it.');
      }
    } catch {
      if (current === generation.current) {
        // An interrupted write may have committed. Keep the exact input and key
        // so a retry is replay-safe rather than creating a duplicate.
        setMessage('Save could not be confirmed. Retry the same values, or reload to check before changing them.');
      }
    } finally { if (current === generation.current) setBusy(false); }
  }

  function submitCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!pending && (!trimmed || Array.from(trimmed).length > 100)) { setMessage('Enter a category name of up to 100 characters.'); return; }
    void send(pending?.kind === 'category' ? pending : { kind: 'category', key: crypto.randomUUID(), name: trimmed });
  }

  function submitRate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!categoryId) { setMessage('Choose a category first.'); return; }
    if (pending?.kind === 'rate') { void send(pending); return; }
    // An untouched default is re-derived now so it is genuinely in the future.
    const source = startEdited ? effectiveFrom : futureUtc();
    if (!startEdited) setEffectiveFrom(source);
    const at = new Date(source);
    if (!Number.isFinite(at.getTime())) { setMessage('Enter a valid start time.'); return; }
    // Convert rupees to integer paise without floating point drift.
    const match = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(rupeesPerKg.trim());
    if (!match) { setMessage('Enter a rate in rupees per kg, for example 32.50.'); return; }
    const paisePerKg = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    if (!Number.isInteger(paisePerKg) || paisePerKg > 1_000_000_000) { setMessage('Enter a rate in rupees per kg, for example 32.50.'); return; }
    void send({ kind: 'rate', key: crypto.randomUUID(), categoryId, effectiveFrom: at.toISOString(), paisePerKg });
  }

  const formDisabled = busy || disabled;
  return <div className="catalog-admin">
    <h3>Add to test catalog</h3>
    <p>Development only. Every write is checked for a current admin grant by the API, and the change is permanent; there is no delete or edit yet.</p>
    <form onSubmit={submitCategory}>
      <fieldset disabled={formDisabled}>
        <label>Category name<input name="categoryName" value={name} maxLength={100} autoComplete="off" onChange={event => { setName(event.target.value); setPending(null); setMessage(''); }} /></label>
        <button type="submit" disabled={formDisabled}>{pending?.kind === 'category' ? 'Retry category save' : 'Save category'}</button>
      </fieldset>
    </form>
    {categoryId ? <form onSubmit={submitRate}>
      <fieldset disabled={formDisabled}>
        <label>Start time (UTC)<input name="effectiveFrom" value={effectiveFrom} autoComplete="off" onChange={event => { setEffectiveFrom(event.target.value); setStartEdited(true); setPending(null); setMessage(''); }} /></label>
        <label>Rate in rupees per kg<input name="rupeesPerKg" value={rupeesPerKg} inputMode="decimal" autoComplete="off" onChange={event => { setRupeesPerKg(event.target.value); setPending(null); setMessage(''); }} /></label>
        <button type="submit" disabled={formDisabled}>{pending?.kind === 'rate' ? 'Retry rate save' : 'Save rate for selected category'}</button>
      </fieldset>
    </form> : <p>Choose “View rates” on a category above before adding a rate.</p>}
    <p role="status" aria-live="polite">{message}</p>
  </div>;
}
