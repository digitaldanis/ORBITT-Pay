export const INVOICE_STATUSES = [
  'created',
  'awaiting_payment',
  'detected',
  'confirming',
  'paid',
  'underpaid',
  'overpaid',
  'expired',
  'late_payment',
  'cancelled',
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface Invoice {
  id: string;
  merchantId: string;
  orderId: string | null;
  fiatAmount: string | null;
  fiatCurrency: string | null;
  rateUsed: string | null;
  rateTimestamp: Date | null;
  cryptoAmountBaseUnits: bigint;
  receivedAmountBaseUnits: bigint;
  surplusBaseUnits: bigint;
  asset: string;
  network: string;
  address: string | null;
  derivationPath: string | null;
  status: InvoiceStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

export interface InvoiceStatusEvent {
  from: InvoiceStatus;
  to: InvoiceStatus;
  at: Date;
  reason?: string;
}

const TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  created: ['awaiting_payment', 'expired', 'cancelled'],
  awaiting_payment: ['detected', 'underpaid', 'overpaid', 'expired', 'late_payment', 'cancelled'],
  detected: ['confirming', 'underpaid', 'overpaid', 'paid'],
  confirming: ['underpaid', 'overpaid', 'paid'],
  underpaid: ['detected', 'confirming', 'overpaid', 'paid', 'expired', 'late_payment'],
  overpaid: ['confirming', 'paid'],
  expired: ['late_payment'],
  late_payment: [],
  paid: [],
  cancelled: ['late_payment'],
};

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transitionInvoice(
  invoice: Invoice,
  to: InvoiceStatus,
  at: Date = new Date(),
): Invoice {
  if (invoice.status === to) return invoice;
  if (!canTransitionInvoice(invoice.status, to)) {
    throw new Error(`Invalid invoice status transition: ${invoice.status} -> ${to}`);
  }
  return { ...invoice, status: to, updatedAt: at };
}

export type PaymentDisposition = 'exact' | 'underpaid' | 'overpaid';

export function classifyPayment(received: bigint, expected: bigint): PaymentDisposition {
  if (received < 0n || expected <= 0n) {
    throw new RangeError('received amount must be non-negative and expected amount must be positive');
  }
  if (received < expected) return 'underpaid';
  if (received > expected) return 'overpaid';
  return 'exact';
}

export function recordPayment(
  invoice: Invoice,
  cumulativeReceivedBaseUnits: bigint,
  confirmationsMet: boolean,
  at: Date = new Date(),
): Invoice {
  if (invoice.status === 'expired' || invoice.status === 'cancelled') {
    return transitionInvoice(invoice, 'late_payment', at);
  }
  const activeInvoice = invoice.status === 'awaiting_payment'
    ? transitionInvoice(invoice, 'detected', at)
    : invoice;
  const disposition = classifyPayment(cumulativeReceivedBaseUnits, invoice.cryptoAmountBaseUnits);
  const status: InvoiceStatus = disposition === 'underpaid'
    ? 'underpaid'
    : confirmationsMet
      ? 'paid'
      : disposition === 'overpaid'
        ? 'overpaid'
        : 'confirming';
  const updated = transitionInvoice(activeInvoice, status, at);
  return {
    ...updated,
    receivedAmountBaseUnits: cumulativeReceivedBaseUnits,
    surplusBaseUnits: cumulativeReceivedBaseUnits > invoice.cryptoAmountBaseUnits
      ? cumulativeReceivedBaseUnits - invoice.cryptoAmountBaseUnits
      : 0n,
  };
}

export function expireInvoice(invoice: Invoice, at: Date = new Date()): Invoice {
  if (['detected', 'confirming', 'overpaid', 'paid', 'expired', 'late_payment', 'cancelled'].includes(invoice.status)) return invoice;
  return transitionInvoice(invoice, 'expired', at);
}
