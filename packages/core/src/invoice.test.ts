import { describe, expect, it } from 'vitest';
import { classifyPayment, expireInvoice, recordPayment, transitionInvoice, type Invoice } from './invoice.js';

const sample: Invoice = {
  id: 'inv_test', merchantId: 'mer_test', orderId: null,
  fiatAmount: '10.00', fiatCurrency: 'EUR', rateUsed: '30000', rateTimestamp: new Date(0),
  cryptoAmountBaseUnits: 33334n, receivedAmountBaseUnits: 0n, surplusBaseUnits: 0n,
  asset: 'BTC', network: 'bitcoin', address: null, derivationPath: null,
  status: 'created', expiresAt: new Date(60_000), createdAt: new Date(0), updatedAt: new Date(0), metadata: {},
};

describe('invoice status machine', () => {
  it('allows expected forward transitions and rejects invalid transitions', () => {
    expect(transitionInvoice(sample, 'awaiting_payment').status).toBe('awaiting_payment');
    expect(() => transitionInvoice(sample, 'paid')).toThrow(/Invalid invoice status transition/);
  });

  it('classifies cumulative payments in integer base units', () => {
    expect(classifyPayment(33333n, 33334n)).toBe('underpaid');
    expect(classifyPayment(33334n, 33334n)).toBe('exact');
    expect(classifyPayment(33335n, 33334n)).toBe('overpaid');
  });

  it('records an exact payment through detection and confirmation', () => {
    const awaiting = transitionInvoice(sample, 'awaiting_payment');
    const confirming = recordPayment(awaiting, 33334n, false, new Date(10));
    expect(confirming.status).toBe('confirming');
    const paid = recordPayment(confirming, 33334n, true, new Date(20));
    expect(paid.status).toBe('paid');
  });

  it('expires unpaid invoices but keeps detected payments open', () => {
    expect(expireInvoice(sample).status).toBe('expired');
    const detected = transitionInvoice(transitionInvoice(sample, 'awaiting_payment'), 'detected');
    expect(expireInvoice(detected)).toBe(detected);
  });
});

describe('payments after expiry', () => {
  it('does not flag re-observed pre-expiry transfers as late payments', () => {
    const expired: Invoice = { ...sample, status: 'expired', receivedAmountBaseUnits: 10_000n };
    expect(recordPayment(expired, 10_000n, true).status).toBe('expired');
    const late = recordPayment(expired, 12_000n, true);
    expect(late.status).toBe('late_payment');
    expect(late.receivedAmountBaseUnits).toBe(12_000n);
  });

  it('keeps paid invoices paid while recording surplus', () => {
    const paid: Invoice = { ...sample, status: 'paid', receivedAmountBaseUnits: 33_334n };
    const updated = recordPayment(paid, 40_000n, true);
    expect(updated.status).toBe('paid');
    expect(updated.surplusBaseUnits).toBe(6_666n);
  });
});
