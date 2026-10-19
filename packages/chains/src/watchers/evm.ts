import type { ChainTransfer } from './types.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x[0-9a-fA-F]+$/;

export interface EvmTokenConfig {
  asset: string;
  contractAddress: string;
}

export interface EvmWatcherConfig {
  network: string;
  nativeAsset: string;
  chainId: number;
  rpcUrls: readonly string[];
  tokens?: readonly EvmTokenConfig[];
  highValueThresholdsBaseUnits?: Readonly<Record<string, bigint>>;
  maxBlocksPerScan?: bigint;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface RpcTransaction {
  hash: string;
  to: string | null;
  value: string;
}

interface RpcBlock {
  number: string;
  transactions: RpcTransaction[];
}

interface RpcLog {
  address: string;
  data: string;
  topics: string[];
  transactionHash: string;
  blockNumber: string;
  removed?: boolean;
}

interface RpcReceipt {
  status: string;
  blockNumber: string;
  logs: RpcLog[];
}

interface RpcTransactionByHash {
  hash: string;
  to: string | null;
  value: string;
}

export class EvmWatcher {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly maxBlocksPerScan: bigint;
  private requestId = 0;

  constructor(private readonly config: EvmWatcherConfig) {
    if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new RangeError('chainId must be a positive integer');
    if (config.rpcUrls.length === 0) throw new RangeError('at least one EVM RPC URL is required');
    if (config.rpcUrls.some((url) => !/^https?:\/\//i.test(url))) throw new TypeError('EVM RPC URLs must use HTTP or HTTPS');
    for (const token of config.tokens ?? []) if (!ADDRESS.test(token.contractAddress)) throw new TypeError('token contract address is invalid');
    for (const threshold of Object.values(config.highValueThresholdsBaseUnits ?? {})) {
      if (threshold < 0n) throw new RangeError('high-value thresholds must not be negative');
    }
    this.fetcher = config.fetcher ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 5_000;
    this.now = config.now ?? (() => new Date());
    this.maxBlocksPerScan = config.maxBlocksPerScan ?? 2_000n;
    if (this.maxBlocksPerScan <= 0n) throw new RangeError('maxBlocksPerScan must be positive');
  }

  async getHeadBlock(): Promise<bigint> {
    const block = await this.rpc<string>('eth_blockNumber', []);
    return parseHexBigInt(block, 'block number');
  }

  async validateNetwork(): Promise<void> {
    const actualChainId = await this.rpc<string>('eth_chainId', []);
    if (parseHexBigInt(actualChainId, 'chain id') !== BigInt(this.config.chainId)) {
      throw new Error(`EVM RPC chain id does not match configured network ${this.config.network}`);
    }
  }

  /**
   * Finds native and token transfers to `receivingAddresses` in a block range. Pass
   * `native: false` when only token invoices are open to skip fetching full blocks.
   */
  async scanBlockRange(fromBlock: bigint, toBlock: bigint, receivingAddresses: readonly string[], options: { native?: boolean } = {}): Promise<ChainTransfer[]> {
    if (fromBlock < 0n || toBlock < fromBlock) throw new RangeError('invalid block range');
    if (toBlock - fromBlock + 1n > this.maxBlocksPerScan) throw new RangeError('block range exceeds the configured scan limit');
    const addresses = new Map<string, string>();
    for (const address of receivingAddresses) {
      if (!ADDRESS.test(address)) throw new TypeError('receiving address is invalid');
      addresses.set(address.toLowerCase(), address);
    }
    if (addresses.size === 0) return [];

    const transfers: ChainTransfer[] = [];
    for (let blockNumber = fromBlock; options.native !== false && blockNumber <= toBlock; blockNumber += 1n) {
      const blockTag = `0x${blockNumber.toString(16)}`;
      const { result: block, endpoint: blockSource } = await this.rpcWithEndpoint<RpcBlock | null>('eth_getBlockByNumber', [blockTag, true]);
      if (!block) continue;
      if (parseHexBigInt(block.number, 'block number') !== blockNumber) throw new Error('RPC returned a block for the wrong height');
      for (const transaction of block.transactions) {
        if (!HASH.test(transaction.hash) || !transaction.to || !ADDRESS.test(transaction.to)) continue;
        const address = addresses.get(transaction.to.toLowerCase());
        if (!address) continue;
        const amount = parseHexBigInt(transaction.value, 'native amount');
        if (amount === 0n) continue;
        const transfer: ChainTransfer = {
          transactionId: transaction.hash,
          asset: this.config.nativeAsset,
          network: this.config.network,
          address,
          amountBaseUnits: amount,
          blockNumber,
          confirmations: 0n,
          observedAt: this.now(),
        };
        await this.verifyHighValueTransfer(transfer, transaction, blockNumber, blockSource);
        transfers.push(transfer);
      }
    }

    const contracts = [...new Map((this.config.tokens ?? []).map((token) => [token.contractAddress.toLowerCase(), token])).values()];
    const addressGroups = chunk([...addresses.keys()], 100);
    for (const token of contracts) {
      for (const addressGroup of addressGroups) {
        const { result: logs, endpoint: logSource } = await this.rpcWithEndpoint<RpcLog[]>('eth_getLogs', [{
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          address: token.contractAddress,
          topics: [TRANSFER_TOPIC, null, addressGroup.map((address) => `0x${address.slice(2).padStart(64, '0')}`)],
        }]);
        for (const log of logs) {
          if (log.removed || log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
            || !HASH.test(log.transactionHash) || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[2] ?? '')
            || !/^0x[0-9a-fA-F]{64}$/.test(log.data) || log.address.toLowerCase() !== token.contractAddress.toLowerCase()) continue;
          const destination = `0x${log.topics[2]!.slice(-40)}`;
          const address = addresses.get(destination.toLowerCase());
          if (!address) continue;
          const blockNumber = parseHexBigInt(log.blockNumber, 'token block number');
          const amount = parseHexBigInt(log.data, 'token amount');
          if (amount === 0n) continue;
          const transfer: ChainTransfer = {
            transactionId: log.transactionHash,
            asset: token.asset,
            network: this.config.network,
            address,
            amountBaseUnits: amount,
            blockNumber,
            confirmations: 0n,
            observedAt: this.now(),
          };
          await this.verifyHighValueTokenTransfer(transfer, log, blockNumber, token.contractAddress, logSource);
          transfers.push(transfer);
        }
      }
    }
    return transfers;
  }

  withConfirmations(transfers: readonly ChainTransfer[], headBlock: bigint): ChainTransfer[] {
    return transfers.map((transfer) => ({
      ...transfer,
      confirmations: transfer.blockNumber === null || transfer.blockNumber > headBlock
        ? 0n
        : headBlock - transfer.blockNumber + 1n,
    }));
  }

  private async verifyHighValueTransfer(
    transfer: ChainTransfer,
    primaryTransaction: RpcTransaction,
    blockNumber: bigint,
    primaryEndpoint: string,
  ): Promise<void> {
    const threshold = this.config.highValueThresholdsBaseUnits?.[transfer.asset];
    if (threshold === undefined || transfer.amountBaseUnits < threshold) return;
    const independentTransaction = await this.rpcFromIndependent<RpcTransactionByHash>(primaryEndpoint, 'eth_getTransactionByHash', [transfer.transactionId]);
    if (!independentTransaction
      || independentTransaction.hash.toLowerCase() !== primaryTransaction.hash.toLowerCase()
      || independentTransaction.to?.toLowerCase() !== primaryTransaction.to?.toLowerCase()
      || parseHexBigInt(independentTransaction.value, 'verified native amount') !== transfer.amountBaseUnits) {
      throw new Error('independent RPC providers disagree on a high-value native transfer');
    }
    const receipt = await this.rpcFromIndependent<RpcReceipt>(primaryEndpoint, 'eth_getTransactionReceipt', [transfer.transactionId]);
    if (receipt?.status !== '0x1' || !receipt.logs
      || parseHexBigInt(receipt.blockNumber, 'verified receipt block') !== blockNumber
      || parseHexBigInt(primaryTransaction.value, 'native amount') === 0n) {
      throw new Error('independent provider did not confirm the high-value transfer');
    }
    if (blockNumber < 0n) throw new RangeError('block number must not be negative');
  }

  private async verifyHighValueTokenTransfer(
    transfer: ChainTransfer,
    primaryLog: RpcLog,
    blockNumber: bigint,
    contractAddress: string,
    primaryEndpoint: string,
  ): Promise<void> {
    const threshold = this.config.highValueThresholdsBaseUnits?.[transfer.asset];
    if (threshold === undefined || transfer.amountBaseUnits < threshold) return;
    const receipt = await this.rpcFromIndependent<RpcReceipt>(primaryEndpoint, 'eth_getTransactionReceipt', [transfer.transactionId]);
    const matchingLog = receipt?.logs.find((log) => log.address.toLowerCase() === contractAddress.toLowerCase()
      && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
      && log.topics[2]?.toLowerCase() === primaryLog.topics[2]?.toLowerCase()
      && log.data.toLowerCase() === primaryLog.data.toLowerCase()
      && log.transactionHash.toLowerCase() === transfer.transactionId.toLowerCase()
      && parseHexBigInt(log.blockNumber, 'verified token block') === blockNumber);
    if (receipt?.status !== '0x1' || !matchingLog
      || parseHexBigInt(receipt.blockNumber, 'verified receipt block') !== blockNumber) {
      throw new Error('independent RPC providers disagree on a high-value token transfer');
    }
    if (blockNumber < 0n) throw new RangeError('block number must not be negative');
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.rpcWithEndpoint<T>(method, params)).result;
  }

  private async rpcWithEndpoint<T>(method: string, params: unknown[]): Promise<{ result: T; endpoint: string }> {
    let lastError: unknown;
    for (const endpoint of this.config.rpcUrls) {
      try {
        return { result: await this.rpcFrom<T>(endpoint, method, params), endpoint };
      } catch (error) {
        lastError = error;
      }
    }
    void lastError;
    throw new Error('all EVM RPC providers failed');
  }

  private async rpcFromIndependent<T>(primaryEndpoint: string, method: string, params: unknown[]): Promise<T> {
    for (const endpoint of this.config.rpcUrls) {
      if (endpoint === primaryEndpoint) continue;
      try {
        return await this.rpcFrom<T>(endpoint, method, params);
      } catch {
        // Continue until a separate provider responds.
      }
    }
    throw new Error('high-value transfer verification requires a second responsive RPC provider');
  }

  private async rpcFrom<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`EVM RPC returned HTTP ${response.status}`);
    const envelope = await response.json() as RpcEnvelope<T>;
    if (envelope.error) throw new Error(`EVM RPC failed with code ${envelope.error.code ?? 'unknown'}`);
    if (!('result' in envelope)) throw new Error('EVM RPC response is missing its result');
    return envelope.result as T;
  }
}

function parseHexBigInt(value: string, label: string): bigint {
  if (!HEX.test(value)) throw new TypeError(`RPC returned an invalid ${label}`);
  return BigInt(value);
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}
