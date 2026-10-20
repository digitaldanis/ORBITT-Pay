import { useCallback, useMemo, useState } from 'react';
import { ArrowUpRight, Check, CircleAlert, Clock3, KeyRound, Plus, TrendingUp, WalletCards, Webhook } from 'lucide-react';
import { api, type Account, type ApiKeyRecord, type Overview } from '../api.js';
import { formatFiat } from '../format.js';
import { Banner, Loading, PageHeader, useResource } from '../ui.js';
import { CreateLinkModal, InvoiceTable } from './invoices.js';
import type { Page } from '../Dashboard.js';
import { useSession } from '../session.js';

interface Day { day: string; amount: number; count: number }

function lastDays(count: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, index) => new Date(today - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10));
}

/** The chart shows one currency; mixed-currency shops see the one they invoice in most. */
function volumeSeries(volume: Overview['volume']): { currency: string; days: Day[]; total: number; payments: number } {
  const byCurrency = new Map<string, number>();
  for (const row of volume) byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.count);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'EUR';
  const rows = new Map(volume.filter((row) => row.currency === currency).map((row) => [row.day, row]));
  const days = lastDays(14).map((day) => ({ day, amount: Number(rows.get(day)?.amount ?? 0), count: rows.get(day)?.count ?? 0 }));
  return { currency, days, total: days.reduce((sum, day) => sum + day.amount, 0), payments: days.reduce((sum, day) => sum + day.count, 0) };
}

function VolumeChart({ days, currency }: { days: Day[]; currency: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...days.map((day) => day.amount), 1);
  const shown = active === null ? null : days[active];
  const dayLabel = (day: string, style: 'short' | 'long') => new Intl.DateTimeFormat(undefined, style === 'short' ? { day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  return (
    <div className="chart" onMouseLeave={() => setActive(null)}>
      <div className="chart-tooltip" aria-live="polite">{shown ? <><strong>{formatFiat(shown.amount, currency)}</strong><span>{dayLabel(shown.day, 'long')} · {shown.count} paid</span></> : <span>Select a day for details</span>}</div>
      <div className="chart-bars">
        {days.map((day, index) => (
          <button key={day.day} className={`chart-bar${active === index ? ' active' : ''}${day.amount ? '' : ' empty'}`} onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} aria-label={`${dayLabel(day.day, 'long')}: ${formatFiat(day.amount, currency)}`}>
            <i style={{ height: `${Math.max(day.amount / max * 100, day.amount ? 4 : 0)}%` }} />
            <span>{dayLabel(day.day, 'short')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SetupChecklist({ account, keys, go }: { account: Account | null; keys: ApiKeyRecord[] | null; go: (page: Page) => void }) {
  if (!account || !keys) return null;
  const steps = [
    { done: account.wallets.length > 0, title: 'Add a receiving wallet', text: 'Public keys only. Funds go straight to you.', icon: WalletCards, page: 'Assets' as Page },
    { done: keys.some((key) => !key.revoked_at), title: 'Create an API key', text: 'Create invoices from your shop backend.', icon: KeyRound, page: 'API keys' as Page },
    { done: Boolean(account.webhook.url), title: 'Connect a webhook', text: 'Get signed events when payments confirm.', icon: Webhook, page: 'Settings' as Page },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  if (!remaining) return null;
  return (
    <section className="panel setup">
      <div className="panel-heading"><div><h2>Finish setting up</h2><p>{3 - remaining} of 3 done</p></div><div className="progress"><i style={{ width: `${(3 - remaining) / 3 * 100}%` }} /></div></div>
      <div className="setup-steps">
        {steps.map(({ done, title, text, icon: Icon, page }) => (
          <button key={title} className={`setup-step${done ? ' done' : ''}`} onClick={() => go(page)} disabled={done}>
            <span className="setup-icon">{done ? <Check size={16} /> : <Icon size={16} />}</span>
            <span><strong>{title}</strong><small>{text}</small></span>
            {!done && <ArrowUpRight size={15} />}
          </button>
        ))}
      </div>
    </section>
  );
}

export function OverviewPage({ account, go, onOpen, refreshKey, onCreated }: { account: Account | null; go: (page: Page) => void; onOpen: (id: string) => void; refreshKey: number; onCreated: () => void }) {
  const { can } = useSession();
  // refreshKey is a dependency only so that a new value re-runs the load.
  const load = useCallback(() => api<Overview>('/v1/dashboard/overview'), [refreshKey]);
  const { data, error } = useResource(load, 'Dashboard data could not be loaded.');
  const loadKeys = useCallback(() => api<ApiKeyRecord[]>('/v1/dashboard/api-keys'), []);
  const keys = useResource(loadKeys, 'API keys could not be loaded.');
  const [creating, setCreating] = useState(false);
  const series = useMemo(() => volumeSeries(data?.volume ?? []), [data]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Loading label="Loading overview…" />;

  const cards = [
    { title: 'Paid volume', value: formatFiat(series.total, series.currency), hint: `${series.payments} payments · 14 days`, icon: TrendingUp, tone: 'violet' },
    { title: 'Paid invoices', value: data.summary.paid.toLocaleString(), hint: `${data.summary.paid_today} today`, icon: Check, tone: 'green' },
    { title: 'Open', value: data.summary.pending.toLocaleString(), hint: 'Waiting for customers', icon: Clock3, tone: 'blue' },
    { title: 'Needs attention', value: data.summary.attention.toLocaleString(), hint: 'Underpaid, overpaid or late', icon: CircleAlert, tone: data.summary.attention ? 'amber' : 'neutral' },
  ];

  return <>
    <PageHeader title="Overview" description={`Welcome back to ${account?.merchant.name ?? 'your workspace'}.`}>
      {can('payments') && <button className="primary-button" onClick={() => setCreating(true)}><Plus size={15} />New payment link</button>}
    </PageHeader>
    <SetupChecklist account={account} keys={keys.data} go={go} />
    <div className="stats-grid">
      {cards.map(({ title, value, hint, icon: Icon, tone }) => (
        <article className="stat-card" key={title}>
          <div className="stat-top"><span>{title}</span><i className={`stat-icon ${tone}`}><Icon size={15} /></i></div>
          <strong className="stat-value">{value}</strong>
          <span className="stat-hint">{hint}</span>
        </article>
      ))}
    </div>
    <section className="panel">
      <div className="panel-heading"><div><h2>Paid volume</h2><p>Last 14 days in {series.currency}</p></div><strong className="panel-figure">{formatFiat(series.total, series.currency)}</strong></div>
      <VolumeChart days={series.days} currency={series.currency} />
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Recent activity</h2><p>Latest payment requests</p></div><button className="text-button" onClick={() => go('Invoices')}>View all <ArrowUpRight size={14} /></button></div>
      <InvoiceTable invoices={data.recent} onOpen={onOpen} compact />
    </section>
    {creating && <CreateLinkModal onClose={() => setCreating(false)} onCreated={onCreated} />}
  </>;
}
