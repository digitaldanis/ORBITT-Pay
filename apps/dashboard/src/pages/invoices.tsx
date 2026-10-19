import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowUpRight, ChevronRight, CreditCard, ExternalLink, Link2, Plus, RefreshCw, RotateCw, Search } from 'lucide-react';
import { CoinIcon, explorerTransactionUrl } from '@orbitt/ui';
import { api, errorMessage, type Invoice, type InvoiceDetail, type InvoiceStatus } from '../api.js';
import { dateLabel, formatFiat, middleTruncate, relativeTime } from '../format.js';
import { Banner, CopyButton, DetailRow, Drawer, EmptyState, Loading, Modal, PageHeader, StatusBadge, useResource } from '../ui.js';
import { useCatalog } from '../catalog.js';

export function InvoiceTable({ invoices, onOpen, compact = false }: { invoices: Invoice[]; onOpen: (id: string) => void; compact?: boolean }) {
  const { networkName } = useCatalog();
  if (!invoices.length) {
    return <EmptyState icon={<CreditCard size={18} />} title="No invoices yet">Create a payment link or call the API to see activity here.</EmptyState>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>Order</th><th>Amount</th><th className="hide-sm">Paid with</th><th>Status</th><th className="hide-sm">{compact ? 'Updated' : 'Created'}</th><th className="hide-sm" aria-label="Open" /></tr></thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} tabIndex={0} className="clickable" onClick={() => onOpen(invoice.id)} onKeyDown={(event) => { if (event.key === 'Enter') onOpen(invoice.id); }}>
              <td className="nowrap"><strong>{invoice.order_id || 'No order ID'}</strong><small className="mono">{invoice.id.slice(0, 8)}</small></td>
              <td><strong>{formatFiat(invoice.amount, invoice.currency)}</strong>{invoice.crypto_amount && <small className="mono">{invoice.crypto_amount} {invoice.asset}</small>}</td>
              <td className="hide-sm">{invoice.asset && invoice.network
                ? <span className="coin-cell"><CoinIcon asset={invoice.asset} network={invoice.network} size={24} /><span>{invoice.asset}<small>{networkName(invoice.network)}</small></span></span>
                : <span className="muted">Customer chooses</span>}</td>
              <td><StatusBadge status={invoice.status} /></td>
              <td className="date-cell hide-sm" title={dateLabel(compact ? invoice.updated_at : invoice.created_at)}>{relativeTime(compact ? invoice.updated_at : invoice.created_at)}</td>
              <td className="chevron-cell hide-sm"><ChevronRight size={16} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FILTERS: Array<{ label: string; status: InvoiceStatus | '' }> = [
  { label: 'All', status: '' }, { label: 'Open', status: 'awaiting_payment' }, { label: 'Paid', status: 'paid' },
  { label: 'Underpaid', status: 'underpaid' }, { label: 'Late', status: 'late_payment' }, { label: 'Expired', status: 'expired' },
];

export function InvoicesPage({ paidOnly = false, onOpen, refreshKey }: { paidOnly?: boolean; onOpen: (id: string) => void; refreshKey: number }) {
  const [status, setStatus] = useState<InvoiceStatus | ''>(paidOnly ? 'paid' : '');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Invoice[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const fetchPage = useCallback(async (after: string | null) => {
    const query = new URLSearchParams({ limit: '25' });
    if (status) query.set('status', status);
    if (search) query.set('search', search);
    if (after) query.set('cursor', after);
    return api<{ data: Invoice[]; next_cursor: string | null }>(`/v1/dashboard/invoices?${query}`);
  }, [status, search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    fetchPage(null)
      .then((page) => { if (!cancelled) { setItems(page.data); setCursor(page.next_cursor); } })
      .catch((cause: unknown) => { if (!cancelled) setError(errorMessage(cause, 'Invoices could not be loaded.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchPage, refreshKey]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setItems((current) => [...current, ...page.data]); setCursor(page.next_cursor);
    } catch (cause) { setError(errorMessage(cause, 'More invoices could not be loaded.')); }
    finally { setLoadingMore(false); }
  };

  return <>
    <PageHeader title={paidOnly ? 'Payments' : 'Invoices'} description={paidOnly ? 'Completed payments received by your store.' : 'Every payment request, from created to confirmed on chain.'}>
      {!paidOnly && <button className="primary-button" onClick={() => setCreating(true)}><Plus size={15} />New payment link</button>}
    </PageHeader>
    <section className="panel">
      <div className="toolbar">
        <label className="search-field">
          <Search size={15} />
          <span className="visually-hidden">Search invoices</span>
          <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search order ID, invoice ID or address" />
        </label>
        {!paidOnly && <div className="segmented" role="tablist" aria-label="Filter by status">
          {FILTERS.map((filter) => <button key={filter.label} role="tab" aria-selected={status === filter.status} className={status === filter.status ? 'selected' : ''} onClick={() => setStatus(filter.status)}>{filter.label}</button>)}
        </div>}
      </div>
      {error ? <Banner tone="error">{error}</Banner> : loading ? <Loading label="Loading invoices…" /> : <InvoiceTable invoices={items} onOpen={onOpen} />}
      {cursor && !loading && <div className="table-footer"><button className="secondary-button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
    </section>
    {creating && <CreateLinkModal onClose={() => setCreating(false)} onCreated={(invoice) => setItems((current) => [invoice, ...current])} />}
  </>;
}

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];

export function CreateLinkModal({ onClose, onCreated }: { onClose: () => void; onCreated: (invoice: Invoice) => void }) {
  const { assets } = useCatalog();
  const available = useMemo(() => assets.filter((asset) => asset.available), [assets]);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [orderId, setOrderId] = useState('');
  const [coin, setCoin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Invoice | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    const [asset, network] = coin ? coin.split(':') : [];
    try {
      const invoice = await api<Invoice>('/v1/dashboard/invoices', {
        method: 'POST',
        body: JSON.stringify({ amount: amount.trim().replace(',', '.'), currency, ...(orderId.trim() ? { order_id: orderId.trim() } : {}), ...(asset && network ? { asset, network } : {}) }),
      });
      setCreated(invoice); onCreated(invoice);
    } catch (cause) { setError(errorMessage(cause, 'The payment link could not be created.')); }
    finally { setBusy(false); }
  };

  if (created) {
    return (
      <Modal title="Payment link ready" description="Share it with your customer. The price locks when they choose a coin." onClose={onClose}>
        <div className="link-result">
          <div className="link-amount">{formatFiat(created.amount, created.currency)}</div>
          <div className="link-box"><Link2 size={15} /><span className="mono">{created.checkout_url}</span></div>
          <div className="modal-actions">
            <button className="secondary-button" onClick={() => { setCreated(null); setAmount(''); setOrderId(''); }}>Create another</button>
            <CopyButton value={created.checkout_url} label="Copy link" />
            <a className="primary-button" href={created.checkout_url} target="_blank" rel="noreferrer">Open checkout <ArrowUpRight size={14} /></a>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="New payment link" description="A hosted checkout page for a one-off payment." onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <div className="form-row">
          <label className="grow">Amount<input inputMode="decimal" autoFocus required value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="49.90" pattern="^\d+([.,]\d{1,8})?$" /></label>
          <label>Currency<select value={currency} onChange={(event) => setCurrency(event.target.value)}>{CURRENCIES.map((item) => <option key={item}>{item}</option>)}</select></label>
        </div>
        <label>Order ID <span className="optional">optional</span><input value={orderId} maxLength={255} onChange={(event) => setOrderId(event.target.value)} placeholder="ORD-1044" /></label>
        <label>Coin
          <select value={coin} onChange={(event) => setCoin(event.target.value)}>
            <option value="">Customer chooses at checkout</option>
            {available.map((asset) => <option key={`${asset.asset}:${asset.network}`} value={`${asset.asset}:${asset.network}`}>{asset.name} ({asset.asset}) · {asset.network_name}</option>)}
          </select>
        </label>
        {!available.length && <p className="field-hint warning">No coin can be invoiced yet. Add a receiving wallet under Assets first.</p>}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !available.length}>{busy ? 'Creating…' : 'Create link'}</button>
        </div>
      </form>
    </Modal>
  );
}

function amountDiffers(value: string): boolean { return !/^0(\.0*)?$/.test(value); }

export function InvoiceDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { networkName, find } = useCatalog();
  const load = useCallback(() => api<InvoiceDetail>(`/v1/dashboard/invoices/${id}`), [id]);
  const { data, error, loading, reload } = useResource(load, 'The invoice could not be loaded.');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');

  const cancel = async () => {
    if (!window.confirm('Cancel this invoice? The checkout link stops accepting payments.')) return;
    setBusy('cancel'); setActionError('');
    try { await api(`/v1/dashboard/invoices/${id}/cancel`, { method: 'POST' }); await reload(); onChanged(); }
    catch (cause) { setActionError(errorMessage(cause, 'The invoice could not be cancelled.')); }
    finally { setBusy(''); }
  };
  const redeliver = async (deliveryId: string) => {
    setBusy(deliveryId); setActionError('');
    try { await api(`/v1/dashboard/webhooks/${deliveryId}/redeliver`, { method: 'POST' }); await reload(); }
    catch (cause) { setActionError(errorMessage(cause, 'The webhook could not be queued again.')); }
    finally { setBusy(''); }
  };

  const invoice = data?.invoice;
  const asset = invoice?.asset && invoice.network ? find(invoice.asset, invoice.network) : undefined;
  const cancellable = invoice && ['created', 'awaiting_payment'].includes(invoice.status) && !amountDiffers(invoice.received_amount);

  return (
    <Drawer title={invoice?.order_id || 'Invoice'} subtitle={<span className="mono">{id}</span>} onClose={onClose}>
      {error ? <Banner tone="error">{error}</Banner> : !invoice ? (loading && <Loading label="Loading invoice…" />) : <>
        <section className="drawer-hero">
          <div>
            <span className="hero-label">Order total</span>
            <strong className="hero-amount">{formatFiat(invoice.amount, invoice.currency)}</strong>
            {invoice.crypto_amount && invoice.asset && <span className="hero-crypto mono">{invoice.crypto_amount} {invoice.asset}</span>}
          </div>
          <StatusBadge status={invoice.status} />
        </section>
        {invoice.asset && invoice.network && (
          <div className="pay-method">
            <CoinIcon asset={invoice.asset} network={invoice.network} size={34} />
            <div><strong>{asset?.name ?? invoice.asset}</strong><span>{networkName(invoice.network)}{asset?.address_mode === 'shared' ? ' · matched by exact amount' : ''}</span></div>
          </div>
        )}
        {actionError && <Banner tone="error" onDismiss={() => setActionError('')}>{actionError}</Banner>}

        <h3 className="section-title">Details</h3>
        <div className="detail-list">
          <DetailRow label="Checkout link"><span className="inline-actions"><a href={invoice.checkout_url} target="_blank" rel="noreferrer">Open <ExternalLink size={12} /></a><CopyButton compact value={invoice.checkout_url} label="Copy checkout link" /></span></DetailRow>
          {invoice.address && <DetailRow label="Address" mono><span className="inline-actions"><span title={invoice.address}>{middleTruncate(invoice.address, 10, 8)}</span><CopyButton compact value={invoice.address} label="Copy address" /></span></DetailRow>}
          {invoice.exchange_rate && invoice.asset && <DetailRow label="Rate">1 {invoice.asset} = {formatFiat(invoice.exchange_rate, invoice.currency)}</DetailRow>}
          {invoice.asset && <DetailRow label="Received" mono>{invoice.received_amount} {invoice.asset}</DetailRow>}
          {amountDiffers(invoice.surplus_amount) && <DetailRow label="Surplus" mono>{invoice.surplus_amount} {invoice.asset}</DetailRow>}
          <DetailRow label="Created">{dateLabel(invoice.created_at)}</DetailRow>
          <DetailRow label={new Date(invoice.expires_at) < new Date() ? 'Expired' : 'Expires'}>{dateLabel(invoice.expires_at)}</DetailRow>
          <DetailRow label="Last update">{dateLabel(invoice.updated_at)}</DetailRow>
        </div>

        <h3 className="section-title">On-chain payments <span className="count">{data.payments.length}</span></h3>
        {!data.payments.length ? <p className="muted small-text">No transfer seen yet. The scanner checks every network continuously.</p> : (
          <ul className="event-list">
            {data.payments.map((payment) => {
              const explorer = invoice.network ? explorerTransactionUrl(invoice.network, payment.transaction_id) : null;
              return (
                <li key={payment.transaction_id}>
                  <div><strong className="mono">{payment.amount} {payment.asset}</strong><span>{payment.confirmations} confirmations · {relativeTime(payment.observed_at)}</span></div>
                  {explorer ? <a className="secondary-button small" href={explorer} target="_blank" rel="noreferrer">{middleTruncate(payment.transaction_id, 6, 4)} <ExternalLink size={12} /></a> : <span className="mono small-text">{middleTruncate(payment.transaction_id, 6, 4)}</span>}
                </li>
              );
            })}
          </ul>
        )}

        <h3 className="section-title">Webhooks <span className="count">{data.webhooks.length}</span></h3>
        {!data.webhooks.length ? <p className="muted small-text">No events sent for this invoice yet.</p> : (
          <ul className="event-list">
            {data.webhooks.map((delivery) => (
              <li key={delivery.id}>
                <div><strong>{delivery.event}</strong><span>{delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}{delivery.http_status ? ` · HTTP ${delivery.http_status}` : ''} · {relativeTime(delivery.created_at)}</span>{delivery.last_error && <span className="error-text">{delivery.last_error}</span>}</div>
                <div className="inline-actions">
                  <StatusBadge status={delivery.status} />
                  {delivery.status !== 'pending' && <button className="icon-button" disabled={busy === delivery.id} onClick={() => void redeliver(delivery.id)} aria-label="Send again" title="Send again"><RotateCw size={14} /></button>}
                </div>
              </li>
            ))}
          </ul>
        )}

        {Object.keys(invoice.metadata).length > 0 && <>
          <h3 className="section-title">Metadata</h3>
          <pre className="code-block">{JSON.stringify(invoice.metadata, null, 2)}</pre>
        </>}

        <div className="drawer-actions">
          <button className="secondary-button" onClick={() => void reload()} disabled={loading}><RefreshCw size={14} className={loading ? 'spin' : undefined} />Refresh</button>
          {cancellable && <button className="danger-button" disabled={busy === 'cancel'} onClick={() => void cancel()}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel invoice'}</button>}
        </div>
      </>}
    </Drawer>
  );
}
