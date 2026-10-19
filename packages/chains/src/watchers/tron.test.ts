import { describe, expect, it } from 'vitest';
import { TronWatcher } from './tron.js';

const address = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const addressHex = '410000000000000000000000000000000000000000';
const txid = 'a'.repeat(64);
const tokenContract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('TRON watcher', () => {
  it('reads confirmed TRX and TRC-20 transfers in the TronGrid v1 format', async () => {
    const watcher = new TronWatcher({
      network: 'tron-nile',
      apiBases: ['https://tron.example'],
      tokens: [{ asset: 'USDT', contractAddress: tokenContract }],
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'POST') {
          return jsonResponse({ block_header: { raw_data: { number: 119 } } });
        }
        if (url.pathname.endsWith('/transactions/trc20')) {
          // Real TronGrid TRC-20 records carry no block height and name the contract in token_info.
          return jsonResponse({ data: [{
            transaction_id: txid,
            token_info: { symbol: 'USDT', address: tokenContract, decimals: 6, name: 'Tether USD' },
            block_timestamp: 1767225600000,
            from: 'TVksTWs79stkKWEqKLYTdBjf4B3qZS7cZU',
            to: address,
            type: 'Transfer',
            value: '1200000',
          }], meta: { page_size: 1 } });
        }
        return jsonResponse({ data: [{
          txID: txid,
          blockNumber: 100,
          block_timestamp: 1767225600000,
          ret: [{ contractRet: 'SUCCESS' }],
          raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: addressHex, amount: 5_000_000 } } }] },
        }], meta: { page_size: 1 } });
      },
    });
    const head = await watcher.getSolidifiedHeadBlock();
    const result = await watcher.scanAddress(address, head);
    expect(result.transfers).toMatchObject([
      { asset: 'TRX', amountBaseUnits: 5_000_000n, confirmations: 20n },
      { asset: 'USDT', amountBaseUnits: 1_200_000n, confirmations: 1n, blockNumber: null, observedAt: new Date(1767225600000) },
    ]);
  });

  it('rejects invalid addresses and unsafe native amounts', async () => {
    const watcher = new TronWatcher({
      network: 'tron-mainnet', apiBases: ['https://tron.example'],
      fetcher: async () => jsonResponse({ data: [{
        txID: txid,
        block_number: 100,
        block_timestamp: 1767225600000,
        raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { to_address: addressHex, amount: Number.MAX_SAFE_INTEGER + 1 } } }] },
      }] }),
    });
    await expect(watcher.scanAddress('not-a-tron-address', 100n)).rejects.toThrow(TypeError);
    await expect(watcher.scanAddress(address, 100n)).rejects.toThrow(/invalid native amount/);
  });
});
