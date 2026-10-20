import { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api, errorMessage, type AuditEntry, type AuditVerification } from '../api.js';
import { dateLabel, relativeTime } from '../format.js';
import { Banner, EmptyState, Loading, PageHeader, useResource } from '../ui.js';

const ACTION_LABELS: Record<string, string> = {
  'user.signed_in': 'Signed in',
  'user.sign_in_failed': 'Failed sign-in',
  'user.signed_out': 'Signed out',
  'api_key.created': 'API key created',
  'api_key.revoked': 'API key revoked',
  'wallet.added': 'Wallet added',
  'wallet.replaced': 'Wallet key replaced',
  'wallet.removed': 'Wallet removed',
  'webhook.updated': 'Webhook endpoint changed',
  'webhook.secret_rotated': 'Webhook secret rotated',
  'webhook.test_sent': 'Test webhook sent',
  'webhook.redelivered': 'Webhook sent again',
  'invoice.created': 'Payment link created',
  'invoice.cancelled': 'Invoice cancelled',
};

const FILTERS: Array<{ label: string; action: string }> = [
  { label: 'All', action: '' }, { label: 'Sign-ins', action: 'user' }, { label: 'API keys', action: 'api_key' },
  { label: 'Wallets', action: 'wallet' }, { label: 'Webhooks', action: 'webhook' }, { label: 'Invoices', action: 'invoice' },
];

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** One line of context per action, built only from fields the API stores for it. */
function summary(entry: AuditEntry): string {
  const details = entry.details;
  const text = (key: string) => typeof details[key] === 'string' ? details[key] : '';
  switch (entry.action) {
    case 'api_key.created': case 'api_key.revoked': return `${text('name')} · ${text('key_prefix')}…`;
    case 'wallet.added': case 'wallet.replaced': return `${text('asset')} on ${text('network')} · ${text('public_key_hint')}`;
    case 'wallet.removed': return `${text('asset')} on ${text('network')}`;
    case 'webhook.updated': return text('url') || 'Endpoint removed';
    case 'webhook.test_sent': return text('url');
    case 'webhook.redelivered': return text('event');
    case 'invoice.created': return `${text('amount')} ${text('currency')}${text('order_id') ? ` · ${text('order_id')}` : ''}`;
    case 'invoice.cancelled': return text('order_id') || (entry.target?.id.slice(0, 8) ?? '');
    case 'user.sign_in_failed': return text('reason') === 'disabled' ? 'Account disabled' : 'Wrong password';
    default: return '';
  }
}

function actorLabel(entry: AuditEntry): string {
  if (entry.actor.type === 'system') return 'System';
  return entry.actor.label ?? (entry.actor.type === 'api_key' ? 'API key' : 'User');
}

function ChainStatus() {
  const load = useCallback(() => api<AuditVerification>('/v1/dashboard/audit-log/verify'), []);
  const { data, error, loading, reload } = useResource(load, 'The audit log could not be verified.');
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return null;
  return (
    <div className={`chain-status${data.intact ? '' : ' broken'}`}>
      {data.intact ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
      <span>{data.intact
        ? `Hash chain intact · ${data.entries.toLocaleString()} ${data.entries === 1 ? 'entry' : 'entries'} verified`
        : `Hash chain broken at entry ${data.broken_at}. Entries from there on may have been altered outside ORBITT PAY.`}</span>
      <button className="icon-button" onClick={() => void reload()} disabled={loading} aria-label="Verify again" title="Verify again"><RefreshCw size={14} className={loading ? 'spin' : undefined} /></button>
    </div>
  );
}

export function ActivityPage({ onOpenInvoice }: { onOpenInvoice: (id: string) => void }) {
  const [action, setAction] = useState('');
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const fetchPage = useCallback(async (after: string | null) => {
    const query = new URLSearchParams({ limit: '50' });
    if (action) query.set('action', action);
    if (after) query.set('cursor', after);
    return api<{ data: AuditEntry[]; next_cursor: string | null }>(`/v1/dashboard/audit-log?${query}`);
  }, [action]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    fetchPage(null)
      .then((page) => { if (!cancelled) { setItems(page.data); setCursor(page.next_cursor); } })
      .catch((cause: unknown) => { if (!cancelled) setError(errorMessage(cause, 'Activity could not be loaded.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchPage]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((current) => [...current, ...page.data]); setCursor(page.next_cursor);
    } catch (cause) { setError(errorMessage(cause, 'More activity could not be loaded.')); }
    finally { setLoadingMore(false); }
  };

  return <>
    <PageHeader title="Activity" description="Every change to keys, wallets, webhooks and sign-ins, in an append-only log." />
    <ChainStatus />
    <section className="panel">
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Filter by area">
          {FILTERS.map((filter) => <button key={filter.label} role="tab" aria-selected={action === filter.action} className={action === filter.action ? 'selected' : ''} onClick={() => setAction(filter.action)}>{filter.label}</button>)}
        </div>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : loading ? <Loading label="Loading activity…" /> : !items.length
        ? <EmptyState icon={<History size={18} />} title="No activity yet">Changes made in the dashboard or through the API appear here.</EmptyState>
        : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Action</th><th>By</th><th className="hide-sm">From</th><th>When</th></tr></thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong className={entry.action === 'user.sign_in_failed' ? 'warning-text' : undefined}>{actionLabel(entry.action)}</strong>
                      {entry.target?.type === 'invoice'
                        ? <button className="row-link" onClick={() => onOpenInvoice(entry.target!.id)}>{summary(entry) || `Invoice ${entry.target.id.slice(0, 8)}`}</button>
                        : summary(entry) && <small className="mono">{summary(entry)}</small>}
                    </td>
                    <td><span>{actorLabel(entry)}</span><small>{entry.actor.type === 'api_key' ? 'API key' : entry.actor.type === 'user' ? 'Dashboard' : 'Automatic'}</small></td>
                    <td className="hide-sm mono">{entry.ip ?? '—'}</td>
                    <td className="date-cell" title={dateLabel(entry.created_at)}>{relativeTime(entry.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      {cursor && !loading && <div className="table-footer"><button className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
    </section>
  </>;
}
