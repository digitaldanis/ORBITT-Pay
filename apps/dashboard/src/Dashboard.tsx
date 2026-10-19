import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, BookOpen, CreditCard, ExternalLink, KeyRound, LayoutGrid, LogOut, Menu, Settings2, WalletCards, Webhook, X } from 'lucide-react';
import { BrandLockup, OrbitMark } from '@orbitt/ui';
import { api, errorMessage, type Account, type DashboardSession } from './api.js';
import { CatalogProvider } from './catalog.js';
import { Banner } from './ui.js';
import { OverviewPage } from './pages/overview.js';
import { InvoiceDrawer, InvoicesPage } from './pages/invoices.js';
import { AssetsPage } from './pages/assets.js';
import { WebhooksPage } from './pages/webhooks.js';
import { ApiKeysPage, LoginScreen, SettingsPage } from './pages/settings.js';

export type Page = 'Overview' | 'Invoices' | 'Payments' | 'Assets' | 'Webhooks' | 'API keys' | 'Settings';

const NAVIGATION: Array<{ section: string; items: Array<{ label: Page; icon: typeof LayoutGrid }> }> = [
  { section: 'Payments', items: [{ label: 'Overview', icon: LayoutGrid }, { label: 'Invoices', icon: CreditCard }, { label: 'Payments', icon: ArrowDownLeft }] },
  { section: 'Setup', items: [{ label: 'Assets', icon: WalletCards }, { label: 'Webhooks', icon: Webhook }, { label: 'API keys', icon: KeyRound }, { label: 'Settings', icon: Settings2 }] },
];
const PAGES = NAVIGATION.flatMap((group) => group.items.map((item) => item.label));
const slug = (page: Page) => page.toLowerCase().replace(/\s+/g, '-');

function readRoute(): { page: Page; invoice: string | null } {
  const [first, second] = window.location.hash.replace(/^#\/?/, '').split('/');
  const page = PAGES.find((candidate) => slug(candidate) === first) ?? 'Overview';
  return { page, invoice: page === 'Invoices' && second && /^[0-9a-f-]{36}$/i.test(second) ? second : null };
}

function writeRoute(page: Page, invoice: string | null) {
  const hash = `#/${slug(page)}${invoice ? `/${invoice}` : ''}`;
  if (window.location.hash !== hash) window.history.pushState(null, '', hash);
}

function Shell({ session, logout }: { session: DashboardSession; logout: () => Promise<void> }) {
  const [route, setRoute] = useState(readRoute);
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const listener = () => setRoute(readRoute());
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);

  const reloadAccount = useCallback(async () => {
    try { setAccount(await api<Account>('/v1/dashboard/account')); }
    catch (cause) { setError(errorMessage(cause, 'Account settings could not be loaded.')); }
  }, []);
  useEffect(() => { void reloadAccount(); }, [reloadAccount]);

  const go = (page: Page) => { writeRoute(page, null); setRoute({ page, invoice: null }); setMenuOpen(false); window.scrollTo({ top: 0 }); };
  // Invoices opened from other pages keep that page underneath; only the invoice list puts the id in the URL.
  const [drawerInvoice, setDrawerInvoice] = useState<string | null>(route.invoice);
  useEffect(() => { if (route.invoice) setDrawerInvoice(route.invoice); }, [route.invoice]);
  const openInvoice = (id: string) => { if (route.page === 'Invoices') writeRoute('Invoices', id); setDrawerInvoice(id); };
  const closeInvoice = () => { if (route.invoice) writeRoute('Invoices', null); setRoute((current) => ({ ...current, invoice: null })); setDrawerInvoice(null); };
  const changed = () => setRefreshKey((value) => value + 1);
  const initial = session.merchant.name.slice(0, 1).toUpperCase();

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <header className="mobile-bar">
        <BrandLockup markSize={24} wordSize={13} />
        <button className="icon-button" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen}>{menuOpen ? <X size={18} /> : <Menu size={18} />}</button>
      </header>
      <aside className="sidebar">
        <div className="sidebar-brand"><BrandLockup markSize={26} wordSize={13} /></div>
        <div className="workspace">
          <span className="avatar">{initial}</span>
          <div><strong>{session.merchant.name}</strong><span>{session.email}</span></div>
        </div>
        <nav aria-label="Main navigation">
          {NAVIGATION.map((group) => (
            <div key={group.section} className="nav-group">
              <p className="nav-heading">{group.section}</p>
              {group.items.map(({ label, icon: Icon }) => (
                <button key={label} className={`nav-item${route.page === label ? ' selected' : ''}`} aria-current={route.page === label ? 'page' : undefined} onClick={() => go(label)}>
                  <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
                  {label === 'Assets' && account && account.wallets.length === 0 && <i className="nav-dot" aria-label="Setup needed" />}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <a className="nav-item" href="/docs" target="_blank" rel="noreferrer"><BookOpen size={17} strokeWidth={1.8} /><span>API reference</span><ExternalLink size={12} className="trailing" /></a>
          <button className="nav-item" onClick={() => void logout()}><LogOut size={17} strokeWidth={1.8} /><span>Sign out</span></button>
        </div>
      </aside>
      <main className="main">
        <div className="content">
          {error && <Banner tone="error" onDismiss={() => setError('')}>{error}</Banner>}
          {route.page === 'Overview' && <OverviewPage account={account} go={go} onOpen={openInvoice} refreshKey={refreshKey} onCreated={changed} />}
          {route.page === 'Invoices' && <InvoicesPage key="invoices" onOpen={openInvoice} refreshKey={refreshKey} />}
          {route.page === 'Payments' && <InvoicesPage key="payments" paidOnly onOpen={openInvoice} refreshKey={refreshKey} />}
          {route.page === 'Assets' && <AssetsPage account={account} reloadAccount={reloadAccount} />}
          {route.page === 'Webhooks' && <WebhooksPage account={account} onOpenInvoice={openInvoice} go={go} />}
          {route.page === 'API keys' && <ApiKeysPage />}
          {route.page === 'Settings' && <SettingsPage account={account} reload={reloadAccount} session={session} logout={logout} />}
        </div>
      </main>
      {drawerInvoice && <InvoiceDrawer id={drawerInvoice} onClose={closeInvoice} onChanged={changed} />}
    </div>
  );
}

export function Dashboard() {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<DashboardSession>('/v1/dashboard/session')
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    setSession(await api<DashboardSession>('/v1/dashboard/login', { method: 'POST', body: JSON.stringify({ email, password }) }));
  };
  const logout = async () => {
    try { await api('/v1/dashboard/logout', { method: 'POST' }); } finally { setSession(null); }
  };

  if (loading) return <div className="boot"><OrbitMark size={40} spinning /></div>;
  if (!session) return <LoginScreen onLogin={login} />;
  return <CatalogProvider><Shell session={session} logout={logout} /></CatalogProvider>;
}
