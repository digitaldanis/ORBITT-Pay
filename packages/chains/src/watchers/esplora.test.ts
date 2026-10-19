import { describe, expect, it } from 'vitest';
import { EsploraWatcher } from './esplora.js';

const address = 'bc1qexampleaddress';
const txid = 'a'.repeat(64);

function tx(outputs: Array<{ scriptpubkey_address: string; value: number }>) {
  return {
    txid,
    vout: outputs,
    status: { confirmed: true, block_height: 98, block_time: 1767225600 },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('Esplora watcher', () => {
  it('sums matching outputs and calculates confirmations', async () => {
    const watcher = new EsploraWatcher({
      asset: 'BTC', network: 'bitcoin', apiBases: ['https://explorer.example/api'],
      fetcher: async () => jsonResponse([tx([
        { scriptpubkey_address: address, value: 400 },
        { scriptpubkey_address: address, value: 600 },
        { scriptpubkey_address: 'other', value: 900 },
      ])]),
    });
    const result = await watcher.scanAddress(address, 100n);
    expect(result.transfers).toMatchObject([{ amountBaseUnits: 1000n, blockNumber: 98n, confirmations: 3n, transactionId: txid }]);
    expect(result.nextCursor).toBe(txid);
  });

  it('fails over and compares high-value outputs against an independent source', async () => {
    const requests: string[] = [];
    const watcher = new EsploraWatcher({
      asset: 'LTC', network: 'litecoin', apiBases: ['https://down.example/api', 'https://backup.example/api', 'https://independent.example/api'],
      highValueThresholdBaseUnits: 1000n,
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes('down.example')) throw new Error('offline');
        return jsonResponse(url.includes(`/tx/${txid}`)
          ? tx([{ scriptpubkey_address: address, value: 1500 }])
          : [tx([{ scriptpubkey_address: address, value: 1500 }])]);
      },
    });
    const result = await watcher.scanAddress(address, 100n);
    expect(result.transfers[0]?.amountBaseUnits).toBe(1500n);
    expect(requests.some((url) => url === `https://independent.example/api/tx/${txid}`)).toBe(true);
  });

  it('reads the text block-height endpoint', async () => {
    const watcher = new EsploraWatcher({
      asset: 'BTC', network: 'bitcoin', apiBases: ['https://explorer.example/api'],
      fetcher: async () => new Response('840000', { headers: { 'content-type': 'text/plain' } }),
    });
    await expect(watcher.getHeadBlock()).resolves.toBe(840000n);
  });
});
