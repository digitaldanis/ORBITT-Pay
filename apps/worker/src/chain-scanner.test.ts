import { describe, expect, it } from 'vitest';
import { resolvePaymentStatus } from './chain-scanner.js';

const invoice = (status: 'awaiting_payment' | 'cancelled' = 'awaiting_payment') => ({
  id: 'invoice-1', merchant_id: 'merchant-1', order_id: 'order-1', request_amount: '1.00',
  request_currency: 'EUR', crypto_amount: '0.01', crypto_amount_base_units: '1000',
  received_amount_base_units: '0', surplus_base_units: '0', asset: 'BTC', network: 'bitcoin',
  address: 'bc1qexample', status, expires_at: new Date('2026-10-20T00:00:00.000Z'),
  created_at: new Date('2026-10-19T00:00:00.000Z'), metadata: {},
});

describe('payment status from scanned transfers', () => {
  it('keeps exact payments confirming until the confirmation threshold is met', () => {
    expect(resolvePaymentStatus(invoice(), 1000n, false).status).toBe('confirming');
    expect(resolvePaymentStatus(invoice(), 1000n, true).status).toBe('paid');
  });

  it('keeps partial transfers underpaid and records overpayment surplus', () => {
    expect(resolvePaymentStatus(invoice(), 500n, true).status).toBe('underpaid');
    const overpaid = resolvePaymentStatus(invoice(), 1200n, false);
    expect(overpaid.status).toBe('overpaid');
    expect(overpaid.surplusBaseUnits).toBe(200n);
  });

  it('marks funds arriving after cancellation as late payment', () => {
    expect(resolvePaymentStatus(invoice('cancelled'), 1000n, true).status).toBe('late_payment');
  });
});
