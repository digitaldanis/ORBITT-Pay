import type { ChainTransfer } from './types.js';

const TXID = /^[0-9a-f]{64}$/i;

export interface EsploraWatcherConfig {
  asset: 'BTC' | 'LTC';
  network: string;
  apiBases: readonly string[];
  highValueThresholdBaseUnits?: bigint;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export interface AddressScanResult {
  transfers: ChainTransfer[];
  nextCursor: string | null;
}

interface EsploraOutput {
  scriptpubkey_address?: string;
  value: number;
}

interface EsploraTransaction {
  txid: string;
  vout: EsploraOutput[];
  status: {
    confirmed: boolean;
    block_height?: number;
    block_time?: number;
  };
}

export class EsploraWatcher {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly config: EsploraWatcherConfig) {
    if (config.apiBases.length === 0) throw new RangeError('at least one Esplora API base is required');
    if (config.apiBases.some((base) => !/^https?:\/\//i.test(base))) throw new TypeError('Esplora API bases must use HTTP or HTTPS');
    if (config.highValueThresholdBaseUnits !== undefined && config.highValueThresholdBaseUnits < 0n) {
      throw new RangeError('high-value threshold must not be negative');
    }
    this.fetcher = config.fetcher ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.now = config.now ?? (() => new Date());
  }

  async getHeadBlock(): Promise<bigint> {
    const height = await this.getFromProviders<string>('/blocks/tip/height');
    if (!/^\d+$/.test(height)) throw new TypeError('Esplora returned an invalid block height');
    return BigInt(height);
  }

  async scanAddress(address: string, headBlock: bigint, lastSeenTxid?: string): Promise<AddressScanResult> {
    if (!address || address.length > 128) throw new TypeError('receiving address is invalid');
    if (headBlock < 0n) throw new RangeError('head block must not be negative');
    if (lastSeenTxid !== undefined && !TXID.test(lastSeenTxid)) throw new TypeError('lastSeenTxid is invalid');
    const addressPath = `/address/${encodeURIComponent(address)}`;
    const transactions: Array<{ transaction: EsploraTransaction; source: string }> = [];
    let path = `${addressPath}/txs`;
    let cursorFound = lastSeenTxid === undefined;
    const maxPages = 20;
    for (let page = 0; page < maxPages; page += 1) {
      const { value: batch, source } = await this.getFromProviders<EsploraTransaction[]>(path, true);
      if (!Array.isArray(batch)) throw new TypeError('Esplora returned invalid transaction data');
      for (const transaction of batch) {
        if (!TXID.test(transaction.txid)) throw new TypeError('Esplora returned an invalid transaction id');
        if (transaction.txid.toLowerCase() === lastSeenTxid?.toLowerCase()) {
          cursorFound = true;
          break;
        }
        transactions.push({ transaction, source });
      }
      if (cursorFound || batch.length < 25) break;
      const oldestTxid = batch.at(-1)?.txid;
      if (!oldestTxid || !TXID.test(oldestTxid)) throw new TypeError('Esplora returned an invalid pagination cursor');
      path = `${addressPath}/txs/chain/${oldestTxid}`;
    }
    if (!cursorFound && lastSeenTxid !== undefined) throw new Error('Esplora pagination did not reach the saved transaction cursor');

    const transfers: ChainTransfer[] = [];
    for (const { transaction, source } of transactions) {
      const amount = outputTotal(transaction, address);
      if (amount === 0n) continue;
      if (transaction.status.confirmed && (!Number.isSafeInteger(transaction.status.block_height) || transaction.status.block_height! < 0)) {
        throw new TypeError('Esplora returned an invalid confirmed block height');
      }
      const blockNumber = transaction.status.confirmed ? BigInt(transaction.status.block_height!) : null;
      const transfer: ChainTransfer = {
        transactionId: transaction.txid,
        asset: this.config.asset,
        network: this.config.network,
        address,
        amountBaseUnits: amount,
        blockNumber,
        confirmations: blockNumber !== null && blockNumber <= headBlock ? headBlock - blockNumber + 1n : 0n,
        observedAt: transaction.status.block_time && Number.isSafeInteger(transaction.status.block_time)
          ? new Date(transaction.status.block_time * 1000)
          : this.now(),
      };
      await this.verifyHighValueTransfer(transfer, address, source);
      transfers.push(transfer);
    }
    return { transfers, nextCursor: transactions[0]?.transaction.txid ?? lastSeenTxid ?? null };
  }

  private async verifyHighValueTransfer(transfer: ChainTransfer, address: string, primarySource: string): Promise<void> {
    const threshold = this.config.highValueThresholdBaseUnits;
    if (threshold === undefined || transfer.amountBaseUnits < threshold) return;
    let transaction: EsploraTransaction | undefined;
    for (const base of this.config.apiBases) {
      if (normalizeBase(base) === normalizeBase(primarySource)) continue;
      try {
        transaction = await this.getFromBase<EsploraTransaction>(base, `/tx/${transfer.transactionId}`);
        break;
      } catch {
        // Continue until a separate provider responds.
      }
    }
    if (!transaction) throw new Error('high-value transfer verification requires a second responsive chain provider');
    if (outputTotal(transaction, address) !== transfer.amountBaseUnits
      || transaction.status.confirmed !== (transfer.blockNumber !== null)
      || (transfer.blockNumber !== null && BigInt(transaction.status.block_height ?? -1) !== transfer.blockNumber)) {
      throw new Error('independent chain providers disagree on a high-value UTXO transfer');
    }
  }

  private async getFromProviders<T>(path: string): Promise<T>;
  private async getFromProviders<T>(path: string, includeSource: true): Promise<{ value: T; source: string }>;
  private async getFromProviders<T>(path: string, includeSource = false): Promise<T | { value: T; source: string }> {
    for (const base of this.config.apiBases) {
      try {
        const value = await this.getFromBase<T>(base, path);
        return includeSource ? { value, source: base } : value;
      } catch {
        // Try the next configured independent chain provider.
      }
    }
    throw new Error('all UTXO chain providers failed');
  }

  private async getFromBase<T>(base: string, path: string): Promise<T> {
    const url = `${normalizeBase(base)}${path}`;
    const response = await this.fetcher(url, {
      headers: { accept: 'application/json, text/plain' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`UTXO provider returned HTTP ${response.status}`);
    const text = await response.text();
    if (response.headers.get('content-type')?.includes('text/plain')) return text as T;
    return JSON.parse(text) as T;
  }
}

function outputTotal(transaction: EsploraTransaction, address: string): bigint {
  if (!TXID.test(transaction.txid) || !Array.isArray(transaction.vout) || typeof transaction.status?.confirmed !== 'boolean') {
    throw new TypeError('Esplora returned an invalid transaction');
  }
  let total = 0n;
  for (const output of transaction.vout) {
    if (output.scriptpubkey_address !== address) continue;
    if (!Number.isSafeInteger(output.value) || output.value < 0) throw new TypeError('Esplora returned an invalid output amount');
    total += BigInt(output.value);
  }
  return total;
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}
