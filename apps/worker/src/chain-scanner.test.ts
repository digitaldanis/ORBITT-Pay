import { describe, expect, it } from 'vitest';
import { resolvePaymentStatus, transferIsEligible, type OpenInvoice } from './chain-scanner.js';

const invoice = (status: OpenInvoice['status'] = 'awaiting_payment'): OpenInvoice => ({
  id: 'invoice-1', merchant_id: 'merchant-1', crypto_amount_base_units: '1000',
  received_amount_base_units: '0', surplus_base_units: '0', asset: 'BTC', network: 'bitcoin',
  address: 'bc1qexample', address_mode: 'derived', status, expires_at: new Date('2026-10-20T00:00:00.000Z'),
  created_at: new Date('2026-10-19T00:00:00.000Z'), payment_selected_at: new Date('2026-10-19T12:00:00.000Z'), required_confirmations: 2,
});

const transfer = (observedAt: string, blockNumber: bigint | null = 100n) => ({
  transactionId: 'tx', asset: 'BTC', network: 'bitcoin', address: 'bc1qexample', amountBaseUnits: 1000n,
  blockNumber, confirmations: 1n, observedAt: new Date(observedAt),
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

describe('transfer eligibility', () => {
  it('ignores confirmed history that predates the payment selection', () => {
    expect(transferIsEligible(invoice(), transfer('2026-10-19T08:00:00.000Z'), 'utxo')).toBe(false);
    expect(transferIsEligible(invoice(), transfer('2026-10-19T11:00:00.000Z'), 'utxo')).toBe(true);
    expect(transferIsEligible(invoice(), transfer('2026-10-19T11:00:00.000Z'), 'tron')).toBe(false);
  });

  it('accepts freshly observed mempool transfers and EVM range scans', () => {
    expect(transferIsEligible(invoice(), transfer(new Date().toISOString(), null), 'utxo')).toBe(true);
    expect(transferIsEligible(invoice(), transfer('2020-01-01T00:00:00.000Z'), 'evm')).toBe(true);
  });
});
