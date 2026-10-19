/** Public block explorer link for a transaction, or null for networks without one. */
export function explorerTransactionUrl(network: string, transactionId: string): string | null {
  const base: Record<string, string> = {
    bitcoin: 'https://mempool.space/tx/',
    'bitcoin-testnet': 'https://mempool.space/testnet/tx/',
    litecoin: 'https://litecoinspace.org/tx/',
    ethereum: 'https://etherscan.io/tx/',
    'ethereum-sepolia': 'https://sepolia.etherscan.io/tx/',
    base: 'https://basescan.org/tx/',
    arbitrum: 'https://arbiscan.io/tx/',
    optimism: 'https://optimistic.etherscan.io/tx/',
    polygon: 'https://polygonscan.com/tx/',
    'bnb-chain': 'https://bscscan.com/tx/',
    tron: 'https://tronscan.org/#/transaction/',
    solana: 'https://solscan.io/tx/',
  };
  return base[network] ? `${base[network]}${encodeURIComponent(transactionId)}` : null;
}
