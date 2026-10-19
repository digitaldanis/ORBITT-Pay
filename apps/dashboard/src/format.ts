import type { InvoiceStatus } from './api.js';

export function dateLabel(value: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function relativeTime(value: string | null, now = Date.now()): string {
  if (!value) return 'Never';
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86_400], ['hour', 3_600], ['minute', 60]];
  // The dashboard copy is English, so relative phrases are too; dates and numbers follow the browser locale.
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return Math.abs(seconds) < 10 ? 'just now' : format.format(seconds, 'second');
}

export function formatFiat(amount: string | number, currency: string, compact = false): string {
  if (!/^[A-Z]{3}$/.test(currency)) return `${amount} ${currency}`;
  try {
    // Display only: invoice amounts stay decimal strings everywhere else.
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}) }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

export function middleTruncate(value: string, head = 8, tail = 6): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  created: 'Awaiting coin', awaiting_payment: 'Awaiting payment', detected: 'Detected', confirming: 'Confirming',
  paid: 'Paid', underpaid: 'Underpaid', overpaid: 'Overpaid', expired: 'Expired', late_payment: 'Late payment', cancelled: 'Cancelled',
};

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function statusTone(status: string): Tone {
  if (['paid', 'delivered', 'active', 'healthy'].includes(status)) return 'success';
  if (['underpaid', 'overpaid', 'late_payment', 'pending'].includes(status)) return 'warning';
  if (['failed', 'revoked', 'error'].includes(status)) return 'danger';
  if (['created', 'awaiting_payment', 'detected', 'confirming'].includes(status)) return 'info';
  return 'neutral';
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as InvoiceStatus] ?? status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
}
