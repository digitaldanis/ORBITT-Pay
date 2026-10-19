import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowUpRight, Check, ChevronDown, CircleHelp, Clock3,
  Copy, CreditCard, ExternalLink, KeyRound, LayoutDashboard, LogOut, Plus, RefreshCw,
  Settings2, ShieldCheck, WalletCards, Webhook, X,
} from 'lucide-react';

type Page = 'Overview' | 'Invoices' | 'Payments' | 'Webhooks' | 'Assets' | 'API keys' | 'Settings';
type InvoiceStatus = 'created' | 'awaiting_payment' | 'detected' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'late_payment' | 'cancelled';

interface Invoice {
  id: string;
  order_id: string | null;
  amount: string;
  currency: string;
  crypto_amount: string;
  asset: string;
  network: string;
  address: string | null;
  status: InvoiceStatus;
  checkout_url: string;
  expires_at: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface Account {
  merchant: { id: string; name: string };
  webhook: { url: string | null; secret_configured: boolean };
  wallets: Array<{ asset: string; network: string; configured: boolean; source: string; next_derivation_index: string }>;
}

interface ApiKeyRecord { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
interface WebhookRecord { id: string; event: string; status: string; attempts: number; http_status: number | null; last_error: string | null; created_at: string; delivered_at: string | null }
interface Overview { summary: { total: number; paid: number; pending: number; expired: number; paid_today: number }; recent: Invoice[] }
interface DashboardSession { merchant: { id: string; name: string }; email: string }

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const navigation: Array<{ label: Page; icon: typeof LayoutDashboard }> = [
  { label: 'Overview', icon: LayoutDashboard },
  { label: 'Invoices', icon: CreditCard },
  { label: 'Payments', icon: ArrowDownLeft },
  { label: 'Webhooks', icon: Webhook },
  { label: 'Assets', icon: WalletCards },
  { label: 'API keys', icon: KeyRound },
  { label: 'Settings', icon: Settings2 },
];

function readCookie(name: string): string | undefined {
  return document.cookie.split('; ').find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('ob_csrf');
    if (csrf) headers.set('x-csrf-token', decodeURIComponent(csrf));
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, method, headers, credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function dateLabel(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function statusLabel(status: InvoiceStatus): string {
  const names: Record<InvoiceStatus, string> = {
    created: 'Created', awaiting_payment: 'Awaiting payment', detected: 'Detected', confirming: 'Confirming',
    paid: 'Paid', underpaid: 'Underpaid', overpaid: 'Overpaid', expired: 'Expired', late_payment: 'Late payment', cancelled: 'Cancelled',
  };
  return names[status];
}

function StatusBadge({ status }: { status: InvoiceStatus | string }) {
  return <span className={`badge badge-${status}`}>{status.replaceAll('_', ' ')}</span>;
}

function BrandMark() {
  return <span className="brand-lockup"><i className="brand-orbit" /><span>ORBITT <b>PAY</b></span></span>;
}

function Login({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onLogin(email, password); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign in failed.'); }
    finally { setBusy(false); }
  };
  return (
    <main className="login-screen">
      <div className="login-glow" />
      <div className="login-brand"><BrandMark /><span className="brand-tagline">Payments for every chain</span></div>
      <section className="login-card">
        <div className="login-icon"><ShieldCheck size={20} /></div>
        <h1>Welcome back</h1>
        <p>Sign in to manage your payment activity.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button login-button" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="login-foot"><ShieldCheck size={14} />Your session is encrypted and protected</div>
      </section>
      <p className="login-footer">ORBITT PAY · Merchant dashboard</p>
    </main>
  );
}

function InvoiceTable({ invoices, compact = false }: { invoices: Invoice[]; compact?: boolean }) {
  if (!invoices.length) return <div className="empty-table"><div className="empty-icon"><CreditCard size={18} /></div><strong>No invoices yet</strong><span>Your payment activity will appear here.</span></div>;
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Invoice</th><th>Amount</th><th>Status</th><th>Created</th>{!compact && <th>Checkout</th>}</tr></thead>
      <tbody>{invoices.map((invoice) => <tr key={invoice.id}>
        <td><span className="invoice-id">{invoice.order_id || invoice.id.slice(0, 8)}</span><small>{invoice.id.slice(0, 8)}</small></td>
        <td><strong>{invoice.crypto_amount} {invoice.asset}</strong><small>{invoice.amount} {invoice.currency}</small></td>
        <td><StatusBadge status={invoice.status} /></td>
        <td className="date-cell">{dateLabel(invoice.created_at)}</td>
        {!compact && <td><a className="icon-link" href={invoice.checkout_url} target="_blank" rel="noreferrer" aria-label="Open checkout"><ExternalLink size={15} /></a></td>}
      </tr>)}</tbody>
    </table></div>
  );
}

function OverviewPage({ data, onInvoices }: { data: Overview; onInvoices: () => void }) {
  const cards = [
    { title: 'Total invoices', value: data.summary.total, hint: 'All time', icon: CreditCard, tone: 'violet' },
    { title: 'Paid', value: data.summary.paid, hint: `${data.summary.paid_today} today`, icon: Check, tone: 'green' },
    { title: 'Awaiting payment', value: data.summary.pending, hint: 'Open invoices', icon: Clock3, tone: 'blue' },
    { title: 'Expired', value: data.summary.expired, hint: 'Past quote window', icon: Activity, tone: 'amber' },
  ];
  return <>
    <div className="page-intro"><div><h1>Overview</h1><p>Here’s what’s happening with your payments.</p></div><span className="today-chip"><span /> Live data</span></div>
    <div className="stats-grid">{cards.map(({ title, value, hint, icon: Icon, tone }) => <article className="stat-card" key={title}>
      <div className="stat-card-top"><span>{title}</span><i className={`stat-icon ${tone}`}><Icon size={16} /></i></div>
      <strong className="stat-value">{value.toLocaleString()}</strong><span className="stat-hint">{hint}</span>
    </article>)}</div>
    <section className="panel recent-panel"><div className="panel-heading"><div><h2>Recent invoices</h2><p>Your latest payment requests</p></div><button className="text-button" onClick={onInvoices}>View all <ArrowUpRight size={14} /></button></div><InvoiceTable invoices={data.recent} compact /></section>
    <section className="connect-panel"><div className="connect-icon"><Activity size={17} /></div><div><h2>Ready to connect your store?</h2><p>Create your first invoice through the API and send customers to hosted checkout.</p></div><a href="/docs" className="connect-link">API reference <ExternalLink size={14} /></a></section>
  </>;
}

function InvoicesPage({ payments = false }: { payments?: boolean }) {
  const [status, setStatus] = useState(payments ? 'paid' : '');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (status) query.set('status', status);
      const result = await api<{ data: Invoice[] }>(`/v1/dashboard/invoices?${query}`);
      setInvoices(result.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invoices could not be loaded.'); }
    finally { setBusy(false); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  return <>
    <div className="page-intro"><div><h1>{payments ? 'Payments' : 'Invoices'}</h1><p>{payments ? 'Completed payments received by your store.' : 'Track and manage your customer invoices.'}</p></div><button className="secondary-button" onClick={() => void load()}><RefreshCw size={14} />Refresh</button></div>
    <section className="panel table-panel">
      <div className="list-toolbar"><div><h2>{payments ? 'Payment history' : 'All invoices'}</h2><span>{invoices.length} shown</span></div>{!payments && <label className="select-wrap"><span className="visually-hidden">Filter by status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{['awaiting_payment', 'detected', 'confirming', 'paid', 'underpaid', 'overpaid', 'expired', 'cancelled'].map((item) => <option key={item} value={item}>{statusLabel(item as InvoiceStatus)}</option>)}</select><ChevronDown size={14} /></label>}</div>
      {error ? <div className="empty-table"><strong>{error}</strong></div> : busy ? <div className="table-loading"><RefreshCw className="spin" size={18} />Loading invoices…</div> : <InvoiceTable invoices={invoices} />}
    </section>
  </>;
}

function WebhooksPage() {
  const [deliveries, setDeliveries] = useState<WebhookRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setDeliveries(await api<WebhookRecord[]>('/v1/dashboard/webhooks')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Webhook deliveries could not be loaded.'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const test = async () => {
    setSending(true); setMessage(''); setError('');
    try { await api('/v1/dashboard/webhooks/test', { method: 'POST' }); setMessage('Test event queued.'); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Test event could not be queued.'); }
    finally { setSending(false); }
  };
  return <>
    <div className="page-intro"><div><h1>Webhooks</h1><p>See event delivery activity and retry status.</p></div><button className="primary-button" disabled={sending} onClick={() => void test()}><Webhook size={15} />{sending ? 'Sending…' : 'Send test event'}</button></div>
    {message && <div className="success-banner"><Check size={15} />{message}</div>}{error && <div className="error-banner">{error}</div>}
    <section className="panel table-panel"><div className="list-toolbar"><div><h2>Recent deliveries</h2><span>Latest 25 events</span></div></div>
      {busy ? <div className="table-loading"><RefreshCw className="spin" size={18} />Loading events…</div> : !deliveries.length ? <div className="empty-table"><div className="empty-icon"><Webhook size={18} /></div><strong>No webhook deliveries</strong><span>Configure an endpoint in Settings to receive invoice events.</span></div> :
        <div className="table-scroll"><table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Created</th></tr></thead><tbody>{deliveries.map((delivery) => <tr key={delivery.id}><td><strong>{delivery.event}</strong><small>{delivery.id.slice(0, 8)}</small></td><td><StatusBadge status={delivery.status} /></td><td>{delivery.attempts}</td><td>{delivery.http_status ?? '—'}</td><td className="date-cell">{dateLabel(delivery.created_at)}</td></tr>)}</tbody></table></div>}
    </section>
    <p className="quiet-note">Delivery is at least once. Your endpoint should deduplicate repeated events by delivery ID.</p>
  </>;
}

function AssetsPage({ account, reload }: { account: Account | null; reload: () => Promise<void> }) {
  const [asset, setAsset] = useState('BTC');
  const [network, setNetwork] = useState('bitcoin');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const networks: Record<string, string[]> = { BTC: ['bitcoin', 'bitcoin-testnet'], LTC: ['litecoin'], ETH: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb-chain'] };
  const chooseAsset = (next: string) => { setAsset(next); setNetwork(networks[next]![0]!); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage(''); setError('');
    try {
      await api('/v1/dashboard/account/wallets', { method: 'PUT', body: JSON.stringify({ wallets: [{ asset, network, extended_public_key: key }] }) });
      setKey(''); setMessage(`${asset} wallet saved.`); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Wallet configuration could not be saved.'); }
    finally { setBusy(false); }
  };
  return <>
    <div className="page-intro"><div><h1>Assets</h1><p>Configure public keys used to derive unique receive addresses.</p></div></div>
    {message && <div className="success-banner"><Check size={15} />{message}</div>}{error && <div className="error-banner">{error}</div>}
    <div className="settings-grid">
      <section className="panel settings-panel"><div className="panel-heading"><div><h2>Receiving wallet</h2><p>Only public account keys are accepted. Never enter a seed phrase.</p></div><div className="panel-icon"><WalletCards size={17} /></div></div>
        <form onSubmit={(event) => void save(event)} className="settings-form">
          <div className="form-row"><label>Asset<select value={asset} onChange={(event) => chooseAsset(event.target.value)}>{Object.keys(networks).map((item) => <option key={item}>{item}</option>)}</select></label><label>Network<select value={network} onChange={(event) => setNetwork(event.target.value)}>{networks[asset]!.map((item) => <option key={item}>{item}</option>)}</select></label></div>
          <label>Account-level public key<input value={key} onChange={(event) => setKey(event.target.value)} placeholder={asset === 'BTC' ? 'zpub…' : 'xpub…'} autoComplete="off" spellCheck={false} required /></label>
          <p className="field-hint">The key stays on the server and is never returned in full. Address indexes are reserved atomically.</p>
          <button className="primary-button" disabled={busy || !key.trim()}>{busy ? 'Saving…' : 'Save wallet'}</button>
        </form>
      </section>
      <section className="panel settings-panel"><div className="panel-heading"><div><h2>Configured wallets</h2><p>Address derivation status by network</p></div><div className="panel-icon"><ShieldCheck size={17} /></div></div>
        {!account?.wallets.length ? <div className="empty-inline">No wallets configured. Add a public key to start issuing invoices.</div> : <div className="wallet-list">{account.wallets.map((wallet) => <div className="wallet-row" key={`${wallet.asset}-${wallet.network}`}><div className="coin-mark">{wallet.asset.slice(0, 1)}</div><div className="wallet-meta"><strong>{wallet.asset}</strong><span>{wallet.network} · {wallet.source.replaceAll('_', ' ')}</span></div><div className="wallet-index">Next index <strong>{wallet.next_derivation_index}</strong></div></div>)}</div>}
      </section>
    </div>
  </>;
}

function WebhookSettings({ account, reload }: { account: Account | null; reload: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [rotate, setRotate] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setUrl(account?.webhook.url ?? ''); }, [account?.webhook.url]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage(''); setSecret('');
    try {
      const result = await api<{ webhook_url: string | null; signing_secret?: string }>('/v1/dashboard/account/webhook', {
        method: 'PUT', body: JSON.stringify({ url: url.trim() || null, rotate_secret: rotate }),
      });
      setSecret(result.signing_secret ?? ''); setRotate(false); setMessage(result.signing_secret ? 'Endpoint saved. Store the new signing secret now.' : 'Webhook endpoint saved.'); await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Webhook settings could not be saved.'); }
    finally { setBusy(false); }
  };
  return <section className="panel settings-panel webhook-settings"><div className="panel-heading"><div><h2>Webhook endpoint</h2><p>Events are signed and delivered asynchronously.</p></div><div className="panel-icon"><Webhook size={17} /></div></div>
    {message && <div className="success-banner"><Check size={15} />{message}</div>}{error && <div className="error-banner">{error}</div>}
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <label>Destination URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://store.example/webhooks/orbitt" /></label>
      <div className="secret-state"><span className={account?.webhook.secret_configured ? 'state-dot ready' : 'state-dot'} />{account?.webhook.secret_configured ? 'Signing secret configured' : 'A signing secret will be created when you save an endpoint.'}</div>
      <label className="check-label"><input type="checkbox" checked={rotate} onChange={(event) => setRotate(event.target.checked)} />Rotate signing secret</label>
      <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save webhook settings'}</button>
    </form>
    {secret && <div className="secret-reveal"><div><strong>Copy your signing secret</strong><p>This secret is shown once. Store it securely before leaving this page.</p></div><code>{secret}</code><button className="secondary-button" onClick={() => void navigator.clipboard.writeText(secret)}><Copy size={14} />Copy secret</button></div>}
  </section>;
}

function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState('');
  const [oneTimeSecret, setOneTimeSecret] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try { setKeys(await api<ApiKeyRecord[]>('/v1/dashboard/api-keys')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'API keys could not be loaded.'); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setMessage(''); setOneTimeSecret('');
    try {
      const result = await api<{ secret: string }>('/v1/dashboard/api-keys', { method: 'POST', body: JSON.stringify({ name }) });
      setOneTimeSecret(result.secret); setName(''); setMessage('API key created. Copy and store it now.'); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'API key could not be created.'); }
  };
  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this API key? Requests using it will stop working.')) return;
    try { await api(`/v1/dashboard/api-keys/${id}`, { method: 'DELETE' }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'API key could not be revoked.'); }
  };
  return <>
    <div className="page-intro"><div><h1>API keys</h1><p>Use secret keys from your server to create invoices.</p></div></div>
    {message && <div className="success-banner"><Check size={15} />{message}</div>}{error && <div className="error-banner">{error}</div>}
    {oneTimeSecret && <section className="secret-reveal key-reveal"><div><strong>Copy your new API key</strong><p>This is the only time the full key will be shown.</p></div><code>{oneTimeSecret}</code><button className="secondary-button" onClick={() => void navigator.clipboard.writeText(oneTimeSecret)}><Copy size={14} />Copy key</button></section>}
    <section className="panel table-panel"><div className="list-toolbar"><div><h2>Secret keys</h2><span>Keys are stored as hashes</span></div></div>
      {busy ? <div className="table-loading"><RefreshCw className="spin" size={18} />Loading keys…</div> : <div className="table-scroll"><table><thead><tr><th>Name</th><th>Key prefix</th><th>Created</th><th>Last used</th><th>State</th><th /></tr></thead><tbody>{keys.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td><code className="key-prefix">{item.key_prefix}…</code></td><td className="date-cell">{dateLabel(item.created_at)}</td><td className="date-cell">{dateLabel(item.last_used_at)}</td><td><StatusBadge status={item.revoked_at ? 'revoked' : 'active'} /></td><td>{!item.revoked_at && <button className="quiet-action" onClick={() => void revoke(item.id)}>Revoke</button>}</td></tr>)}</tbody></table></div>}
    </section>
    <form className="panel create-key-form" onSubmit={(event) => void create(event)}><div><h2>Create a secret key</h2><p>Keys carry full merchant API access. Keep them on your server.</p></div><div className="create-key-controls"><input aria-label="Key name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production server" maxLength={120} required /><button className="primary-button"><Plus size={15} />Create key</button></div></form>
  </>;
}

function SettingsPage({ account, reload, session, logout }: { account: Account | null; reload: () => Promise<void>; session: DashboardSession; logout: () => Promise<void> }) {
  return <>
    <div className="page-intro"><div><h1>Settings</h1><p>Manage account access and notification preferences.</p></div></div>
    <section className="panel profile-panel"><div className="profile-avatar">{session.merchant.name.slice(0, 1).toUpperCase()}</div><div className="profile-copy"><h2>{session.merchant.name}</h2><p>{session.email}</p><span>Merchant account · {session.merchant.id.slice(0, 8)}</span></div><button className="secondary-button" onClick={() => void logout()}><LogOut size={14} />Sign out</button></section>
    <WebhookSettings account={account} reload={reload} />
    <section className="panel settings-panel"><div className="panel-heading"><div><h2>Security</h2><p>Dashboard sessions use secure cookies and CSRF protection.</p></div><div className="panel-icon"><ShieldCheck size={17} /></div></div><div className="security-row"><span><ShieldCheck size={16} />Two-factor authentication</span><StatusBadge status="not configured" /></div><p className="field-hint">Two-factor authentication can be added by your administrator in a later release.</p></section>
  </>;
}

export function Dashboard() {
  const [session, setSession] = useState<DashboardSession | null>(null);
  const [page, setPage] = useState<Page>('Overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadSession = useCallback(async () => {
    try { setSession(await api<DashboardSession>('/v1/dashboard/session')); }
    catch { setSession(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadSession(); }, [loadSession]);

  const reloadOverview = useCallback(async () => {
    try { setOverview(await api<Overview>('/v1/dashboard/overview')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Dashboard data could not be loaded.'); }
  }, []);
  const reloadAccount = useCallback(async () => {
    try { setAccount(await api<Account>('/v1/dashboard/account')); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Account settings could not be loaded.'); }
  }, []);
  useEffect(() => {
    if (!session) return;
    void reloadOverview(); void reloadAccount();
  }, [session, reloadOverview, reloadAccount]);

  const login = async (email: string, password: string) => {
    const result = await api<DashboardSession>('/v1/dashboard/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    setSession(result); setPage('Overview');
  };
  const logout = async () => {
    try {
      await api('/v1/dashboard/logout', { method: 'POST' });
      setSession(null); setOverview(null); setAccount(null); setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.');
    }
  };

  const title = useMemo(() => page, [page]);
  if (loading) return <div className="auth-loading"><div className="loading-orbit" /><p>Loading your workspace</p></div>;
  if (!session) return <Login onLogin={login} />;

  return <div className="dashboard-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><BrandMark /></div>
      <div className="workspace-switch"><div className="workspace-avatar">{session.merchant.name.slice(0, 1).toUpperCase()}</div><div className="workspace-name"><strong>{session.merchant.name}</strong><span>Merchant workspace</span></div><ChevronDown size={14} /></div>
      <nav aria-label="Main navigation"><p className="nav-heading">Workspace</p>{navigation.map(({ label, icon: Icon }) => <button key={label} className={`nav-item ${page === label ? 'selected' : ''}`} onClick={() => { setPage(label); setError(''); }}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{label === 'Invoices' && overview?.summary.pending ? <i className="nav-count">{overview.summary.pending}</i> : null}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><CircleHelp size={15} /></div><strong>Need a hand?</strong><p>Read the integration guide for help getting started.</p><a href="https://github.com/digitaldanis/ORBITT-Pay/tree/main/docs" target="_blank" rel="noreferrer">View docs <ExternalLink size={12} /></a></div><div className="sidebar-user"><div className="user-avatar">{session.email.slice(0, 1).toUpperCase()}</div><div><strong>{session.email}</strong><span>Owner</span></div><button aria-label="Sign out" onClick={() => void logout()}><LogOut size={15} /></button></div></div>
    </aside>
    <main className="dashboard-main">
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{title}</strong></div><div className="topbar-right"><span className="secure-chip"><ShieldCheck size={14} />Secure connection</span><button className="top-avatar" aria-label="Account settings" onClick={() => setPage('Settings')}>{session.merchant.name.slice(0, 1).toUpperCase()}</button></div></header>
      <div className="page-content">
        {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss"><X size={14} /></button></div>}
        {page === 'Overview' && (overview ? <OverviewPage data={overview} onInvoices={() => setPage('Invoices')} /> : <div className="table-loading"><RefreshCw className="spin" size={18} />Loading overview…</div>)}
        {page === 'Invoices' && <InvoicesPage />}
        {page === 'Payments' && <InvoicesPage payments />}
        {page === 'Webhooks' && <WebhooksPage />}
        {page === 'Assets' && <AssetsPage account={account} reload={reloadAccount} />}
        {page === 'API keys' && <ApiKeysPage />}
        {page === 'Settings' && <SettingsPage account={account} reload={reloadAccount} session={session} logout={logout} />}
      </div>
    </main>
  </div>;
}
