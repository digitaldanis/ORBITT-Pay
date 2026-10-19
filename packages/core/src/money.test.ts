import { describe, expect, it } from 'vitest';
import { decimalToBaseUnits, fiatToBaseUnits, formatBaseUnits, quoteStep } from './money.js';

describe('money conversions', () => {
  it('rounds fiat quotes up to the smallest unit', () => {
    expect(fiatToBaseUnits('10', '30000', 8)).toBe(33334n);
  });

  it('keeps 18-decimal quotes to 8 places, still rounding up', () => {
    const step = quoteStep(18);
    expect(step).toBe(10n ** 10n);
    expect(quoteStep(6)).toBe(1n);
    const wei = fiatToBaseUnits('49.90', '3000', 18, step);
    expect(formatBaseUnits(wei, 18)).toBe('0.01663334');
    // 0.01663334 ETH at 3000 is worth at least the 49.90 asked for.
    expect(wei * 3000n >= 49_900_000_000_000_000_000n).toBe(true);
  });

  it('parses and formats base units exactly', () => {
    expect(decimalToBaseUnits('1.00000001', 8)).toBe(100000001n);
    expect(formatBaseUnits(100000001n, 8)).toBe('1.00000001');
  });

  it('rejects amounts that cannot be represented exactly', () => {
    expect(() => decimalToBaseUnits('0.000000001', 8)).toThrow(RangeError);
    expect(() => fiatToBaseUnits('1e2', '2', 6)).toThrow(TypeError);
  });
});
