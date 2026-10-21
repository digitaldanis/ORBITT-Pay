import { useCallback, useState } from 'react';
import { RefreshCw, RotateCw, Send, Webhook } from 'lucide-react';
import { api, errorMessage, type Account, type WebhookDelivery } from '../api.js';
import { dateLabel, relativeTime } from '../format.js';
import { Banner, EmptyState, Loading, PageHeader, StatusBadge, useResource } from '../ui.js';
import type { Page } from '../Dashboard.js';
import { useSession } from '../session.js';

export function WebhooksPage({ account, onOpenInvoice, go }: { account: Account | null; onOpenInvoice: (id: string) => void; go: (page: Page) => void }) {
  const { can } = useSession();
  const load = useCallback(() => api<WebhookDelivery[]>('/v1/dashboard/webhooks'), []);
  const { data, error, loading, reload } = useResource(load, 'Webhook deliveries could not be loaded.');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');

  const run = async (key: string, path: string, success: string) => {
    setBusy(key); setMessage(''); setActionError('');
    try { await api(path, { method: 'POST' }); setMessage(success); await reload(); }
    catch (cause) { setActionError(errorMessage(cause, 'The request failed.')); }
    finally { setBusy(''); }
  };

  const failed = data?.filter((delivery) => delivery.status === 'failed').length ?? 0;

  return <>
    <PageHeader title="Webhooks" description="Signed events for every invoice change, retried with backoff until your endpoint answers 2xx.">
      <button className="secondary-button" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : undefined} />Refresh</button>
      {can('developers') && <button className="primary-button" disabled={busy === 'test' || !account?.webhook.url} onClick={() => void run('test', '/v1/dashboard/webhooks/test', 'Test event queued.')}><Send size={14} />Send test event</button>}
    </PageHeader>
    {!account?.webhook.url && <Banner tone="warning">No endpoint configured yet. <button className="link-button" onClick={() => go('Settings')}>Add one in Settings</button>.</Banner>}
    {message && <Banner tone="success" onDismiss={() => setMessage('')}>{message}</Banner>}
    {(error || actionError) && <Banner tone="error" onDismiss={() => setActionError('')}>{error || actionError}</Banner>}
    {account?.webhook.url && <div className="summary-strip">
      <div><Webhook size={16} /><span className="mono">{account.webhook.url}</span></div>
      <div><strong>{data?.length ?? 0}</strong><span>recent deliveries</span></div>
      <div><strong className={failed ? 'warning-text' : undefined}>{failed}</strong><span>failed</span></div>
    </div>}
    <section className="panel">
      {!data ? (loading && <Loading label="Loading deliveries…" />) : !data.length ? <EmptyState icon={<Webhook size={18} />} title="No deliveries yet">Events appear here as soon as an invoice changes.</EmptyState> : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>Created</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {data.map((delivery) => (
                <tr key={delivery.id}>
                  <td><strong className="mono">{delivery.event}</strong>{delivery.invoice_id ? <button className="row-link" onClick={() => onOpenInvoice(delivery.invoice_id!)}>Invoice {delivery.invoice_id.slice(0, 8)}</button> : <small>Test event</small>}</td>
                  <td><StatusBadge status={delivery.status} />{delivery.next_attempt_at && <small>Next try {relativeTime(delivery.next_attempt_at)}</small>}</td>
                  <td>{delivery.attempts}</td>
                  <td>{delivery.http_status ? <span className={delivery.http_status < 300 ? 'success-text' : 'error-text'}>HTTP {delivery.http_status}</span> : '—'}{delivery.last_error && <small className="error-text" title={delivery.last_error}>{delivery.last_error.slice(0, 60)}</small>}</td>
                  <td className="date-cell" title={dateLabel(delivery.created_at)}>{relativeTime(delivery.created_at)}</td>
                  <td className="actions-cell">{!can('developers') ? null : delivery.status === 'failed'
                    ? <button className="secondary-button small" disabled={busy === delivery.id} onClick={() => void run(delivery.id, `/v1/dashboard/webhooks/${delivery.id}/redeliver`, 'Delivery queued again.')}><RotateCw size={13} />Retry</button>
                    : delivery.status === 'delivered' && <button className="icon-button" disabled={busy === delivery.id} onClick={() => void run(delivery.id, `/v1/dashboard/webhooks/${delivery.id}/redeliver`, 'Delivery queued again.')} aria-label="Send again" title="Send again"><RotateCw size={14} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
    <p className="quiet-note">Delivery is at least once. Verify the <code>ORBITT-Signature</code> header and deduplicate by the event ID.</p>
  </>;
}
