import { Decimal } from 'decimal.js';

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_DECIMALS = 36;

function positiveDecimal(value: string, name: string): Decimal {
  if (!DECIMAL_AMOUNT.test(value)) {
    throw new TypeError(`${name} must be a non-negative decimal string`);
  }
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.lte(0)) {
    throw new RangeError(`${name} must be greater than zero`);
  }
  return decimal;
}

function scaleFor(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`decimals must be an integer from 0 to ${MAX_DECIMALS}`);
  }
  return 10n ** BigInt(decimals);
}

/**
 * Converts a fiat amount to the smallest crypto unit. `rateFiatPerCrypto`
 * means fiat major units for one whole crypto unit. The result is rounded up
 * so the required payment is never less than the quoted fiat value.
 */
export function fiatToBaseUnits(
  fiatAmount: string,
  rateFiatPerCrypto: string,
  assetDecimals: number,
): bigint {
  const fiat = positiveDecimal(fiatAmount, 'fiatAmount');
  const rate = positiveDecimal(rateFiatPerCrypto, 'rateFiatPerCrypto');
  const scale = scaleFor(assetDecimals);
  const units = fiat.div(rate).mul(scale.toString()).ceil();
  return BigInt(units.toFixed(0));
}

/** Parses a human decimal amount without rounding or using JavaScript floats. */
export function decimalToBaseUnits(amount: string, decimals: number): bigint {
  const value = positiveDecimal(amount, 'amount');
  const scale = scaleFor(decimals);
  const units = value.mul(scale.toString());
  if (!units.isInteger()) {
    throw new RangeError(`amount has more than ${decimals} decimal places`);
  }
  return BigInt(units.toFixed(0));
}

/** Formats integer base units as a plain decimal string with no trailing zeroes. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new RangeError('amount must not be negative');
  const scale = scaleFor(decimals);
  const whole = amount / scale;
  const remainder = amount % scale;
  if (remainder === 0n || decimals === 0) return whole.toString();
  const fraction = remainder.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fraction}`;
}
