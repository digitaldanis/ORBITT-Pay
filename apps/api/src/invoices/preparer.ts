import { randomBytes } from 'node:crypto';
import { deriveEvmReceiveAddress, deriveTronReceiveAddress, deriveUtxoReceiveAddress } from '@orbitt/chains';
import { decimalToBaseUnits, fiatToBaseUnits, formatBaseUnits, pickUniqueAmount, quoteStep } from '@orbitt/core';
import type { AddressMode, AssetDefinition } from '@orbitt/core';
import type { RateService } from '@orbitt/rates';
import { ApiError } from '../errors.js';
import type { CreateInvoiceInput, MerchantContext } from '../server.js';
import type { InvoicePreparer, PaymentOption, PaymentSelection, PreparedInvoice } from '../db/postgres-services.js';
import type { PoolClient } from 'pg';

const OPEN_OR_RECENT = `(status IN ('created', 'awaiting_payment', 'detected', 'confirming', 'underpaid', 'overpaid')
  OR (status IN ('expired', 'cancelled', 'late_payment') AND updated_at > now() - interval '24 hours'))`;

function randomBelow(maxExclusive: bigint): bigint {
  // 64 random bits reduced modulo a small bound; bias is negligible for offsets below 2^32.
  return randomBytes(8).readBigUInt64BE() % maxExclusive;
}

export interface PreparerOptions {
  /** Quote validity once a coin is chosen. */
  expiryMinutes?: number;
  /** How long a customer has to choose a coin on hosted checkout. */
  selectionMinutes?: number;
  /** Only offer networks with a recent worker heartbeat. */
  requireLiveScanner?: boolean;
}

export class PostgresInvoicePreparer implements InvoicePreparer {
  private readonly expiryMinutes: number;
  private readonly selectionMinutes: number;
  private readonly requireLiveScanner: boolean;

  constructor(
    private readonly assets: readonly AssetDefinition[],
    private readonly rates: RateService,
    options: PreparerOptions = {},
  ) {
    this.expiryMinutes = options.expiryMinutes ?? 15;
    this.selectionMinutes = options.selectionMinutes ?? 60;
    this.requireLiveScanner = options.requireLiveScanner ?? false;
  }

  private isFiat(currency: string): boolean {
    return /^[A-Z]{3}$/.test(currency) && !this.assets.some((asset) => asset.asset === currency);
  }

  private resolveAsset(assetCode: string, network: string | undefined): AssetDefinition {
    const supported = this.assets.filter((asset) => asset.asset === assetCode && asset.enabled);
    const normalizedNetwork = network?.trim().toLowerCase();
    const asset = normalizedNetwork
      ? supported.find((candidate) => candidate.network === normalizedNetwork)
      : supported.length === 1 ? supported[0] : undefined;
    if (asset) return asset;
    if (!normalizedNetwork && supported.length > 1) {
      throw new ApiError(422, 'network_required', `${assetCode} is available on several networks: ${supported.map((item) => item.network).join(', ')}. Choose one.`, 'network');
    }
    throw new ApiError(422, 'unsupported_asset_network', 'The requested asset and network are not enabled.', 'network');
  }

  async prepare(client: PoolClient, merchant: MerchantContext, input: CreateInvoiceInput): Promise<PreparedInvoice> {
    const currency = input.currency.trim().toUpperCase();
    const fiat = this.isFiat(currency);
    if (!fiat && !this.assets.some((asset) => asset.asset === currency && asset.enabled)) {
      throw new ApiError(422, 'unsupported_currency', 'Currency must be an ISO fiat code or an enabled asset.', 'currency');
    }
    const assetCode = (input.asset ?? (fiat ? '' : currency)).trim().toUpperCase();
    const base = {
      amount: input.amount,
      currency,
      fiatAmount: fiat ? input.amount : null,
      fiatCurrency: fiat ? currency : null,
      successUrl: input.success_url ?? null,
      cancelUrl: input.cancel_url ?? null,
      webhookUrl: input.webhook_url ?? null,
    };
    if (fiat) {
      try { decimalToBaseUnits(input.amount, 18); }
      catch (error) { throw new ApiError(400, 'invalid_amount', error instanceof Error ? error.message : 'Amount is invalid.', 'amount'); }
    }
    if (!assetCode) {
      // No coin chosen: the customer picks one on hosted checkout.
      const options = await this.paymentOptions(client, merchant.id);
      if (!options.length) throw new ApiError(422, 'no_payment_options', 'Configure at least one receiving wallet before creating invoices.', 'asset');
      return { ...base, payment: null, expiresAt: new Date(Date.now() + this.selectionMinutes * 60_000) };
    }
    const asset = this.resolveAsset(assetCode, input.network);
    if (!fiat && currency !== asset.asset) {
      throw new ApiError(422, 'currency_asset_mismatch', 'For crypto-denominated invoices, currency must match the selected asset.', 'currency');
    }
    const payment = await this.selectPayment(client, merchant, { amount: input.amount, currency }, asset.asset, asset.network);
    return { ...base, payment, expiresAt: payment.expiresAt };
  }

  async paymentOptions(client: PoolClient, merchantId: string): Promise<PaymentOption[]> {
    const wallets = await client.query<{ asset: string; network: string; has_key: boolean; has_address: boolean }>(
      `SELECT asset, network, extended_public_key IS NOT NULL AS has_key, address IS NOT NULL AS has_address
       FROM merchant_wallets WHERE merchant_id = $1`, [merchantId],
    );
    let live: Set<string> | null = null;
    if (this.requireLiveScanner) {
      const status = await client.query<{ network: string }>(
        `SELECT network FROM network_scanner_status WHERE last_scan_at > now() - interval '10 minutes' AND last_error IS NULL`,
      );
      live = new Set(status.rows.map((row) => row.network));
    }
    return this.assets.filter((asset) => {
      if (!asset.enabled || (live && !live.has(asset.network))) return false;
      const wallet = wallets.rows.find((row) => row.asset === asset.walletAsset && row.network === asset.network);
      return asset.addressMode === 'derived' ? wallet?.has_key === true : wallet?.has_address === true;
    }).map((asset) => ({
      asset: asset.asset, network: asset.network, name: asset.name, network_name: asset.networkName,
      decimals: asset.decimals, contract: asset.contract,
    }));
  }

  async selectPayment(
    client: PoolClient,
    merchant: MerchantContext,
    request: { amount: string; currency: string },
    assetCode: string,
    network: string,
  ): Promise<PaymentSelection> {
    const asset = this.resolveAsset(assetCode.trim().toUpperCase(), network);
    const fiat = this.isFiat(request.currency);
    let baseUnits: bigint;
    let rateUsed: string | null = null;
    let rateTimestamp: Date | null = null;
    if (fiat) {
      let quote;
      try {
        quote = await this.rates.getRate({ asset: asset.asset, fiatCurrency: request.currency });
      } catch {
        throw new ApiError(422, 'rate_unavailable', 'A fresh exchange rate is unavailable for this quote.', 'currency');
      }
      try {
        baseUnits = fiatToBaseUnits(request.amount, quote.rate, asset.decimals, quoteStep(asset.decimals));
      } catch (error) {
        throw new ApiError(400, 'invalid_amount', error instanceof Error ? error.message : 'Amount is invalid.', 'amount');
      }
      rateUsed = quote.rate;
      rateTimestamp = quote.timestamp;
    } else {
      if (request.currency !== asset.asset) throw new ApiError(422, 'currency_asset_mismatch', 'This invoice is priced in another asset.', 'asset');
      try {
        baseUnits = decimalToBaseUnits(request.amount, asset.decimals);
      } catch (error) {
        throw new ApiError(400, 'invalid_amount', error instanceof Error ? error.message : 'Amount is invalid.', 'amount');
      }
    }

    const walletResult = await client.query<{ extended_public_key: string | null; address: string | null; next_derivation_index: string }>(
      `SELECT extended_public_key, address, next_derivation_index
       FROM merchant_wallets WHERE merchant_id = $1 AND asset = $2 AND network = $3 FOR UPDATE`,
      [merchant.id, asset.walletAsset, asset.network],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw new ApiError(422, 'wallet_not_configured', `Configure a ${asset.walletAsset} wallet on ${asset.networkName} first.`, 'asset');

    let address: string;
    let derivationPath: string | null = null;
    let addressMode: AddressMode = asset.addressMode;
    if (asset.addressMode === 'shared') {
      if (!wallet.address) throw new ApiError(422, 'wallet_address_required', `${asset.networkName} uses the merchant's public address with a unique amount. Configure an address.`, 'wallets');
      address = wallet.address;
      const reserved = await client.query<{ amount: string }>(
        `SELECT crypto_amount_base_units AS amount FROM invoices
         WHERE address = $1 AND asset = $2 AND network = $3 AND address_mode = 'shared' AND ${OPEN_OR_RECENT}`,
        [address, asset.asset, asset.network],
      );
      try {
        baseUnits = pickUniqueAmount(baseUnits, asset.maxOffsetBaseUnits, new Set(reserved.rows.map((row) => BigInt(row.amount))), randomBelow, quoteStep(asset.decimals));
      } catch {
        throw new ApiError(409, 'amount_slots_exhausted', 'Too many open invoices share this receiving address. Retry shortly.');
      }
    } else {
      if (!wallet.extended_public_key) throw new ApiError(422, 'unique_address_required', 'This network requires an account-level public key so each invoice gets a unique address.', 'wallets');
      addressMode = 'derived';
      let index = Number(wallet.next_derivation_index);
      let derived;
      // Never hand out an address that any earlier invoice on this network used, even after a
      // wallet key was replaced and its index reset; old transfers would otherwise be counted.
      for (let attempt = 0; ; attempt += 1) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= 2_147_483_647 || attempt >= 1_000) {
          throw new ApiError(500, 'derivation_index_exhausted', 'The wallet address index cannot be advanced.');
        }
        try {
          derived = asset.family === 'utxo'
            ? deriveUtxoReceiveAddress(wallet.extended_public_key, asset.derivationAsset!, asset.derivationNetwork!, index)
            : asset.family === 'tron'
              ? deriveTronReceiveAddress(wallet.extended_public_key, index)
              : deriveEvmReceiveAddress(wallet.extended_public_key, index);
        } catch {
          throw new ApiError(422, 'invalid_public_key', 'The configured key cannot derive addresses for this network.', 'wallets');
        }
        const used = await client.query('SELECT 1 FROM invoices WHERE network = $1 AND lower(address) = lower($2) LIMIT 1', [asset.network, derived.address]);
        if (!used.rowCount) break;
        index += 1;
      }
      await client.query(
        `UPDATE merchant_wallets SET next_derivation_index = $4, updated_at = now()
         WHERE merchant_id = $1 AND asset = $2 AND network = $3`, [merchant.id, asset.walletAsset, asset.network, index + 1],
      );
      address = derived.address;
      derivationPath = derived.derivationPath;
    }

    return {
      asset: asset.asset,
      network: asset.network,
      cryptoAmount: formatBaseUnits(baseUnits, asset.decimals),
      cryptoAmountBaseUnits: baseUnits,
      address,
      derivationPath,
      addressMode,
      rateUsed,
      rateTimestamp,
      expiresAt: new Date(Date.now() + this.expiryMinutes * 60_000),
    };
  }
}
