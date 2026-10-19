import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ChainTransfer } from './types.js';

const TXID = /^[0-9a-f]{64}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{30,36}$/;
const base58check = createBase58check(sha256);

export interface TronTokenConfig {
  asset: string;
  contractAddress: string;
}

export interface TronWatcherConfig {
  network: string;
  apiBases: readonly string[];
  tokens?: readonly TronTokenConfig[];
  apiKeyByBase?: Readonly<Record<string, string>>;
  highValueThresholdsBaseUnits?: Readonly<Record<string, bigint>>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

interface TronBlockResponse {
  block_header?: { raw_data?: { number?: number } };
}

interface TronNativeTransaction {
  txID: string;
  block_number: number;
  block_timestamp: number;
  ret?: Array<{ contractRet?: string }>;
  raw_data?: {
    contract?: Array<{
      type?: string;
      parameter?: { value?: { to_address?: string; amount?: number | string } };
    }>;
  };
}

interface TronTokenTransaction {
  transaction_id: string;
  block_number: number;
  block_timestamp: number;
  contract_address: string;
  to: string;
  type: string;
  value: string;
  token_info?: { address?: string };
  success?: boolean;
}

interface TronPage<T> {
  data?: T[];
  meta?: { fingerprint?: string; page_size?: number };
}

export interface TronScanResult {
  transfers: ChainTransfer[];
  nextCursors: Readonly<Record<string, string>>;
}

export class TronWatcher {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly config: TronWatcherConfig) {
    if (config.apiBases.length === 0) throw new RangeError('at least one TRON API base is required');
    if (config.apiBases.some((base) => !/^https?:\/\//i.test(base))) throw new TypeError('TRON API bases must use HTTP or HTTPS');
    for (const amount of Object.values(config.highValueThresholdsBaseUnits ?? {})) {
      if (amount < 0n) throw new RangeError('high-value thresholds must not be negative');
    }
    this.fetcher = config.fetcher ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.now = config.now ?? (() => new Date());
  }

  async getSolidifiedHeadBlock(): Promise<bigint> {
    const body = await this.postFromProviders<TronBlockResponse>('/walletsolidity/getnowblock', {});
    const number = body.block_header?.raw_data?.number;
    if (!Number.isSafeInteger(number) || number! < 0) throw new TypeError('TRON returned an invalid solidified block height');
    return BigInt(number!);
  }

  async scanAddress(
    address: string,
    headBlock: bigint,
    lastSeen: Readonly<Record<string, string>> = {},
  ): Promise<TronScanResult> {
    if (!BASE58.test(address) || !decodeTronAddress(address)) throw new TypeError('TRON receiving address is invalid');
    if (headBlock < 0n) throw new RangeError('solidified head block must not be negative');
    const transfers: ChainTransfer[] = [];
    const nextCursors: Record<string, string> = {};

    const nativePath = `/v1/accounts/${encodeURIComponent(address)}/transactions`;
    const nativeQuery = { only_confirmed: 'true', only_to: 'true', limit: '200', order_by: 'block_timestamp,desc' };
    const nativeKey = `${address}:TRX`;
    if (lastSeen[nativeKey] !== undefined && !TXID.test(lastSeen[nativeKey]!)) throw new TypeError('saved TRON cursor is invalid');
    const nativePage = await this.readPages<TronNativeTransaction>(nativePath, nativeQuery, lastSeen[nativeKey]);
    if (nativePage.nextCursor) nextCursors[nativeKey] = nativePage.nextCursor;
    for (const item of nativePage.records) {
      const transfer = parseNativeTransfer(item, address, this.config.network, headBlock, this.now());
      if (!transfer) continue;
      await this.verifyHighValueTransfer(transfer, nativePath, nativeQuery, item.source);
      transfers.push(transfer);
    }

    for (const token of this.config.tokens ?? []) {
      const path = `/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`;
      const query = {
        only_confirmed: 'true',
        only_to: 'true',
        limit: '200',
        order_by: 'block_timestamp,desc',
        contract_address: token.contractAddress,
      };
      const cursorKey = `${address}:${token.asset}:${token.contractAddress.toLowerCase()}`;
      if (lastSeen[cursorKey] !== undefined && !TXID.test(lastSeen[cursorKey]!)) throw new TypeError('saved TRON cursor is invalid');
      const page = await this.readPages<TronTokenTransaction>(path, query, lastSeen[cursorKey]);
      if (page.nextCursor) nextCursors[cursorKey] = page.nextCursor;
      for (const item of page.records) {
        const transfer = parseTokenTransfer(item, token, address, this.config.network, headBlock, this.now());
        if (!transfer) continue;
        await this.verifyHighValueTransfer(transfer, path, query, item.source);
        transfers.push(transfer);
      }
    }
    return { transfers, nextCursors };
  }

  private async readPages<T extends { txID?: string; transaction_id?: string }>(
    path: string,
    query: Record<string, string>,
    lastSeenId?: string,
  ): Promise<{ records: Array<T & { source: string }>; nextCursor: string | null }> {
    const records: Array<T & { source: string }> = [];
    let cursorFound = lastSeenId === undefined;
    let fingerprint: string | undefined;
    let source: string | undefined;
    const maxPages = 20;
    for (let page = 0; page < maxPages; page += 1) {
      const params = { ...query, ...(fingerprint ? { fingerprint } : {}) };
      let body: TronPage<T>;
      if (source) {
        body = await this.getFromBase<TronPage<T>>(source, path, params);
      } else {
        const response = await this.getFromProviders<TronPage<T>>(path, params);
        body = response.body;
        source = response.source;
      }
      if (!Array.isArray(body.data)) throw new TypeError('TRON returned invalid transaction history');
      for (const item of body.data) {
        const id = item.transaction_id ?? item.txID;
        if (!id || !TXID.test(id)) throw new TypeError('TRON returned an invalid transaction id');
        if (id.toLowerCase() === lastSeenId?.toLowerCase()) {
          cursorFound = true;
          break;
        }
        records.push({ ...item, source });
      }
      if (cursorFound || body.data.length < 200) break;
      fingerprint = body.meta?.fingerprint;
      if (!fingerprint) throw new TypeError('TRON did not return a pagination fingerprint');
    }
    if (!cursorFound && lastSeenId !== undefined) throw new Error('TRON pagination did not reach the saved transaction cursor');
    const firstId = records[0]?.transaction_id ?? records[0]?.txID;
    return { records, nextCursor: firstId ?? lastSeenId ?? null };
  }

  private async verifyHighValueTransfer(
    transfer: ChainTransfer,
    path: string,
    query: Record<string, string>,
    primarySource: string,
  ): Promise<void> {
    const threshold = this.config.highValueThresholdsBaseUnits?.[transfer.asset];
    if (threshold === undefined || transfer.amountBaseUnits < threshold) return;
    const primary = normalizeBase(primarySource);
    let verified: TronPage<TronNativeTransaction | TronTokenTransaction> | undefined;
    for (const base of this.config.apiBases) {
      if (normalizeBase(base) === primary) continue;
      try {
        const body = await this.getFromBase<TronPage<TronNativeTransaction | TronTokenTransaction>>(base, path, query);
        verified = body;
        break;
      } catch {
        // Continue until a separate provider responds.
      }
    }
    if (!verified?.data?.some((item) => {
      const id = 'transaction_id' in item ? item.transaction_id : item.txID;
      if (id?.toLowerCase() !== transfer.transactionId.toLowerCase()) return false;
      if ('value' in item) {
        const contract = item.contract_address ?? item.token_info?.address;
        return item.to === transfer.address
          && item.type === 'Transfer'
          && item.success !== false
          && contract?.toLowerCase() === query.contract_address?.toLowerCase()
          && /^\d+$/.test(item.value)
          && BigInt(item.value) === transfer.amountBaseUnits;
      }
      const parsed = parseNativeTransfer(item, transfer.address, transfer.network, transfer.blockNumber ?? 0n, this.now());
      return parsed?.amountBaseUnits === transfer.amountBaseUnits;
    })) {
      throw new Error('TRON providers disagree on a high-value transfer');
    }
  }

  private async postFromProviders<T>(path: string, body: unknown): Promise<T> {
    for (const base of this.config.apiBases) {
      try {
        return await this.postFromBase<T>(base, path, body);
      } catch {
        // Try the next configured TRON provider.
      }
    }
    throw new Error('all TRON providers failed');
  }

  private async getFromProviders<T>(path: string, query: Record<string, string>): Promise<{ body: T; source: string }> {
    for (const base of this.config.apiBases) {
      try {
        const body = await this.getFromBase<T>(base, path, query);
        return { body, source: base };
      } catch {
        // Try the next configured TRON provider.
      }
    }
    throw new Error('all TRON providers failed');
  }

  private async getFromBase<T>(base: string, path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${normalizeBase(base)}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetcher(url, { headers: this.headers(base), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`TRON API returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private async postFromBase<T>(base: string, path: string, body: unknown): Promise<T> {
    const response = await this.fetcher(`${normalizeBase(base)}${path}`, {
      method: 'POST',
      headers: { ...this.headers(base), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`TRON API returned HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private headers(base: string): HeadersInit {
    const key = this.config.apiKeyByBase?.[base];
    return key ? { accept: 'application/json', 'TRON-PRO-API-KEY': key } : { accept: 'application/json' };
  }
}

function parseNativeTransfer(
  transaction: TronNativeTransaction,
  address: string,
  network: string,
  headBlock: bigint,
  now: Date,
): ChainTransfer | null {
  if (!TXID.test(transaction.txID) || !Number.isSafeInteger(transaction.block_number) || transaction.block_number < 0) {
    throw new TypeError('TRON returned an invalid native transaction');
  }
  const contract = transaction.raw_data?.contract?.[0];
  if (contract?.type !== 'TransferContract') return null;
  if (transaction.ret?.some((ret) => ret.contractRet && ret.contractRet !== 'SUCCESS')) return null;
  const destination = contract.parameter?.value?.to_address;
  if (!destination || destination.toLowerCase() !== addressToHex(address)) return null;
  const rawAmount = contract.parameter?.value?.amount;
  const amount = typeof rawAmount === 'number' && Number.isSafeInteger(rawAmount) ? String(rawAmount) : rawAmount;
  if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
    throw new TypeError('TRON returned an invalid native amount');
  }
  const blockNumber = BigInt(transaction.block_number);
  return {
    transactionId: transaction.txID,
    asset: 'TRX',
    network,
    address,
    amountBaseUnits: BigInt(amount),
    blockNumber,
    confirmations: blockNumber <= headBlock ? headBlock - blockNumber + 1n : 0n,
    observedAt: Number.isSafeInteger(transaction.block_timestamp) ? new Date(transaction.block_timestamp) : now,
  };
}

function parseTokenTransfer(
  transaction: TronTokenTransaction,
  token: TronTokenConfig,
  address: string,
  network: string,
  headBlock: bigint,
  now: Date,
): ChainTransfer | null {
  if (!TXID.test(transaction.transaction_id) || !Number.isSafeInteger(transaction.block_number) || transaction.block_number < 0) {
    throw new TypeError('TRON returned an invalid TRC-20 transaction');
  }
  if (transaction.success === false || transaction.type !== 'Transfer' || transaction.to !== address) return null;
  const contractAddress = transaction.contract_address ?? transaction.token_info?.address;
  if (!contractAddress || contractAddress.toLowerCase() !== token.contractAddress.toLowerCase()) return null;
  if (!/^\d+$/.test(transaction.value) || BigInt(transaction.value) <= 0n) throw new TypeError('TRON returned an invalid TRC-20 amount');
  const blockNumber = BigInt(transaction.block_number);
  return {
    transactionId: transaction.transaction_id,
    asset: token.asset,
    network,
    address,
    amountBaseUnits: BigInt(transaction.value),
    blockNumber,
    confirmations: blockNumber <= headBlock ? headBlock - blockNumber + 1n : 0n,
    observedAt: Number.isSafeInteger(transaction.block_timestamp) ? new Date(transaction.block_timestamp) : now,
  };
}

function addressToHex(address: string): string {
  const payload = base58check.decode(address);
  if (payload.length !== 21 || payload[0] !== 0x41) throw new TypeError('TRON address is invalid');
  return Array.from(payload, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeTronAddress(address: string): boolean {
  try {
    addressToHex(address);
    return true;
  } catch {
    return false;
  }
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}
