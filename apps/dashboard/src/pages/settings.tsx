import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Building2, KeyRound, LockKeyhole, LogOut, MonitorSmartphone, Plus, ShieldCheck, Webhook } from 'lucide-react';
import { BrandLockup } from '@orbitt/ui';
import { api, errorMessage, type Account, type ApiKeyRecord, type DashboardSession, type SessionRecord } from '../api.js';
import { ROLE_LABELS, useSession } from '../session.js';
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
  const { can } = useSession();
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
    {!can('developers') && <Banner tone="warning">Your role can view keys but not create or revoke them.</Banner>}
    {can('developers') && <form className="panel inline-form" onSubmit={(event) => void create(event)}>
      <div><h2>Create a secret key</h2><p>Name it after where it runs, so you know what to revoke later.</p></div>
      <div className="inline-form-controls">
        <input aria-label="Key name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production server" maxLength={120} required />
        <button className="primary-button" disabled={busy || !name.trim()}><Plus size={15} />Create key</button>
      </div>
    </form>}
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
                  <td className="actions-cell">{!key.revoked_at && can('developers') && <button className="danger-button small" onClick={() => void revoke(key)}>Revoke</button>}</td>
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
  const { can } = useSession();
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
        <fieldset className="plain-fieldset" disabled={!can('developers')}>
        <label>Endpoint URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://shop.example/webhooks/orbitt" /></label>
        <div className="secret-state"><i className={account?.webhook.secret_configured ? 'ready' : undefined} />{account?.webhook.secret_configured ? 'Signing secret configured' : 'A signing secret is created when you save an endpoint.'}</div>
        {account?.webhook.secret_configured && <label className="check-label"><input type="checkbox" checked={rotate} onChange={(event) => setRotate(event.target.checked)} />Rotate the signing secret</label>}
        {can('developers') && <div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save endpoint'}</button></div>}
        </fieldset>
      </form>
      {secret && <SecretReveal title="Webhook signing secret" value={secret} />}
    </section>
  );
}

function WorkspaceSettings({ onRenamed }: { onRenamed: (name: string) => void }) {
  const session = useSession();
  const [name, setName] = useState(session.merchant.name);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ name: string }>('/v1/dashboard/workspace', { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
      onRenamed(result.name); setMessage('Workspace renamed. Checkout shows the new name.');
    } catch (cause) { setError(errorMessage(cause, 'The workspace could not be renamed.')); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2>Workspace</h2><p>The name customers see on the checkout page.</p></div><span className="panel-icon"><Building2 size={16} /></span></div>
      {message && <Banner tone="success" onDismiss={() => setMessage('')}>{message}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      <form className="form" onSubmit={(event) => void save(event)}>
        <fieldset className="plain-fieldset" disabled={!session.can('workspace')}>
          <label>Workspace name<input value={name} maxLength={160} required onChange={(event) => setName(event.target.value)} /></label>
          {session.can('workspace')
            ? <div className="form-actions"><button className="primary-button" disabled={busy || !name.trim() || name.trim() === session.merchant.name}>{busy ? 'Saving…' : 'Rename'}</button></div>
            : <p className="field-hint">Only owners can rename the workspace.</p>}
        </fieldset>
      </form>
    </section>
  );
}

function PasswordSettings({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const mismatch = confirm.length > 0 && next !== confirm;
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      await api('/v1/dashboard/me/password', { method: 'PUT', body: JSON.stringify({ current_password: current, new_password: next }) });
      setCurrent(''); setNext(''); setConfirm('');
      setMessage('Password changed. Your other sessions were signed out.'); onChanged();
    } catch (cause) { setError(errorMessage(cause, 'The password could not be changed.')); }
    finally { setBusy(false); }
  };
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2>Password</h2><p>At least 12 characters. Changing it signs out your other sessions.</p></div><span className="panel-icon"><LockKeyhole size={16} /></span></div>
      {message && <Banner tone="success" onDismiss={() => setMessage('')}>{message}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      <form className="form" onSubmit={(event) => void save(event)}>
        <label>Current password<input type="password" autoComplete="current-password" required value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
        <div className="form-row">
          <label className="grow">New password<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={next} onChange={(event) => setNext(event.target.value)} /></label>
          <label className="grow">Repeat new password<input type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
        </div>
        {mismatch && <p className="field-hint warning">The new passwords do not match.</p>}
        <div className="form-actions"><button className="primary-button" disabled={busy || mismatch || next.length < 12 || !current}>{busy ? 'Saving…' : 'Change password'}</button></div>
      </form>
    </section>
  );
}

/** A short, readable device name from a user agent string; the full string is in the tooltip. */
function deviceLabel(agent: string | null): string {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

function SessionSettings({ version }: { version: number }) {
  const load = useCallback(() => api<SessionRecord[]>('/v1/dashboard/me/sessions'), []);
  const { data, error, loading, reload } = useResource(load, 'Sessions could not be loaded.');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  useEffect(() => { if (version) void reload(); }, [version, reload]);
  const run = async (key: string, path: string, method: 'DELETE' | 'POST') => {
    setBusy(key); setActionError('');
    try { await api(path, { method }); await reload(); }
    catch (cause) { setActionError(errorMessage(cause, 'The session could not be signed out.')); }
    finally { setBusy(''); }
  };
  const others = data?.filter((item) => !item.current).length ?? 0;
  return (
    <section className="panel">
      <div className="panel-heading"><div><h2>Sessions</h2><p>Where you are signed in. Sessions end after eight hours.</p></div><span className="panel-icon"><MonitorSmartphone size={16} /></span></div>
      {(error || actionError) && <Banner tone="error" onDismiss={() => setActionError('')}>{error || actionError}</Banner>}
      {!data ? (loading && <Loading label="Loading sessions…" />) : (
        <ul className="event-list">
          {data.map((item) => (
            <li key={item.id}>
              <div><strong title={item.user_agent ?? undefined}>{deviceLabel(item.user_agent)}{item.current && <span className="badge tone-success session-badge"><i />This device</span>}</strong><span>{item.ip ?? 'Unknown IP'} · signed in {relativeTime(item.created_at)} · active {relativeTime(item.last_seen_at)}</span></div>
              {!item.current && <button className="secondary-button small" disabled={busy === item.id} onClick={() => void run(item.id, `/v1/dashboard/me/sessions/${item.id}`, 'DELETE')}>Sign out</button>}
            </li>
          ))}
        </ul>
      )}
      {others > 0 && <div className="form-actions"><button className="danger-button" disabled={busy === 'others'} onClick={() => void run('others', '/v1/dashboard/me/sessions/revoke-others', 'POST')}>Sign out {others} other {others === 1 ? 'session' : 'sessions'}</button></div>}
    </section>
  );
}

export function SettingsPage({ account, reload, session, logout, onRenamed }: { account: Account | null; reload: () => Promise<void>; session: DashboardSession; logout: () => Promise<void>; onRenamed: (name: string) => void }) {
  const [passwordVersion, setPasswordVersion] = useState(0);
  return <>
    <PageHeader title="Settings" description="Your workspace, notifications, password and sessions." />
    <section className="panel profile">
      <div className="avatar large">{(session.user.name ?? session.merchant.name).slice(0, 1).toUpperCase()}</div>
      <div className="profile-copy"><h2>{session.user.name ?? session.email}</h2><p>{session.email} · {ROLE_LABELS[session.user.role]} of {session.merchant.name}</p><span className="mono">Merchant {session.merchant.id}</span></div>
      <button className="secondary-button" onClick={() => void logout()}><LogOut size={14} />Sign out</button>
    </section>
    <WorkspaceSettings onRenamed={onRenamed} />
    <WebhookSettings account={account} reload={reload} />
    <PasswordSettings onChanged={() => setPasswordVersion((value) => value + 1)} />
    <SessionSettings version={passwordVersion} />
    <section className="panel">
      <div className="panel-heading"><div><h2>Security</h2><p>How this workspace protects your account.</p></div><span className="panel-icon"><ShieldCheck size={16} /></span></div>
      <ul className="check-list">
        <li><ShieldCheck size={15} />HTTP-only session cookie with CSRF protection on every change</li>
        <li><ShieldCheck size={15} />API keys and sessions stored only as hashes</li>
        <li><ShieldCheck size={15} />Webhook secrets encrypted at rest (AES-256-GCM)</li>
        <li><ShieldCheck size={15} />Public keys only: no private keys or seed phrases, ever</li>
        <li><ShieldCheck size={15} />Roles checked on the server for every change, and every change written to the audit log</li>
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

export function InviteScreen({ token, onJoined }: { token: string; onJoined: (session: DashboardSession) => void }) {
  const load = useCallback(() => api<{ merchant_name: string; email: string; role: DashboardSession['user']['role']; expires_at: string }>(`/v1/dashboard/invitations/${encodeURIComponent(token)}`), [token]);
  const { data, error, loading } = useResource(load, 'This invitation could not be loaded.');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setSubmitError('');
    try {
      onJoined(await api<DashboardSession>(`/v1/dashboard/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: JSON.stringify({ name: name.trim(), password }) }));
    } catch (cause) { setSubmitError(errorMessage(cause, 'The invitation could not be accepted.')); setBusy(false); }
  };
  return (
    <main className="login">
      <div className="login-planet" aria-hidden="true" />
      <section className="login-card">
        <div className="login-brand"><BrandLockup markSize={30} wordSize={15} /></div>
        {loading && !data ? <Loading label="Checking invitation…" /> : error || !data ? <>
          <h1>Invitation unavailable</h1>
          <p>{error || 'This invitation is invalid, expired or was already used.'} Ask the person who invited you for a new link.</p>
          <a className="primary-button wide" href="#/">Go to sign in</a>
        </> : <>
          <h1>Join {data.merchant_name}</h1>
          <p>You were invited as {ROLE_LABELS[data.role].toLowerCase()} with {data.email}.</p>
          <form className="form" onSubmit={(event) => void submit(event)}>
            <label>Your name<input autoComplete="name" required autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Password<input type="password" autoComplete="new-password" required minLength={12} maxLength={1024} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>Repeat password<input type="password" autoComplete="new-password" required value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
            {confirm.length > 0 && confirm !== password && <p className="field-hint warning">The passwords do not match.</p>}
            {submitError && <Banner tone="error">{submitError}</Banner>}
            <button className="primary-button wide" disabled={busy || password.length < 12 || password !== confirm || !name.trim()}>{busy ? 'Joining…' : 'Join workspace'}</button>
          </form>
        </>}
      </section>
      <p className="login-footer">Payments for every chain</p>
    </main>
  );
}
