import { describe, expect, it } from 'vitest';
import { decimalToBaseUnits, fiatToBaseUnits, formatBaseUnits } from './money.js';

describe('money conversions', () => {
  it('rounds fiat quotes up to the smallest unit', () => {
    expect(fiatToBaseUnits('10', '30000', 8)).toBe(33334n);
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
