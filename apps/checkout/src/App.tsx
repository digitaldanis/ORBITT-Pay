import { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { buildPaymentUri } from './payment-uri.js';

type Status = 'created' | 'awaiting_payment' | 'detected' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'late_payment' | 'cancelled';

interface PublicInvoice {
  id: string;
  merchant_name: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string;
  crypto_amount_base_units: string;
  asset: string;
  network: string;
  address: string | null;
  status: Status;
  created_at: string;
  expires_at: string;
  success_url: string | null;
  cancel_url: string | null;
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const POLL_MS = 5_000;

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function statusText(status: Status): string {
  const labels: Record<Status, string> = {
    created: 'Preparing payment', awaiting_payment: 'Waiting for payment', detected: 'Payment detected',
    confirming: 'Confirming payment', paid: 'Payment complete', underpaid: 'Payment is short',
    overpaid: 'Payment exceeds amount', expired: 'Invoice expired', late_payment: 'Late payment received',
    cancelled: 'Invoice cancelled',
  };
  return labels[status];
}

function statusTone(status: Status): string {
  if (status === 'paid') return 'success';
  if (status === 'expired' || status === 'cancelled' || status === 'late_payment') return 'muted';
  if (status === 'underpaid' || status === 'overpaid') return 'warning';
  return 'active';
}

function Icon({ name }: { name: 'copy' | 'check' | 'lock' | 'orbit' }) {
  if (name === 'orbit') return <span className="orbit-mark" aria-hidden="true"><i /></span>;
  if (name === 'lock') return <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="3.2" y="7.4" width="11.6" height="8" rx="2" /><path d="M5.7 7.4V5.6a3.3 3.3 0 0 1 6.6 0v1.8M9 10.3v2.2" /></svg>;
  if (name === 'check') return <svg aria-hidden="true" viewBox="0 0 18 18"><path d="m3.7 9.2 3.5 3.4 7.1-7.2" /></svg>;
  return <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="6.3" y="6.3" width="8" height="8" rx="1.5" /><path d="M11.7 4.4V3.8a1.5 1.5 0 0 0-1.5-1.5H3.8a1.5 1.5 0 0 0-1.5 1.5v6.4a1.5 1.5 0 0 0 1.5 1.5h.7" /></svg>;
}

function Brand() {
  return <div className="brand"><Icon name="orbit" /><span className="brand-word">ORBITT <b>PAY</b></span></div>;
}

function CheckoutCard({ invoice, onRefresh }: { invoice: PublicInvoice; onRefresh: () => void }) {
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.ceil((new Date(invoice.expires_at).getTime() - Date.now()) / 1000)));
  const [copied, setCopied] = useState<'address' | 'amount' | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const closed = ['paid', 'expired', 'late_payment', 'cancelled'].includes(invoice.status);
  const isCountdown = !closed && secondsLeft > 0;
  const visibleStatus = secondsLeft === 0 && !closed && ['created', 'awaiting_payment'].includes(invoice.status) ? 'expired' : invoice.status;
  const progress = Math.max(0, Math.min(1, secondsLeft / Math.max(1, (new Date(invoice.expires_at).getTime() - new Date(invoice.created_at).getTime()) / 1000)));
  const paymentUri = useMemo(() => invoice.address ? buildPaymentUri({
    asset: invoice.asset, network: invoice.network, address: invoice.address,
    amount: invoice.crypto_amount, baseUnits: invoice.crypto_amount_base_units,
  }) : '', [invoice]);
  const canCancel = invoice.status === 'created' || invoice.status === 'awaiting_payment';

  useEffect(() => {
    const timer = window.setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((new Date(invoice.expires_at).getTime() - Date.now()) / 1000))), 1_000);
    return () => window.clearInterval(timer);
  }, [invoice.expires_at]);

  const copy = async (value: string, field: 'address' | 'amount') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(field);
      window.setTimeout(() => setCopied(null), 1_800);
    } catch {
      setCancelError('Copy is unavailable in this browser. Select and copy the value manually.');
    }
  };

  const cancel = async () => {
    setCanceling(true);
    setCancelError('');
    try {
      const response = await fetch(`${API_BASE}/v1/public/invoices/${invoice.id}/cancel`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json() as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'The invoice could not be cancelled.');
      }
      if (invoice.cancel_url) window.location.assign(invoice.cancel_url);
      else onRefresh();
    } catch (error) {
      setCancelError(error instanceof Error ? error.message : 'The invoice could not be cancelled.');
    } finally {
      setCanceling(false);
    }
  };

  const stage = invoice.status === 'paid' ? 3 : ['confirming'].includes(invoice.status) ? 2 : ['detected', 'underpaid', 'overpaid'].includes(invoice.status) ? 1 : 0;
  const amountTitle = invoice.crypto_amount;

  return (
    <article className="checkout-card" aria-live="polite">
      <header className="merchant-header">
        <div>
          <p className="merchant-label">Paying</p>
          <h1>{invoice.merchant_name}</h1>
          {invoice.order_id && <p className="order-reference">Order {invoice.order_id}</p>}
        </div>
        <div className={`status-pill ${statusTone(visibleStatus)}`}><span className="status-dot" />{statusText(visibleStatus)}</div>
      </header>

      <section className="amount-section" aria-label="Payment amount">
        <div className="amount-heading">
          <div>
            <p className="small-label">Send exactly</p>
            <div className="crypto-amount">{amountTitle}<span>{invoice.asset}</span></div>
            <p className="fiat-reference">Order total {invoice.request_amount} {invoice.request_currency}</p>
          </div>
          <div className={`countdown ${!isCountdown ? 'countdown-ended' : ''}`} aria-label={isCountdown ? `${formatTime(secondsLeft)} remaining` : 'Payment window ended'}>
            <svg viewBox="0 0 50 50" role="img" aria-hidden="true">
              <defs><linearGradient id="countdown-gradient"><stop stopColor="#7b5cfa" /><stop offset="1" stopColor="#4aa8f5" /></linearGradient></defs>
              <circle className="countdown-track" cx="25" cy="25" r="21" />
              <circle className="countdown-progress" cx="25" cy="25" r="21" style={{ strokeDashoffset: `${132 * (1 - progress)}` }} />
            </svg>
            <span>{isCountdown ? formatTime(secondsLeft) : '—'}</span>
          </div>
        </div>
        <button className="copy-row amount-copy" onClick={() => void copy(amountTitle, 'amount')}>
          <span>Exact amount</span><strong>{amountTitle} {invoice.asset}</strong>
          <span className="copy-action"><Icon name={copied === 'amount' ? 'check' : 'copy'} />{copied === 'amount' ? 'Copied' : 'Copy'}</span>
        </button>
      </section>

      <section className="qr-section" aria-label="Scan to pay">
        {invoice.address ? <div className="qr-frame"><QRCodeSVG value={paymentUri} size={218} level="M" bgColor="#ffffff" fgColor="#080b14" title={`Payment QR code for ${invoice.crypto_amount} ${invoice.asset}`} /></div>
          : <div className="qr-unavailable">Payment address is being prepared</div>}
        <p className="qr-caption">Scan with your wallet</p>
      </section>

      <section className="address-section" aria-label="Receiving address">
        <div className="section-heading"><h2>Payment address</h2><span>{invoice.network}</span></div>
        <div className="address-value" tabIndex={0} aria-label="Full receiving address">{invoice.address ?? 'Address unavailable'}</div>
        <button className="copy-row address-copy" disabled={!invoice.address} onClick={() => invoice.address && void copy(invoice.address, 'address')}>
          <span className="copy-action"><Icon name={copied === 'address' ? 'check' : 'copy'} />{copied === 'address' ? 'Copied' : 'Copy address'}</span>
          <span className="wallet-lock"><Icon name="lock" />Your funds go directly to the merchant</span>
        </button>
      </section>

      <div className="network-warning"><span aria-hidden="true">!</span><p>Send only on <strong>{invoice.network}</strong>. Transfers from another network may not be recoverable.</p></div>

      <section className="status-timeline" aria-label="Payment progress">
        {['Waiting', 'Detected', 'Confirming', 'Paid'].map((label, index) => (
          <div className={`timeline-step ${index <= stage ? 'is-active' : ''} ${invoice.status === 'paid' && index === 3 ? 'is-complete' : ''}`} key={label}>
            <span className="timeline-dot">{invoice.status === 'paid' && index === 3 ? <Icon name="check" /> : null}</span><span>{label}</span>
          </div>
        ))}
      </section>

      {invoice.status === 'expired' && <p className="notice-text">This quote has expired. Contact the shop if you already sent a payment.</p>}
      {secondsLeft === 0 && !closed && <p className="notice-text">This quote has expired. Contact the shop if you already sent a payment.</p>}
      {invoice.status === 'underpaid' && <p className="notice-text">A payment was detected below the quoted amount. The shop is checking the transfer.</p>}
      {invoice.status === 'overpaid' && <p className="notice-text">The payment was above the quoted amount. The shop will review the surplus.</p>}
      {invoice.status === 'late_payment' && <p className="notice-text">A payment arrived after this invoice expired. Contact the shop to resolve it.</p>}
      {invoice.status === 'paid' && invoice.success_url && <a className="continue-button" href={invoice.success_url}>Continue to {invoice.merchant_name}</a>}
      {canCancel && <button className="cancel-link" disabled={canceling} onClick={() => void cancel()}>{canceling ? 'Cancelling…' : 'Cancel payment'}</button>}
      {cancelError && <p className="inline-error" role="alert">{cancelError}</p>}
      <p className="auto-refresh"><span className="refresh-pulse" />Status updates automatically</p>
    </article>
  );
}

export function Checkout() {
  const invoiceId = window.location.pathname.match(/\/checkout\/([0-9a-f-]{36})\/?$/i)?.[1];
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!invoiceId) { setError('This checkout link is invalid.'); setLoading(false); return; }
    try {
      const response = await fetch(`${API_BASE}/v1/public/invoices/${invoiceId}`, { headers: { accept: 'application/json' } });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? 'This invoice could not be loaded.');
      }
      const nextInvoice = await response.json() as PublicInvoice;
      setInvoice(nextInvoice);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This invoice could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(poll);
  }, [refresh]);

  return (
    <main className="checkout-page">
      <div className="ambient-glow" aria-hidden="true" />
      <header className="page-brand"><Brand /><span className="secure-label"><Icon name="lock" />Secure checkout</span></header>
      {loading && <section className="checkout-card loading-card" aria-label="Loading invoice"><span className="loading-ring" /><p>Loading your payment details…</p></section>}
      {!loading && error && <section className="checkout-card error-card" role="alert"><span className="error-mark">!</span><h1>Checkout unavailable</h1><p>{error}</p><button className="retry-button" onClick={() => { setLoading(true); void refresh(); }}>Try again</button></section>}
      {!loading && !error && invoice && <CheckoutCard invoice={invoice} onRefresh={() => void refresh()} />}
      <footer className="page-footer"><span>Payments for every chain</span><span>Powered by <strong>ORBITT PAY</strong></span></footer>
    </main>
  );
}
