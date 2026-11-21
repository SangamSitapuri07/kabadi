// Where a role belongs. Pure data with no React and no Next imports, because both
// the sign-in screen and the dashboard shell need it, and keeping it importable
// on its own means the component tests can load it without a running router.

export const ROLES = ['customer', 'collector', 'shop', 'mandi', 'recycler', 'admin'] as const;
export type Role = (typeof ROLES)[number];

// The chain, highest last. Kept in the same order as the API's CHAIN_ROLES.
export const CHAIN_ORDER = ['customer', 'collector', 'shop', 'mandi', 'recycler'] as const;

export const ROLE_LABEL: Record<Role, string> = {
  customer: 'Customer',
  collector: 'Collector',
  shop: 'Area shop',
  mandi: 'Wholesale mandi',
  recycler: 'Recycler',
  admin: 'Administrator',
};

/**
 * The dashboard a set of roles belongs on.
 *
 * Highest role wins, and an account holding several lands on the one with the most
 * authority: an admin who also buys scrap should not have to hunt for the admin
 * tools. Returns `/` when there is nowhere to go, which is also the signal the
 * caller uses to decide *not* to redirect -- an account with no roles has no
 * dashboard, and sending it to `/` would loop.
 */
export function dashboardPathFor(roles: readonly string[] | null): string {
  if (!roles || roles.length === 0) return '/';
  if (roles.includes('admin')) return '/dashboard/admin';
  if (roles.includes('recycler')) return '/dashboard/recycler';
  if (roles.includes('mandi')) return '/dashboard/mandi';
  if (roles.includes('shop')) return '/dashboard/shop';
  if (roles.includes('collector')) return '/dashboard/collector';
  if (roles.includes('customer')) return '/dashboard/customer';
  return '/';
}

/** The highest tier an account sells at, or null if it holds no stock. */
export function sellingTier(roles: readonly string[] | null): string | null {
  if (!roles) return null;
  let highest: string | null = null;
  for (const role of CHAIN_ORDER) {
    // A customer holds no stock, so only collector and above count here.
    if (role === 'customer') continue;
    if (roles.includes(role)) highest = role;
  }
  return highest;
}
