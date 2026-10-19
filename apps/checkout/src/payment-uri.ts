const EVM_CHAIN_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
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
  amount: string;
  baseUnits: string;
}

export function buildPaymentUri(target: PaymentTarget): string {
  const address = target.address.trim();
  if (!address) throw new TypeError('A receiving address is required');
  const amount = target.amount.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(amount)) throw new TypeError('Payment amount must be a decimal string');
  if (!/^\d+$/.test(target.baseUnits)) throw new TypeError('Base-unit amount must be an integer string');
  const asset = target.asset.toUpperCase();
  const network = target.network.toLowerCase();
  if (asset === 'BTC') return `bitcoin:${address}?amount=${encodeURIComponent(amount)}`;
  if (asset === 'LTC') return `litecoin:${address}?amount=${encodeURIComponent(amount)}`;
  const chainId = EVM_CHAIN_IDS[network];
  if (asset === 'ETH' && chainId !== undefined) return `ethereum:${address}@${chainId}?value=${target.baseUnits}`;
  return address;
}
