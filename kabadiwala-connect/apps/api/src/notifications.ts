// NOTIFICATIONS ARE NOT IMPLEMENTED.
//
// Every state change below currently happens silently: a customer is never told
// their request was accepted, collected, corrected or paid, and a collector is
// never told a request is waiting or that a payout was recorded. Nothing in this
// repository sends an email, an SMS, a push notification or a WhatsApp message,
// and that is a deliberate deferral, not an oversight.
//
// This module exists so the deferral is *stated* rather than merely absent. It
// contains no transport, no credentials, no queue, no retry logic and no
// database table. When notifications are built, a sender plugs in and the
// descriptor below stops being a constant.
//
// Which channel and which audience each event should reach is NOT decided. That
// is owner input tracked as P0-02 ("notification channels/events"); the event
// list here is derived from transitions that actually exist in the code, not
// from a guess about policy.

// One entry per real state change in the pickup lifecycle, so this list cannot
// drift ahead of the features that exist or fall behind them unnoticed.
export const NOTIFICATION_EVENTS = [
  'pickup-requested',
  'pickup-accepted',
  'pickup-collected',
  'pickup-cancelled',
  'claim-released',
  'dispute-raised',
  'dispute-resolved',
  'dispute-rejected',
  'payout-recorded',
] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];
export const isNotificationEvent = (value: unknown): value is NotificationEvent =>
  typeof value === 'string' && (NOTIFICATION_EVENTS as readonly string[]).includes(value);

// Channels that were considered. Listed so the eventual choice is a visible
// decision rather than a silent default; none of them is wired up.
export const NOTIFICATION_CHANNELS = ['in-app', 'email', 'sms', 'whatsapp'] as const;
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];

// What the application can honestly claim today: nothing is sent, anywhere.
// A UI reads this so it never leaves someone waiting for a message.
//
// `configured: false` is a real value that is checked by a test -- flipping it
// without wiring a transport must fail, so this cannot quietly become a lie.
export const NOTIFICATION_PROVIDER = {
  configured: false as const,
  channels: [] as readonly NotificationChannel[],
  events: NOTIFICATION_EVENTS,
  // The honest sentence a screen can show: there is no message coming.
  delivery: 'none' as const,
};
