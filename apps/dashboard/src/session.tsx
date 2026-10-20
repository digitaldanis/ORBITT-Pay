import { createContext, useContext, type ReactNode } from 'react';
import type { DashboardSession, Permission } from './api.js';

const SessionContext = createContext<DashboardSession | null>(null);

export function SessionProvider({ session, children }: { session: DashboardSession; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The signed-in member and what their role may change. The API enforces the same rules. */
export function useSession(): DashboardSession & { can: (permission: Permission) => boolean } {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return { ...session, can: (permission) => session.permissions.includes(permission) };
}

export const ROLE_LABELS: Record<DashboardSession['user']['role'], string> = { owner: 'Owner', admin: 'Admin', developer: 'Developer', viewer: 'Viewer' };

export const ROLE_DESCRIPTIONS: Record<DashboardSession['user']['role'], string> = {
  owner: 'Everything, including owners and the workspace name',
  admin: 'Wallets, team, developers and payments',
  developer: 'API keys, webhooks and payment links',
  viewer: 'Read-only access',
};
