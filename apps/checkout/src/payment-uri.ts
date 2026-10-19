export const EVM_CHAIN_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
  'ethereum-sepolia': 11155111,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
  'bnb-chain': 56,
};

export interface PaymentTarget {
  asset: string;
  network: string;
  address: string;
  /** Human decimal amount the customer must send. */
  amount: string;
  /** Same amount in the asset's smallest unit. */
  baseUnits: string;
  /** Token contract or SPL mint; null for native coins. */
  tokenContract?: string | null;
}

/** Converts a decimal string into integer base units without floating point. */
export function toBaseUnits(amount: string, decimals: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new TypeError('Payment amount must be a decimal string');
  const fraction = (match[2] ?? '').padEnd(decimals, '0');
  if (fraction.length > decimals) throw new RangeError('Amount has more decimals than the asset supports');
  return BigInt(`${match[1]}${fraction}`).toString();
}

/**
 * Builds the payload encoded in the checkout QR code.
 *
 * Wallet support differs per chain, so the URI is chosen to fail safe: a wallet that does not
 * understand a scheme must not be able to route funds to the wrong account. EVM token transfers
 * therefore encode only the recipient address (EIP-681 token URIs put the contract first, which
 * some wallets misread as the recipient); the exact amount is shown next to the QR code.
 */
export function buildPaymentUri(target: PaymentTarget): string {
  const address = target.address.trim();
  if (!address) throw new TypeError('A receiving address is required');
  const amount = target.amount.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) throw new TypeError('Payment amount must be a decimal string');
  if (!/^\d+$/.test(target.baseUnits)) throw new TypeError('Base-unit amount must be an integer string');
  const network = target.network.toLowerCase();
  const token = target.tokenContract ?? null;

  if (network === 'bitcoin' || network === 'bitcoin-testnet') return `bitcoin:${address}?amount=${amount}`;
  if (network === 'litecoin') return `litecoin:${address}?amount=${amount}`;
  if (network === 'solana') {
    const params = new URLSearchParams({ amount });
    if (token) params.set('spl-token', token);
    return `solana:${address}?${params.toString()}`;
  }
  const chainId = EVM_CHAIN_IDS[network];
  if (chainId !== undefined && !token) return `ethereum:${address}@${chainId}?value=${target.baseUnits}`;
  return address;
}

/** Explorer link for a transaction, used on the success screen. */
export { explorerTransactionUrl } from '@orbitt/ui';
