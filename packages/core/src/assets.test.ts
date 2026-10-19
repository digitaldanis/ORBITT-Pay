import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findAsset, parseAssetCatalog } from './assets.js';
import { pickUniqueAmount } from './money.js';

describe('asset catalog', () => {
  it('parses the shipped catalog and links tokens to native wallets', () => {
    const catalog = parseAssetCatalog(JSON.parse(readFileSync(new URL('../../../config/assets.json', import.meta.url), 'utf8')));
    const usdtTron = findAsset(catalog, 'USDT', 'tron')!;
    expect(usdtTron).toMatchObject({ family: 'tron', walletAsset: 'TRX', addressMode: 'derived', decimals: 6 });
    expect(findAsset(catalog, 'USDC', 'solana')).toMatchObject({ addressMode: 'shared', walletAsset: 'SOL' });
    expect(findAsset(catalog, 'POL', 'polygon')?.contract).toBeNull();
    expect(findAsset(catalog, 'USDT', 'bnb-chain')?.decimals).toBe(18);
  });

  it('rejects duplicates and dangling wallet references', () => {
    const btc = { asset: 'BTC', network: 'bitcoin', family: 'utxo', decimals: 8, derivation_asset: 'BTC', derivation_network: 'mainnet' };
    expect(() => parseAssetCatalog([btc, btc])).toThrow(/duplicate/);
    expect(() => parseAssetCatalog([{ asset: 'USDT', network: 'ethereum', family: 'evm', decimals: 6, contract: '0x1', wallet_asset: 'ETH' }])).toThrow(/wallet_asset/);
  });
});

describe('unique shared-address amounts', () => {
  it('adds a bounded offset that avoids reserved amounts', () => {
    const reserved = new Set([1_001n, 1_002n]);
    let calls = 0;
    const amount = pickUniqueAmount(1_000n, 3n, reserved, () => BigInt(calls++ % 2));
    expect(amount).toBe(1_003n);
    expect(() => pickUniqueAmount(1_000n, 2n, reserved, () => 0n)).toThrow(/no unique amount/);
  });

  it('keeps offsets on the quote grid', () => {
    const amount = pickUniqueAmount(1_000_000n, 99_999n, new Set([1_000_010n]), () => 0n, 10n);
    expect(amount % 10n).toBe(0n);
    expect(amount).toBe(1_000_020n);
    expect(() => pickUniqueAmount(1_000n, 5n, new Set(), () => 0n, 10n)).toThrow(/at least one step/);
  });
});
