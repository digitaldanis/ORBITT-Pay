import { deriveEvmReceiveAddress, deriveUtxoReceiveAddress } from '@orbitt/chains';
import { decimalToBaseUnits, fiatToBaseUnits, formatBaseUnits } from '@orbitt/core';
import type { RateService } from '@orbitt/rates';
import { ApiError } from '../errors.js';
import type { CreateInvoiceInput, MerchantContext } from '../server.js';
import type { InvoicePreparer, PreparedInvoice } from '../db/postgres-services.js';
import type { PoolClient } from 'pg';

export interface EnabledAsset {
  asset: string;
  network: string;
  family: 'utxo' | 'evm';
  decimals: number;
  enabled: boolean;
  derivation_asset?: 'BTC' | 'LTC';
  derivation_network?: 'mainnet' | 'testnet';
}

export class PostgresInvoicePreparer implements InvoicePreparer {
  constructor(
    private readonly assets: readonly EnabledAsset[],
    private readonly rates: RateService,
    private readonly expiryMinutes = 15,
  ) {}

  async prepare(client: PoolClient, merchant: MerchantContext, input: CreateInvoiceInput): Promise<PreparedInvoice> {
    const currency = input.currency.trim().toUpperCase();
    const fiat = /^[A-Z]{3}$/.test(currency) && !this.assets.some((asset) => asset.asset === currency);
    const assetCode = (input.asset ?? (fiat ? '' : currency)).trim().toUpperCase();
    if (!assetCode) throw new ApiError(400, 'asset_required', 'Choose an asset and network for a fiat amount.', 'asset');
    const supported = this.assets.filter((asset) => asset.asset === assetCode && asset.enabled);
    const asset = input.network
      ? supported.find((candidate) => candidate.network === input.network!.trim().toLowerCase())
      : supported.length === 1 ? supported[0] : undefined;
    if (!asset) throw new ApiError(422, 'unsupported_asset_network', 'The requested asset and network are not enabled.', 'network');

    let baseUnits: bigint;
    let rateUsed: string | null = null;
    let rateTimestamp: Date | null = null;
    let fiatAmount: string | null = null;
    let fiatCurrency: string | null = null;
    if (fiat) {
      let quote;
      try {
        quote = await this.rates.getRate({ asset: asset.asset, fiatCurrency: currency });
      } catch {
        throw new ApiError(422, 'rate_unavailable', 'A fresh exchange rate is unavailable for this quote.', 'currency');
      }
      try {
        baseUnits = fiatToBaseUnits(input.amount, quote.rate, asset.decimals);
      } catch (error) {
        throw new ApiError(400, 'invalid_amount', error instanceof Error ? error.message : 'Amount is invalid.', 'amount');
      }
      rateUsed = quote.rate;
      rateTimestamp = quote.timestamp;
      fiatAmount = input.amount;
      fiatCurrency = currency;
    } else {
      if (currency !== asset.asset) throw new ApiError(422, 'currency_asset_mismatch', 'For crypto-denominated invoices, currency must match the selected asset.', 'currency');
      try {
        baseUnits = decimalToBaseUnits(input.amount, asset.decimals);
      } catch (error) {
        throw new ApiError(400, 'invalid_amount', error instanceof Error ? error.message : 'Amount is invalid.', 'amount');
      }
    }

    const walletResult = await client.query<{ extended_public_key: string | null; address: string | null; next_derivation_index: string }>(
      `SELECT extended_public_key, address, next_derivation_index
       FROM merchant_wallets WHERE merchant_id = $1 AND asset = $2 AND network = $3 FOR UPDATE`,
      [merchant.id, asset.asset, asset.network],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw new ApiError(422, 'wallet_not_configured', 'Configure a public wallet for this asset and network first.', 'asset');
    if (!wallet.extended_public_key) throw new ApiError(422, 'unique_address_required', 'This network currently requires an account-level public key so each invoice gets a unique address.', 'wallets');

    const index = Number(wallet.next_derivation_index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 2_147_483_647) throw new ApiError(500, 'derivation_index_exhausted', 'The wallet address index cannot be advanced.');
    let derived;
    try {
      derived = asset.family === 'utxo'
        ? deriveUtxoReceiveAddress(wallet.extended_public_key, asset.derivation_asset!, asset.derivation_network!, index)
        : deriveEvmReceiveAddress(wallet.extended_public_key, index);
    } catch {
      throw new ApiError(422, 'invalid_public_key', 'The configured key cannot derive addresses for this network.', 'wallets');
    }
    await client.query(
      `UPDATE merchant_wallets SET next_derivation_index = $4, updated_at = now()
       WHERE merchant_id = $1 AND asset = $2 AND network = $3`, [merchant.id, asset.asset, asset.network, index + 1],
    );

    const now = new Date();
    return {
      amount: input.amount,
      currency,
      fiatAmount,
      fiatCurrency,
      rateUsed,
      rateTimestamp,
      cryptoAmount: formatBaseUnits(baseUnits, asset.decimals),
      cryptoAmountBaseUnits: baseUnits,
      asset: asset.asset,
      network: asset.network,
      address: derived.address,
      derivationPath: derived.derivationPath,
      expiresAt: new Date(now.getTime() + this.expiryMinutes * 60_000),
      successUrl: input.success_url ?? null,
      cancelUrl: input.cancel_url ?? null,
      webhookUrl: input.webhook_url ?? null,
    };
  }
}
