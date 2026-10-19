const COIN_COLORS: Readonly<Record<string, readonly [string, string]>> = {
  BTC: ['#f7931a', '#ffb54d'],
  ETH: ['#627eea', '#8ea2ff'],
  LTC: ['#345d9d', '#5d8bd6'],
  USDT: ['#1ba27a', '#3fd0a5'],
  USDC: ['#2775ca', '#58a2f0'],
  SOL: ['#9945ff', '#14f195'],
  TRX: ['#e50914', '#ff5a5f'],
  POL: ['#7b3fe4', '#a77bf3'],
  BNB: ['#d9a40b', '#f3ba2f'],
};

const NETWORK_COLORS: Readonly<Record<string, string>> = {
  bitcoin: '#f7931a', litecoin: '#345d9d', ethereum: '#627eea', base: '#0052ff', arbitrum: '#28a0f0',
  optimism: '#ff0420', polygon: '#7b3fe4', 'bnb-chain': '#f3ba2f', tron: '#e50914', solana: '#14f195',
};

/** Neutral coin badge (brand colour + ticker); tokens show their network as a small dot. */
export function CoinIcon({ asset, network, size = 36, showNetwork = true }: { asset: string; network?: string | null; size?: number; showNetwork?: boolean }) {
  const [from, to] = COIN_COLORS[asset] ?? ['#4b5268', '#6b7390'];
  const label = asset.length > 3 ? asset.slice(0, 4) : asset;
  const nativeOfNetwork = network ? NATIVE_ASSET[network] === asset : true;
  return (
    <span className="ob-coin" style={{ width: size, height: size, fontSize: Math.max(8, size * (label.length > 3 ? 0.24 : 0.3)), background: `linear-gradient(145deg, ${from}, ${to})` }} aria-hidden="true">
      {label}
      {showNetwork && network && !nativeOfNetwork && (
        <i className="ob-coin-network" style={{ background: NETWORK_COLORS[network] ?? '#6b7390' }} />
      )}
    </span>
  );
}

const NATIVE_ASSET: Readonly<Record<string, string>> = {
  bitcoin: 'BTC', 'bitcoin-testnet': 'BTC', litecoin: 'LTC', ethereum: 'ETH', 'ethereum-sepolia': 'ETH', base: 'ETH',
  arbitrum: 'ETH', optimism: 'ETH', polygon: 'POL', 'bnb-chain': 'BNB', tron: 'TRX', solana: 'SOL',
};

export function networkColor(network: string): string {
  return NETWORK_COLORS[network] ?? '#6b7390';
}
