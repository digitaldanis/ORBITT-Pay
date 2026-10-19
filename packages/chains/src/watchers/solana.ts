import type { ChainTransfer } from './types.js';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

export interface SolanaWatchTarget {
  /** Invoice's public receiving address shown to the customer. */
  address: string;
  /** For SPL assets this is the associated token account watched by the RPC. */
  watchAddress: string;
  asset: string;
  kind: 'native' | 'spl';
  mint?: string;
  tokenDecimals?: number;
}

export interface SolanaWatcherConfig {
  network: string;
  rpcUrls: readonly string[];
  highValueThresholdsBaseUnits?: Readonly<Record<string, bigint>>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number };
}

interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

interface SolanaTransaction {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: Array<string | { pubkey: string }> } };
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
}

export interface SolanaScanResult {
  transfers: ChainTransfer[];
  nextCursors: Readonly<Record<string, string>>;
}

export class SolanaWatcher {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private requestId = 0;

  constructor(private readonly config: SolanaWatcherConfig) {
    if (config.rpcUrls.length === 0) throw new RangeError('at least one Solana RPC URL is required');
    if (config.rpcUrls.some((url) => !/^https?:\/\//i.test(url))) throw new TypeError('Solana RPC URLs must use HTTP or HTTPS');
    for (const amount of Object.values(config.highValueThresholdsBaseUnits ?? {})) {
      if (amount < 0n) throw new RangeError('high-value thresholds must not be negative');
    }
    this.fetcher = config.fetcher ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.now = config.now ?? (() => new Date());
  }

  async scanTargets(
    targets: readonly SolanaWatchTarget[],
    lastSeenSignatures: Readonly<Record<string, string>> = {},
  ): Promise<SolanaScanResult> {
    const transfers: ChainTransfer[] = [];
    const nextCursors: Record<string, string> = {};
    for (const target of targets) {
      validateTarget(target);
      const cursor = lastSeenSignatures[target.watchAddress];
      if (cursor !== undefined && !SIGNATURE.test(cursor)) throw new TypeError('saved Solana cursor is invalid');
      const { signatures, nextCursor } = await this.getNewSignatures(target.watchAddress, cursor);
      if (nextCursor) nextCursors[target.watchAddress] = nextCursor;
      for (const signature of signatures) {
        if (signature.err !== null) continue;
        const observation = await this.readTransfer(target, signature);
        if (!observation) continue;
        await this.verifyHighValueTransfer(target, signature.signature, observation.transfer.amountBaseUnits, BigInt(signature.slot), observation.sourceEndpoint);
        transfers.push(observation.transfer);
      }
    }
    return { transfers, nextCursors };
  }

  private async getNewSignatures(address: string, cursor?: string): Promise<{ signatures: SignatureInfo[]; nextCursor: string | null }> {
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;
    let cursorFound = cursor === undefined;
    const maxPages = 20;
    for (let page = 0; page < maxPages; page += 1) {
      const options: Record<string, unknown> = { limit: 1_000, commitment: 'confirmed' };
      if (before) options.before = before;
      const batch = await this.rpc<SignatureInfo[]>('getSignaturesForAddress', [address, options]);
      if (!Array.isArray(batch)) throw new TypeError('Solana RPC returned invalid signature data');
      for (const item of batch) {
        if (!SIGNATURE.test(item.signature) || !Number.isSafeInteger(item.slot) || item.slot < 0) {
          throw new TypeError('Solana RPC returned an invalid signature record');
        }
        if (item.signature === cursor) {
          cursorFound = true;
          break;
        }
        signatures.push(item);
      }
      if (cursorFound || batch.length < 1_000) break;
      before = batch.at(-1)?.signature;
      if (!before) throw new TypeError('Solana RPC returned an invalid pagination cursor');
    }
    if (!cursorFound && cursor !== undefined) throw new Error('Solana pagination did not reach the saved signature cursor');
    return { signatures, nextCursor: signatures[0]?.signature ?? cursor ?? null };
  }

  private async readTransfer(target: SolanaWatchTarget, signatureInfo: SignatureInfo): Promise<{ transfer: ChainTransfer; sourceEndpoint: string } | null> {
    const { result: transaction, endpoint } = await this.rpcWithEndpoint<SolanaTransaction | null>('getTransaction', [signatureInfo.signature, {
      commitment: 'confirmed',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
    }]);
    if (!transaction?.meta || transaction.meta.err !== null) return null;
    const amount = target.kind === 'native'
      ? nativeBalanceDelta(transaction, target.watchAddress)
      : splBalanceDelta(transaction, target);
    if (amount <= 0n) return null;
    const finalized = signatureInfo.confirmationStatus === 'finalized';
    return {
      transfer: {
        transactionId: signatureInfo.signature,
        asset: target.asset,
        network: this.config.network,
        address: target.address,
        amountBaseUnits: amount,
        blockNumber: BigInt(signatureInfo.slot),
        confirmations: finalized ? 1n : 0n,
        observedAt: signatureInfo.blockTime ? new Date(signatureInfo.blockTime * 1000) : this.now(),
      },
      sourceEndpoint: endpoint,
    };
  }

  private async verifyHighValueTransfer(
    target: SolanaWatchTarget,
    signature: string,
    amount: bigint,
    slot: bigint,
    primaryEndpoint: string,
  ): Promise<void> {
    const threshold = this.config.highValueThresholdsBaseUnits?.[target.asset];
    if (threshold === undefined || amount < threshold) return;
    let independent: SolanaTransaction | null | undefined;
    for (const endpoint of this.config.rpcUrls) {
      if (endpoint === primaryEndpoint) continue;
      try {
        independent = await this.rpcFrom<SolanaTransaction | null>(endpoint, 'getTransaction', [signature, {
          commitment: 'confirmed', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0,
        }]);
        if (independent) break;
      } catch {
        // Continue until a separate provider responds.
      }
    }
    if (!independent?.meta || independent.meta.err !== null || BigInt(independent.slot) !== slot) {
      throw new Error('high-value Solana verification requires a second responsive RPC provider');
    }
    const independentlyObserved = target.kind === 'native'
      ? nativeBalanceDelta(independent, target.watchAddress)
      : splBalanceDelta(independent, target);
    if (independentlyObserved !== amount) throw new Error('Solana RPC providers disagree on a high-value transfer');
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.rpcWithEndpoint<T>(method, params)).result;
  }

  private async rpcWithEndpoint<T>(method: string, params: unknown[]): Promise<{ result: T; endpoint: string }> {
    for (const endpoint of this.config.rpcUrls) {
      try {
        return { result: await this.rpcFrom<T>(endpoint, method, params), endpoint };
      } catch {
        // Try the next configured RPC provider.
      }
    }
    throw new Error('all Solana RPC providers failed');
  }

  private async rpcFrom<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Solana RPC returned HTTP ${response.status}`);
    const envelope = await response.json() as RpcEnvelope<T>;
    if (envelope.error || !('result' in envelope)) throw new Error('Solana RPC request failed');
    return envelope.result as T;
  }
}

function validateTarget(target: SolanaWatchTarget): void {
  if (!ADDRESS.test(target.address) || !ADDRESS.test(target.watchAddress)) throw new TypeError('Solana account address is invalid');
  if (target.kind === 'spl' && (!target.mint || !ADDRESS.test(target.mint))) throw new TypeError('SPL mint address is invalid');
  if (target.kind === 'spl' && (!Number.isInteger(target.tokenDecimals) || target.tokenDecimals! < 0 || target.tokenDecimals! > 18)) {
    throw new RangeError('SPL token decimals must be an integer from 0 to 18');
  }
}

function nativeBalanceDelta(transaction: SolanaTransaction, address: string): bigint {
  const accountKeys = transaction.transaction.message.accountKeys.map((key) => typeof key === 'string' ? key : key.pubkey);
  const index = accountKeys.indexOf(address);
  if (index < 0) return 0n;
  const before = transaction.meta!.preBalances[index] ?? 0;
  const after = transaction.meta!.postBalances[index] ?? 0;
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before < 0 || after < 0) {
    throw new TypeError('Solana RPC returned an invalid lamport balance');
  }
  return BigInt(after) - BigInt(before);
}

function splBalanceDelta(transaction: SolanaTransaction, target: SolanaWatchTarget): bigint {
  const keys = transaction.transaction.message.accountKeys.map((key) => typeof key === 'string' ? key : key.pubkey);
  const accountIndex = keys.indexOf(target.watchAddress);
  if (accountIndex < 0) return 0n;
  const matches = (balance: TokenBalance): boolean => balance.accountIndex === accountIndex
    && balance.mint === target.mint
    && (balance.owner === undefined || balance.owner === target.address)
    && balance.uiTokenAmount.decimals === target.tokenDecimals;
  const before = transaction.meta!.preTokenBalances?.find(matches)?.uiTokenAmount.amount ?? '0';
  const after = transaction.meta!.postTokenBalances?.find(matches)?.uiTokenAmount.amount ?? '0';
  if (!/^\d+$/.test(before) || !/^\d+$/.test(after)) throw new TypeError('Solana RPC returned an invalid token amount');
  return BigInt(after) - BigInt(before);
}
