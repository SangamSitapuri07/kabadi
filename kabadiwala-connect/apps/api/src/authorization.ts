import type { RequestHandler } from 'express';

// These are application roles, not claims accepted from a browser or Google.
export type Role = 'customer' | 'collector' | 'admin';
export type Principal = Readonly<{ userId: string; roles: readonly Role[] }>;
export type IdentityResolver = (cookie?: string) => Promise<{ userId: string | null; cookies: string[] }>;
// A future adapter must read current status and grants from a trusted server-side
// store by this user ID on every request. Null means no application account.
export type AccountLookup = (userId: string) => Promise<unknown>;

const roles: readonly Role[] = ['customer', 'collector', 'admin'];
function isRole(value: unknown): value is Role {
  return typeof value === 'string' && roles.includes(value as Role);
}
function account(value: unknown): { status: 'active' | 'suspended'; roles: Role[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('status' in value) ||
      !('roles' in value) || (value.status !== 'active' && value.status !== 'suspended') ||
      !Array.isArray(value.roles) || !value.roles.every(isRole)) {
    throw new Error('Invalid authorization account');
  }
  return { status: value.status, roles: value.roles };
}

// Only intended for explicitly mounted protected routes. This module does not
// create a role store or grant roles. Neither this guard nor a role alone checks
// ownership, collector verification, workflow state or CSRF on mutation routes.
export function requireRoles(
  dependencies: { resolveIdentity: IdentityResolver; lookupAccount: AccountLookup } | undefined,
  allowedRoles: readonly Role[],
): RequestHandler {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0 || !allowedRoles.every(isRole)) {
    throw new Error('A protected route must specify valid roles.');
  }
  // Copy to prevent later mutation of the policy passed by the route author.
  const allowed = [...allowedRoles];
  return async (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!dependencies) {
      response.status(503).json({ error: { code: 'AUTHORIZATION_UNAVAILABLE', message: 'Access is unavailable.' } });
      return;
    }
    try {
      const identity = await dependencies.resolveIdentity(request.headers.cookie);
      if (!identity || !Array.isArray(identity.cookies) || !identity.cookies.every(cookie => typeof cookie === 'string') ||
          (identity.userId !== null && (typeof identity.userId !== 'string' || !identity.userId.trim()))) {
        throw new Error('Invalid identity');
      }
      if (identity.cookies.length) response.append('Set-Cookie', identity.cookies);
      if (identity.userId === null) {
        response.status(401).json({ error: { code: 'SIGN_IN_REQUIRED', message: 'Sign-in is required.' } });
        return;
      }
      const record = await dependencies.lookupAccount(identity.userId);
      if (record === null) {
        response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access is not allowed.' } });
        return;
      }
      const current = account(record);
      if (current.status !== 'active' || !current.roles.some(role => allowed.includes(role))) {
        response.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access is not allowed.' } });
        return;
      }
      const principal: Principal = Object.freeze({ userId: identity.userId, roles: Object.freeze([...current.roles]) });
      response.locals.principal = principal;
      next();
    } catch {
      response.status(503).json({ error: { code: 'AUTHORIZATION_UNAVAILABLE', message: 'Access is unavailable.' } });
    }
  };
}
