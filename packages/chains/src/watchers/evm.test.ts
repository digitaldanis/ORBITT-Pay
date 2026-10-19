import { describe, expect, it } from 'vitest';
import { EvmWatcher } from './evm.js';

const address = '0x1111111111111111111111111111111111111111';
const hash = `0x${'a'.repeat(64)}`;

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

describe('EVM watcher', () => {
  it('scans native transfers, verifies high values independently, and counts confirmations', async () => {
    const requests: Array<{ endpoint: string; method: string }> = [];
    const watcher = new EvmWatcher({
      network: 'base', nativeAsset: 'ETH', chainId: 8453,
      rpcUrls: ['https://rpc-one.example', 'https://rpc-two.example'],
      highValueThresholdsBaseUnits: { ETH: 100n },
      fetcher: async (input, init) => {
        const endpoint = String(input);
        const body = JSON.parse(String(init?.body)) as { method: string };
        requests.push({ endpoint, method: body.method });
        if (body.method === 'eth_getBlockByNumber') {
          return rpcResponse({
            number: '0x5',
            transactions: [{ hash, to: address, value: '0x64' }],
          });
        }
        if (body.method === 'eth_getTransactionByHash') return rpcResponse({ hash, to: address, value: '0x64' });
        if (body.method === 'eth_getTransactionReceipt') return rpcResponse({ status: '0x1', blockNumber: '0x5', logs: [] });
        if (body.method === 'eth_getLogs') return rpcResponse([]);
        throw new Error(`Unexpected RPC method ${body.method}`);
      },
    });

    const transfers = await watcher.scanBlockRange(5n, 5n, [address]);
    const confirmed = watcher.withConfirmations(transfers, 6n);
    expect(confirmed).toMatchObject([{
      transactionId: hash,
      asset: 'ETH',
      network: 'base',
      address,
      amountBaseUnits: 100n,
      blockNumber: 5n,
      confirmations: 2n,
    }]);
    expect(requests).toContainEqual({ endpoint: 'https://rpc-two.example', method: 'eth_getTransactionReceipt' });
  });

  it('fails over between RPC providers and validates the configured chain', async () => {
    const watcher = new EvmWatcher({
      network: 'ethereum', nativeAsset: 'ETH', chainId: 1,
      rpcUrls: ['https://rpc-down.example', 'https://rpc-up.example'],
      fetcher: async (input, init) => {
        if (String(input).includes('rpc-down')) throw new Error('offline');
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'eth_chainId') return rpcResponse('0x1');
        if (body.method === 'eth_blockNumber') return rpcResponse('0x2a');
        throw new Error('unexpected method');
      },
    });
    await expect(watcher.validateNetwork()).resolves.toBeUndefined();
    await expect(watcher.getHeadBlock()).resolves.toBe(42n);
  });

  it('decodes ERC-20 transfers and ignores logs for other recipients', async () => {
    const contract = '0x2222222222222222222222222222222222222222';
    const topicTo = `0x${address.slice(2).padStart(64, '0')}`;
    const watcher = new EvmWatcher({
      network: 'polygon', nativeAsset: 'POL', chainId: 137,
      rpcUrls: ['https://polygon-rpc.example'],
      tokens: [{ asset: 'USDC', contractAddress: contract }],
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'eth_getBlockByNumber') return rpcResponse({ number: '0x10', transactions: [] });
        if (body.method === 'eth_getLogs') return rpcResponse([{
          address: contract,
          data: '0x00000000000000000000000000000000000000000000000000000000000003e8',
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            `0x${'0'.repeat(64)}`,
            topicTo,
          ],
          transactionHash: hash,
          blockNumber: '0x10',
        }]);
        throw new Error('unexpected method');
      },
    });
    const transfers = await watcher.scanBlockRange(16n, 16n, [address]);
    expect(transfers).toMatchObject([{ asset: 'USDC', amountBaseUnits: 1000n, address, blockNumber: 16n }]);
  });
});
