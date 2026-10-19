import { describe, expect, it } from 'vitest';
import { SolanaWatcher } from './solana.js';

const invoiceAddress = '11111111111111111111111111111111';
const tokenAccount = '22222222222222222222222222222222';
const mint = '33333333333333333333333333333333';
const signature = 'A'.repeat(88);

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
}

const finalizedSignature = {
  signature,
  slot: 42,
  err: null,
  blockTime: 1767225600,
  confirmationStatus: 'finalized',
};

describe('Solana watcher', () => {
  it('finds finalized native SOL balance increases', async () => {
    const watcher = new SolanaWatcher({
      network: 'solana-devnet', rpcUrls: ['https://solana-rpc.example'],
      fetcher: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'getSignaturesForAddress') return rpcResponse([finalizedSignature]);
        if (body.method === 'getTransaction') return rpcResponse({
          slot: 42,
          blockTime: 1767225600,
          transaction: { signatures: [signature], message: { accountKeys: [invoiceAddress] } },
          meta: { err: null, preBalances: [0], postBalances: [2_000_000] },
        });
        throw new Error('unexpected Solana RPC method');
      },
    });
    const result = await watcher.scanTargets([{
      address: invoiceAddress, watchAddress: invoiceAddress, asset: 'SOL', kind: 'native',
    }]);
    expect(result.transfers).toMatchObject([{
      transactionId: signature, amountBaseUnits: 2_000_000n, blockNumber: 42n, confirmations: 1n,
    }]);
    expect(result.nextCursors[invoiceAddress]).toBe(signature);
  });

  it('tracks SPL token raw amounts and checks high-value transfers on a second RPC', async () => {
    const endpoints: string[] = [];
    const watcher = new SolanaWatcher({
      network: 'solana-mainnet', rpcUrls: ['https://rpc-one.example', 'https://rpc-two.example'],
      highValueThresholdsBaseUnits: { USDC: 1_000_000n },
      fetcher: async (input, init) => {
        endpoints.push(String(input));
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === 'getSignaturesForAddress') return rpcResponse([finalizedSignature]);
        if (body.method === 'getTransaction') return rpcResponse({
          slot: 42,
          blockTime: 1767225600,
          transaction: { signatures: [signature], message: { accountKeys: [tokenAccount] } },
          meta: {
            err: null,
            preBalances: [2_000_000],
            postBalances: [2_000_000],
            preTokenBalances: [{ accountIndex: 0, mint, owner: invoiceAddress, uiTokenAmount: { amount: '0', decimals: 6 } }],
            postTokenBalances: [{ accountIndex: 0, mint, owner: invoiceAddress, uiTokenAmount: { amount: '1500000', decimals: 6 } }],
          },
        });
        throw new Error('unexpected Solana RPC method');
      },
    });
    const result = await watcher.scanTargets([{
      address: invoiceAddress, watchAddress: tokenAccount, asset: 'USDC', kind: 'spl', mint, tokenDecimals: 6,
    }]);
    expect(result.transfers).toMatchObject([{ amountBaseUnits: 1_500_000n, asset: 'USDC', address: invoiceAddress }]);
    expect(endpoints).toContain('https://rpc-two.example');
  });
});
