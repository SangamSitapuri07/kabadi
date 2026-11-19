'use client';
import { useState } from 'react';

// The in-app inbox. Notifications are delivered when this list is read; there is
// no push, email or SMS behind them, and the footer says so rather than letting
// a recipient assume a message would have arrived some other way.
type Notification = {
  id:string; event:string; requestId:string|null; detail:string|null;
  createdAt:string; readAt:string|null;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = ['pickup-requested','pickup-accepted','pickup-collected','pickup-cancelled','claim-released',
  'dispute-raised','dispute-resolved','dispute-rejected','payout-recorded'];

// Plain-language copy per event. Kept here rather than in the API so the wire
// format stays a stable vocabulary and wording can change freely.
const LABEL: Record<string,string> = {
  'pickup-requested': 'New pickup request waiting',
  'pickup-accepted': 'A collector accepted your request',
  'pickup-collected': 'Your pickup was collected',
  'pickup-cancelled': 'A request you claimed was cancelled',
  'claim-released': 'The collector released your request',
  'dispute-raised': 'A customer disputed an amount',
  'dispute-resolved': 'Your dispute was resolved',
  'dispute-rejected': 'Your dispute was reviewed and rejected',
  'payout-recorded': 'A payout to you was recorded',
};
// The detail carries paise; show rupees without floating-point arithmetic.
// Every figure is converted, not just the first: a collected message carries
// both the per-kg rate and the total, and leaving one as raw paise would be a
// confusing half-conversion.
function detail(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.replace(/\b(\d{1,16}) paise\b/g, (_match, digits: string) => {
    const value = BigInt(digits);
    return `₹${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
  });
}

export function NotificationInbox({ disabled }: { disabled: boolean }) {
  const [items, setItems] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  // `after` carries a confirmation through the reload that follows an action.
  async function load(after = '') {
    setBusy(true); setMessage(after);
    try {
      const response = await fetch('/api/v1/notifications', { cache:'no-store', signal:AbortSignal.timeout(10000) });
      const json = await response.json();
      if (response.status === 401 || response.status === 403) { setItems(null); setMessage('Sign-in is required.'); return; }
      if (response.status === 503 && json?.error?.code === 'PICKUP_SCHEMA_OUTDATED') {
        setItems(null); setMessage('The pickup database is behind this build. Run the pickup migration, then reload.'); return;
      }
      if (!response.ok || !Array.isArray(json?.data?.notifications)) throw Error('unavailable');
      const parsed = json.data.notifications.map((v: unknown) => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const n = v as Record<string, unknown>;
        // A message with an unknown event has no copy and no meaning to show.
        if (!uuid.test(String(n.id ?? '')) || !EVENTS.includes(String(n.event)) ||
            typeof n.createdAt !== 'string' || Number.isNaN(Date.parse(n.createdAt)) ||
            !(n.readAt === null || (typeof n.readAt === 'string' && !Number.isNaN(Date.parse(n.readAt)))) ||
            !(n.detail === null || typeof n.detail === 'string')) return null;
        return n as unknown as Notification;
      });
      if (parsed.some((p: Notification | null) => p === null)) throw Error('invalid');
      const list = parsed as Notification[];
      setItems(list);
      // The unread count is derived from what is actually on screen, so the badge
      // cannot disagree with the list below it.
      setUnread(list.filter(n => n.readAt === null).length);
      if (after) setMessage(after);
    } catch { setItems(null); setMessage('Notifications could not be loaded. Please try again.'); }
    finally { setBusy(false); }
  }

  async function markRead(item: Notification) {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/v1/notifications/${item.id}/read`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:'{}', signal:AbortSignal.timeout(10000),
      });
      if (response.status === 200) { await load(); return; }
      if (response.status === 404) { await load('That notification no longer exists. The list was refreshed.'); return; }
      if (response.status === 401 || response.status === 403) { setMessage('Sign-in is required.'); return; }
      throw Error('unavailable');
    } catch { setMessage('That could not be confirmed. Check the list before trying again.'); }
    finally { setBusy(false); }
  }

  async function markAll() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/v1/notifications/read-all', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:'{}', signal:AbortSignal.timeout(10000),
      });
      const json = await response.json();
      if (response.status === 200 && Number.isInteger(json?.data?.cleared)) {
        await load(json.data.cleared === 0 ? 'Nothing was unread.' : `Marked ${json.data.cleared} as read.`); return;
      }
      if (response.status === 401 || response.status === 403) { setMessage('Sign-in is required.'); return; }
      throw Error('unavailable');
    } catch { setMessage('That could not be confirmed. Check the list before trying again.'); }
    finally { setBusy(false); }
  }

  return <section className="notification-inbox">
    <h2>Your notifications{unread > 0 ? ` (${unread} unread)` : ''}</h2>
    <p>These are delivered in this app only. There is no email, SMS or WhatsApp message, so nothing will reach you when you are not signed in.</p>
    <button type="button" onClick={() => load()} disabled={disabled || busy}>Load notifications</button>
    {items !== null && items.length > 0 && <button type="button" onClick={markAll} disabled={disabled || busy || unread === 0}>Mark all as read</button>}
    <p role="status" aria-live="polite">{message}</p>
    {items !== null && <div>
      {items.length === 0 ? <p>No notifications yet.</p> : <ul>{items.map(item => <li key={item.id} className={item.readAt === null ? 'unread' : undefined}>
        <span>{LABEL[item.event] ?? item.event}</span>
        {detail(item.detail) && <><br /><span>{detail(item.detail)}</span></>}
        <br /><span>{new Date(item.createdAt).toLocaleString()}{item.readAt === null ? ' · unread' : ''}</span>
        {item.readAt === null && <><br /><button type="button" onClick={() => markRead(item)} disabled={disabled || busy}>Mark as read</button></>}
      </li>)}</ul>}
    </div>}
  </section>;
}
