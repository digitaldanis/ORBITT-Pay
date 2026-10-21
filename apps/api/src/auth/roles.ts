export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What each role may change. Everyone in a workspace can read it; these gate writes.
 * - `payments`: create payment links and cancel invoices
 * - `developers`: API keys, webhook endpoint and secret, test events and redelivery
 * - `wallets`: receiving keys and addresses
 * - `team`: invite, change and disable members below owner
 * - `workspace`: rename the workspace and manage owners
 */
export const PERMISSIONS = ['payments', 'developers', 'wallets', 'team', 'workspace'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const GRANTS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS,
  admin: ['payments', 'developers', 'wallets', 'team'],
  developer: ['payments', 'developers'],
  viewer: [],
};

export function permissionsFor(role: Role): Permission[] {
  return [...GRANTS[role]];
}

export function can(role: Role, permission: Permission): boolean {
  return GRANTS[role].includes(permission);
}

/** Members may only manage roles at or below their own, and only owners manage owners. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (!can(actor, 'team')) return false;
  return target !== 'owner' || actor === 'owner';
}
