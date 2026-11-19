// IN-APP NOTIFICATIONS ARE IMPLEMENTED. EXTERNAL DELIVERY IS NOT.
//
// The channel decision has been made: notifications are in-app only. A
// notification is a row in kabadi_pickup.notifications, written in the same
// transaction as the change it announces, and delivered when the recipient's
// screen reads it. `read_at` is the only delivery fact that exists.
//
// What is deliberately still absent: email, SMS, WhatsApp and push. There is no
// transport, no queue, no retry, no provider credential and no cron. A recipient
// who never opens the app is never told anything, and no amount of this code
// changes that -- so the UI still states it rather than implying a message.
//
// Which event should reach which audience IS decided, because the in-app
// implementation had to choose a recipient for each one; see the table below.
// Changing a recipient is a code change here, not a policy question left open.

// One entry per real state change in the pickup lifecycle.
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

// Who hears about what. The actor is always excluded: nobody is notified of
// their own action. `collectors` and `admins` mean every active account holding
// that grant, minus the actor.
export const NOTIFICATION_AUDIENCE: Record<NotificationEvent, 'customer' | 'collector' | 'admins' | 'collectors'> = {
  'pickup-requested': 'collectors',
  'pickup-accepted': 'customer',
  'pickup-collected': 'customer',
  'pickup-cancelled': 'collector',
  'claim-released': 'customer',
  'dispute-raised': 'admins',
  'dispute-resolved': 'customer',
  'dispute-rejected': 'customer',
  'payout-recorded': 'collector',
};

// In-app delivery exists; nothing leaves the application. The two facts are
// reported separately so a screen can say "check your notifications here" while
// still saying "do not expect an email".
export const NOTIFICATION_PROVIDER = {
  configured: true as const,
  delivery: 'in-app' as const,
  channels: ['in-app'] as const,
  external: [] as readonly string[],
  events: NOTIFICATION_EVENTS,
};
