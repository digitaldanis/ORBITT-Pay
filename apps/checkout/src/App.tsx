import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { BrandLockup, CoinIcon, OrbitMark } from '@orbitt/ui';
import { buildPaymentUri, toBaseUnits } from './payment-uri.js';
import { format, formatFiat, t } from './i18n.js';

type Status = 'created' | 'awaiting_payment' | 'detected' | 'confirming' | 'paid' | 'underpaid' | 'overpaid' | 'expired' | 'late_payment' | 'cancelled';

interface PaymentOption {
  asset: string;
  network: string;
  name: string;
  network_name: string;
  decimals: number;
  contract: string | null;
}

export interface PublicInvoice {
  id: string;
  merchant_name: string;
  order_id: string | null;
  request_amount: string;
  request_currency: string;
  crypto_amount: string | null;
  crypto_amount_base_units: string | null;
  asset: string | null;
  asset_name: string | null;
  asset_decimals: number | null;
  network: string | null;
  network_name: string | null;
  token_contract: string | null;
  address: string | null;
  address_mode: 'derived' | 'shared';
  received_amount: string;
  remaining_amount: string;
  status: Status;
  created_at: string;
  expires_at: string;
  success_url: string | null;
  cancel_url: string | null;
  payment_options: PaymentOption[];
}

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
const IN_PROGRESS: readonly Status[] = ['awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid'];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const rest = (seconds % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

function Icon({ name }: { name: 'copy' | 'check' | 'lock' | 'wallet' | 'back' | 'chevron' | 'alert' | 'clock' }) {
  const paths: Record<typeof name, ReactElement> = {
    copy: <><rect x="7" y="7" width="9.5" height="9.5" rx="2" /><path d="M13 4.5V4a1.8 1.8 0 0 0-1.8-1.8H4A1.8 1.8 0 0 0 2.2 4v7.2A1.8 1.8 0 0 0 4 13h.5" /></>,
    check: <path d="m4 10.2 3.8 3.7L16 5.8" />,
    lock: <><rect x="3.6" y="8.3" width="12.8" height="9" rx="2.2" /><path d="M6.4 8.3V6.2a3.6 3.6 0 0 1 7.2 0v2.1" /></>,
    wallet: <><rect x="2.5" y="5" width="15" height="11.5" rx="2.4" /><path d="M2.5 8.5h15M13.5 12.2h1" /></>,
    back: <path d="M12.5 4 6.5 10l6 6" />,
    chevron: <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />,
    alert: <><path d="M10 6.5v4.5M10 13.8v.2" /><circle cx="10" cy="10" r="7.6" /></>,
    clock: <><circle cx="10" cy="10" r="7.6" /><path d="M10 5.8V10l2.8 1.8" /></>,
  };
  return <svg className="icon" viewBox="0 0 20 20" aria-hidden="true">{paths[name]}</svg>;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');
  const copy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setError('');
      window.setTimeout(() => setCopied((current) => current === key ? null : current), 1_600);
    } catch {
      setError(t.copyUnavailable);
    }
  };
  return { copied, error, copy };
}

function useCountdown(expiresAt: string): number {
  const [seconds, setSeconds] = useState(() => secondsUntil(expiresAt));
  useEffect(() => {
    setSeconds(secondsUntil(expiresAt));
    const timer = window.setInterval(() => setSeconds(secondsUntil(expiresAt)), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return seconds;
}

function Header({ invoice, status }: { invoice: PublicInvoice; status: Status }) {
  const tone = status === 'paid' ? 'success' : ['underpaid', 'overpaid', 'late_payment'].includes(status) ? 'warning' : ['expired', 'cancelled'].includes(status) ? 'muted' : 'active';
  return (
    <header className="card-header">
      <div className="merchant">
        <span className="merchant-avatar" aria-hidden="true">{invoice.merchant_name.slice(0, 1).toUpperCase()}</span>
        <div className="merchant-text">
          <p className="eyebrow">{t.paying}</p>
          <h1>{invoice.merchant_name}</h1>
          <div className="merchant-meta">
            <span className={`status-pill ${tone}`}><span className="status-dot" />{t.status[status]}</span>
            {invoice.order_id && <span className="order">{t.order} {invoice.order_id}</span>}
          </div>
        </div>
      </div>
    </header>
  );
}

interface AssetGroup { asset: string; name: string; options: PaymentOption[] }

function CoinPicker({ invoice, onSelected }: { invoice: PublicInvoice; onSelected: (next: PublicInvoice) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const groups = useMemo(() => {
    const map = new Map<string, AssetGroup>();
    for (const option of invoice.payment_options) {
      const group = map.get(option.asset) ?? { asset: option.asset, name: option.name, options: [] };
      group.options.push(option);
      map.set(option.asset, group);
    }
    return [...map.values()];
  }, [invoice.payment_options]);

  const choose = async (option: PaymentOption) => {
    const key = `${option.asset}:${option.network}`;
    setBusy(key);
    setError('');
    try {
      onSelected(await request<PublicInvoice>(`/v1/public/invoices/${invoice.id}/payment`, { method: 'POST', body: JSON.stringify({ asset: option.asset, network: option.network }) }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The payment method could not be selected.');
      setBusy(null);
    }
  };

  return (
    <>
      <section className="total">
        <p className="eyebrow">{t.orderTotal}</p>
        <p className="total-amount">{formatFiat(invoice.request_amount, invoice.request_currency)}</p>
      </section>
      <section className="picker" aria-label={t.chooseTitle}>
        <h2>{t.chooseTitle}</h2>
        <p className="hint">{t.chooseHint}</p>
        {!groups.length && <p className="notice">{t.noOptions}</p>}
        <ul className="coin-list">
          {groups.map((group) => {
            const single = group.options.length === 1 ? group.options[0]! : null;
            const expanded = open === group.asset;
            return (
              <li key={group.asset} className={`coin-row${expanded ? ' is-open' : ''}`}>
                <button
                  className="coin-button"
                  disabled={busy !== null}
                  aria-expanded={single ? undefined : expanded}
                  onClick={() => single ? void choose(single) : setOpen(expanded ? null : group.asset)}
                >
                  <CoinIcon asset={group.asset} network={single?.network ?? null} size={38} />
                  <span className="coin-text">
                    <strong>{group.name}</strong>
                    <span>{group.asset}{single ? ` · ${single.network_name}` : ` · ${group.options.length} ${t.networks}`}</span>
                  </span>
                  {busy?.startsWith(`${group.asset}:`) ? <span className="spinner" /> : <span className={`chevron${expanded ? ' is-open' : ''}`}><Icon name="chevron" /></span>}
                </button>
                {!single && expanded && (
                  <div className="network-options" role="group" aria-label={t.selectNetwork}>
                    {group.options.map((option) => (
                      <button key={option.network} className="network-chip" disabled={busy !== null} onClick={() => void choose(option)}>
                        <CoinIcon asset={group.asset} network={option.network} size={22} />
                        {option.network_name}
                        {busy === `${option.asset}:${option.network}` && <span className="spinner small" />}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {busy && <p className="preparing" role="status"><OrbitMark size={18} spinning />{t.preparing}</p>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </section>
    </>
  );
}

function qrLogo(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#fff"/><defs><linearGradient id="g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#4ab4f8"/></linearGradient></defs><path d="M40.94 22.52A17 17 0 1 1 28.4 7.58" fill="none" stroke="url(#g)" stroke-width="4.4" stroke-linecap="round"/><circle cx="37.02" cy="13.07" r="3.7" fill="#3f9df0"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function PaymentCard({ invoice, onRefresh }: { invoice: PublicInvoice; onRefresh: () => void }) {
  const seconds = useCountdown(invoice.expires_at);
  const { copied, error: copyError, copy } = useCopy();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const totalSeconds = useRef(Math.max(1, secondsUntil(invoice.expires_at)));
  const partial = invoice.status === 'underpaid';
  const amount = partial ? invoice.remaining_amount : invoice.crypto_amount!;
  const asset = invoice.asset!;
  const waiting = invoice.status === 'awaiting_payment' || partial;
  const timedOut = waiting && seconds === 0;
  const status: Status = timedOut ? 'expired' : invoice.status;
  const uri = useMemo(() => {
    if (!invoice.address || invoice.asset_decimals === null) return '';
    return buildPaymentUri({
      asset, network: invoice.network!, address: invoice.address, amount,
      baseUnits: toBaseUnits(amount, invoice.asset_decimals), tokenContract: invoice.token_contract,
    });
  }, [invoice, amount, asset]);
  const deepLink = /^[a-z]+:/.test(uri) ? uri : null;
  const stage = invoice.status === 'paid' ? 3 : invoice.status === 'confirming' || invoice.status === 'overpaid' ? 2 : ['detected', 'underpaid'].includes(invoice.status) ? 1 : 0;
  const canCancel = invoice.status === 'awaiting_payment' && invoice.received_amount === '0' && !timedOut;

  const cancel = async () => {
    setCancelling(true);
    setError('');
    try {
      await request(`/v1/public/invoices/${invoice.id}/cancel`, { method: 'POST' });
      if (invoice.cancel_url) window.location.assign(invoice.cancel_url);
      else onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The payment could not be cancelled.');
      setCancelling(false);
    }
  };

  return (
    <>
      <Header invoice={invoice} status={status} />
      <section className="amount-block" aria-label={t.amount}>
        <div className="amount-main">
          <CoinIcon asset={asset} network={invoice.network} size={44} />
          <div>
            <p className="eyebrow">{partial ? t.sendRemaining : t.sendExactly}</p>
            <p className="crypto-amount"><span className="value">{amount}</span> <span className="ticker">{asset}</span></p>
            <p className="fiat">{t.orderTotal} {formatFiat(invoice.request_amount, invoice.request_currency)} · {invoice.network_name}</p>
          </div>
        </div>
        {waiting && (
          <div className={`countdown${seconds < 120 ? ' is-low' : ''}`} role="timer" aria-label={`${t.timeLeft} ${clock(seconds)}`}>
            <svg viewBox="0 0 44 44" aria-hidden="true">
              <circle className="track" cx="22" cy="22" r="19" />
              <circle className="progress" cx="22" cy="22" r="19" pathLength="100" style={{ strokeDashoffset: 100 - Math.min(100, (seconds / totalSeconds.current) * 100) }} />
            </svg>
            <span>{clock(seconds)}</span>
          </div>
        )}
      </section>

      {timedOut ? <p className="notice">{t.expiredText}</p> : (
        <>
          <section className="qr-block">
            <div className="qr-frame">
              {uri && <QRCodeSVG value={uri} size={208} level="H" marginSize={0} bgColor="#ffffff" fgColor="#0a0d18" imageSettings={{ src: qrLogo(), height: 40, width: 40, excavate: true }} title={`${amount} ${asset}`} />}
            </div>
            <p className="caption">{t.scanWithWallet}</p>
            {deepLink && <a className="wallet-button" href={deepLink}><Icon name="wallet" />{t.openWallet}</a>}
          </section>

          <section className="fields">
            <button className="field" onClick={() => void copy(amount, 'amount')}>
              <span className="field-label">{t.amount}</span>
              <span className="field-value mono">{amount} {asset}</span>
              <span className={`field-action${copied === 'amount' ? ' is-done' : ''}`}><Icon name={copied === 'amount' ? 'check' : 'copy'} />{copied === 'amount' ? t.copied : t.copy}</span>
            </button>
            <button className="field" onClick={() => invoice.address && void copy(invoice.address, 'address')}>
              <span className="field-label">{t.address}</span>
              <span className="field-value mono address">{invoice.address}</span>
              <span className={`field-action${copied === 'address' ? ' is-done' : ''}`}><Icon name={copied === 'address' ? 'check' : 'copy'} />{copied === 'address' ? t.copied : t.copy}</span>
            </button>
          </section>

          <div className="warning"><Icon name="alert" /><p>{format(t.sendOnlyOn, { asset, network: invoice.network_name ?? invoice.network ?? '' })}{invoice.address_mode === 'shared' ? ` ${t.sharedAddressNote}` : ''}</p></div>
        </>
      )}

      {partial && <p className="notice">{format(t.underpaidNotice, { received: invoice.received_amount, remaining: invoice.remaining_amount, asset })}</p>}
      {invoice.status === 'overpaid' && <p className="notice">{t.overpaidNotice}</p>}
      {['detected', 'confirming'].includes(invoice.status) && <p className="notice calm">{t.confirmingNotice}</p>}

      <ol className="timeline" aria-label="Payment progress">
        {t.steps.map((label, index) => (
          <li key={label} className={index <= stage ? 'is-active' : ''} aria-current={index === stage ? 'step' : undefined}>
            <span className="dot" />{label}
          </li>
        ))}
      </ol>

      <footer className="card-footer">
        <span className="secure"><Icon name="lock" />{t.directToMerchant}</span>
        {canCancel && <button className="link-button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? t.cancelling : t.cancel}</button>}
      </footer>
      {(error || copyError) && <p className="inline-error" role="alert">{error || copyError}</p>}
    </>
  );
}

function ResultCard({ invoice }: { invoice: PublicInvoice }) {
  const paid = invoice.status === 'paid';
  const title = paid ? t.paidTitle : invoice.status === 'late_payment' ? t.lateTitle : invoice.status === 'cancelled' ? t.cancelledTitle : t.expiredTitle;
  const text = paid ? format(t.paidText, { merchant: invoice.merchant_name }) : invoice.status === 'late_payment' ? t.lateText : invoice.status === 'cancelled' ? t.cancelledText : t.expiredText;
  const target = paid ? invoice.success_url : invoice.cancel_url;
  useEffect(() => {
    if (!paid || !invoice.success_url) return;
    const timer = window.setTimeout(() => window.location.assign(invoice.success_url!), 6_000);
    return () => window.clearTimeout(timer);
  }, [paid, invoice.success_url]);
  return (
    <>
      <Header invoice={invoice} status={invoice.status} />
      <section className={`result ${paid ? 'is-paid' : 'is-closed'}`}>
        <div className="result-mark" aria-hidden="true">
          {paid
            ? <svg viewBox="0 0 64 64"><circle className="ring" cx="32" cy="32" r="29" /><path className="tick" d="m19 33 9 9 18-19" /></svg>
            : <Icon name={invoice.status === 'late_payment' ? 'alert' : 'clock'} />}
        </div>
        <h2>{title}</h2>
        <p>{text}</p>
        {paid && invoice.crypto_amount && (
          <dl className="receipt">
            <div><dt>{t.amount}</dt><dd className="mono">{invoice.received_amount} {invoice.asset}</dd></div>
            <div><dt>{t.orderTotal}</dt><dd>{formatFiat(invoice.request_amount, invoice.request_currency)}</dd></div>
            {invoice.order_id && <div><dt>{t.order}</dt><dd>{invoice.order_id}</dd></div>}
          </dl>
        )}
        {target && <a className="primary-button" href={target}>{paid ? format(t.continue, { merchant: invoice.merchant_name }) : t.backToShop}</a>}
      </section>
    </>
  );
}

export function Checkout() {
  const invoiceId = window.location.pathname.match(/\/checkout\/([0-9a-f-]{36})\/?$/i)?.[1];
  const [invoice, setInvoice] = useState<PublicInvoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!invoiceId) { setError(t.invalidLink); setLoading(false); return; }
    try {
      setInvoice(await request<PublicInvoice>(`/v1/public/invoices/${invoiceId}`));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This payment could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  const status = invoice?.status;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (status && !IN_PROGRESS.includes(status) && status !== 'created') return;
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, status === 'created' ? 20_000 : 4_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(poll); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, status]);

  useEffect(() => {
    if (invoice) document.title = `${t.status[invoice.status]} · ${invoice.merchant_name}`;
  }, [invoice]);

  return (
    <main className="page">
      <div className="backdrop" aria-hidden="true"><span className="planet" /><span className="orbit one" /><span className="orbit two" /></div>
      <header className="topbar">
        <BrandLockup markSize={26} wordSize={13} />
        <span className="secure-label"><Icon name="lock" />{t.secureCheckout}</span>
      </header>
      <article className="card" aria-live="polite" aria-busy={loading}>
        {loading && <div className="state"><OrbitMark size={44} spinning /><p>{t.loading}</p></div>}
        {!loading && error && (
          <div className="state" role="alert">
            <span className="state-icon"><Icon name="alert" /></span>
            <h1>{t.unavailable}</h1>
            <p>{error}</p>
            <button className="secondary-button" onClick={() => { setLoading(true); void refresh(); }}>{t.retry}</button>
          </div>
        )}
        {!loading && !error && invoice && (
          invoice.status === 'created'
            ? <><Header invoice={invoice} status="created" /><CoinPicker invoice={invoice} onSelected={setInvoice} /></>
            : IN_PROGRESS.includes(invoice.status) ? <PaymentCard invoice={invoice} onRefresh={() => void refresh()} />
              : <ResultCard invoice={invoice} />
        )}
      </article>
      {invoice && IN_PROGRESS.includes(invoice.status) && <p className="live"><span className="pulse" />{t.live}</p>}
      <footer className="page-footer"><span>{t.tagline}</span><span>{t.poweredBy} <strong>ORBITT PAY</strong></span></footer>
    </main>
  );
}
