import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LogOut, Plus, ShieldCheck, Webhook } from 'lucide-react';
import { BrandLockup } from '@orbitt/ui';
import { api, errorMessage, type Account, type ApiKeyRecord, type DashboardSession } from '../api.js';
import { dateLabel, relativeTime } from '../format.js';
import { Banner, CopyButton, EmptyState, Loading, PageHeader, StatusBadge, useResource } from '../ui.js';

function SecretReveal({ title, value }: { title: string; value: string }) {
  return (
    <div className="secret-reveal">
      <div><strong>{title}</strong><p>Shown once. Store it in your server's secret manager now.</p></div>
      <code>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

export function ApiKeysPage() {
  const load = useCallback(() => api<ApiKeyRecord[]>('/v1/dashboard/api-keys'), []);
  const { data, error, loading, reload } = useResource(load, 'API keys could not be loaded.');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setActionError(''); setSecret('');
    try {
      const result = await api<{ secret: string }>('/v1/dashboard/api-keys', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      setSecret(result.secret); setName(''); await reload();
    } catch (cause) { setActionError(errorMessage(cause, 'The API key could not be created.')); }
    finally { setBusy(false); }
  };
  const revoke = async (key: ApiKeyRecord) => {
    if (!window.confirm(`Revoke “${key.name}”? Requests using it stop working immediately.`)) return;
    try { await api(`/v1/dashboard/api-keys/${key.id}`, { method: 'DELETE' }); await reload(); }
    catch (cause) { setActionError(errorMessage(cause, 'The API key could not be revoked.')); }
  };

  return <>
    <PageHeader title="API keys" description="Secret keys let your shop backend create and read invoices. Never ship them to a browser or app." />
    {(error || actionError) && <Banner tone="error" onDismiss={() => setActionError('')}>{error || actionError}</Banner>}
    {secret && <SecretReveal title="Your new API key" value={secret} />}
    <form className="panel inline-form" onSubmit={(event) => void create(event)}>
      <div><h2>Create a secret key</h2><p>Name it after where it runs, so you know what to revoke later.</p></div>
      <div className="inline-form-controls">
        <input aria-label="Key name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production server" maxLength={120} required />
        <button className="primary-button" disabled={busy || !name.trim()}><Plus size={15} />Create key</button>
      </div>
    </form>
    <section className="panel">
      {!data ? (loading && <Loading label="Loading keys…" />) : !data.length ? <EmptyState icon={<KeyRound size={18} />} title="No API keys">Create one to connect your shop.</EmptyState> : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>State</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data.map((key) => (
                <tr key={key.id} className={key.revoked_at ? 'dimmed' : undefined}>
                  <td><strong>{key.name}</strong></td>
                  <td><code className="key-prefix">{key.key_prefix}…</code></td>
                  <td className="date-cell">{dateLabel(key.created_at)}</td>
                  <td className="date-cell" title={dateLabel(key.last_used_at)}>{relativeTime(key.last_used_at)}</td>
                  <td><StatusBadge status={key.revoked_at ? 'revoked' : 'active'} /></td>
                  <td className="actions-cell">{!key.revoked_at && <button className="danger-button small" onClick={() => void revoke(key)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage(''); setSecret('');
    try {
      const result = await api<{ webhook_url: string | null; signing_secret?: string }>('/v1/dashboard/account/webhook', {
        method: 'PUT', body: JSON.stringify({ url: url.trim() || null, rotate_secret: rotate }),
      });
      setSecret(result.signing_secret ?? ''); setRotate(false);
      setMessage(result.webhook_url ? 'Webhook endpoint saved.' : 'Webhook endpoint removed.');
      await reload();
    } catch (cause) { setError(errorMessage(cause, 'Webhook settings could not be saved.')); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2>Webhook endpoint</h2><p>Receives signed invoice events. HTTPS is required in production.</p></div><span className="panel-icon"><Webhook size={16} /></span></div>
      {message && <Banner tone="success" onDismiss={() => setMessage('')}>{message}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      <form className="form" onSubmit={(event) => void save(event)}>
        <label>Endpoint URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://shop.example/webhooks/orbitt" /></label>
        <div className="secret-state"><i className={account?.webhook.secret_configured ? 'ready' : undefined} />{account?.webhook.secret_configured ? 'Signing secret configured' : 'A signing secret is created when you save an endpoint.'}</div>
        {account?.webhook.secret_configured && <label className="check-label"><input type="checkbox" checked={rotate} onChange={(event) => setRotate(event.target.checked)} />Rotate the signing secret</label>}
        <div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save endpoint'}</button></div>
      </form>
      {secret && <SecretReveal title="Webhook signing secret" value={secret} />}
    </section>
  );
}

export function SettingsPage({ account, reload, session, logout }: { account: Account | null; reload: () => Promise<void>; session: DashboardSession; logout: () => Promise<void> }) {
  return <>
    <PageHeader title="Settings" description="Your workspace, notifications and session." />
    <section className="panel profile">
      <div className="avatar large">{session.merchant.name.slice(0, 1).toUpperCase()}</div>
      <div className="profile-copy"><h2>{session.merchant.name}</h2><p>{session.email}</p><span className="mono">Merchant {session.merchant.id}</span></div>
      <button className="secondary-button" onClick={() => void logout()}><LogOut size={14} />Sign out</button>
    </section>
    <WebhookSettings account={account} reload={reload} />
    <section className="panel">
      <div className="panel-heading"><div><h2>Security</h2><p>How this workspace protects your account.</p></div><span className="panel-icon"><ShieldCheck size={16} /></span></div>
      <ul className="check-list">
        <li><ShieldCheck size={15} />HTTP-only session cookie with CSRF protection on every change</li>
        <li><ShieldCheck size={15} />API keys and sessions stored only as hashes</li>
        <li><ShieldCheck size={15} />Webhook secrets encrypted at rest (AES-256-GCM)</li>
        <li><ShieldCheck size={15} />Public keys only: no private keys or seed phrases, ever</li>
      </ul>
    </section>
  </>;
}

export function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onLogin(email, password); } catch (cause) { setError(errorMessage(cause, 'Sign in failed.')); setBusy(false); }
  };
  return (
    <main className="login">
      <div className="login-planet" aria-hidden="true" />
      <section className="login-card">
        <div className="login-brand"><BrandLockup markSize={30} wordSize={15} /></div>
        <h1>Sign in</h1>
        <p>Manage payments, wallets and integrations.</p>
        <form className="form" onSubmit={(event) => void submit(event)}>
          <label>Email<input type="email" autoComplete="username" required autoFocus value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <Banner tone="error">{error}</Banner>}
          <button className="primary-button wide" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button>
        </form>
      </section>
      <p className="login-footer">Payments for every chain</p>
    </main>
  );
}
