# Chain watchers

Authorship: W-Digital (hallo@w-digital.eu)

The worker (`apps/worker`) scans every enabled network from `config/assets.json` about every ten seconds. Each network runs on its own, so one failing provider does not stop the others. After each pass the worker writes a heartbeat to `network_scanner_status` (head block, time, last error). The dashboard shows it per network, and the checkout offers only networks with a healthy heartbeat.

All endpoint variables accept several comma-separated URLs; the watchers fail over in order. Do not log provider URLs: they often contain API keys.

## Bitcoin and Litecoin

`EsploraWatcher` reads address history and the tip from an Esplora-compatible API (`BITCOIN_ESPLORA_URL`, `LITECOIN_ESPLORA_URL`, e.g. mempool.space and litecoinspace.org). `BITCOIN_RPC_URL` and `LITECOIN_RPC_URL` are accepted as legacy names for the same Esplora base URL; they are not Bitcoin Core JSON-RPC. Outputs to the invoice address are summed per transaction, mempool transfers mark the invoice `detected`, and confirmations come from the tip height.

## EVM networks

Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Smart Chain use JSON-RPC (`ETHEREUM_RPC_URL`, `BASE_RPC_URL`, ...). The worker checks the chain ID, then walks blocks from a stored cursor:

- native coins: direct transactions to invoice addresses in each block;
- tokens: `eth_getLogs` for the ERC-20 `Transfer` event of each configured contract, filtered by recipient.

While no invoice is open on a network the cursor follows the tip, so a new invoice never triggers a long catch-up. Transfers sent internally by a contract (no direct transaction or `Transfer` log) are not detected.

## TRON

`TronWatcher` uses the TronGrid v1 API (`TRON_API_URL`, optional `TRON_API_KEY`). TRX transfers carry a block number and are confirmed against the solidified head. TronGrid's TRC-20 history has no block height and lists only confirmed transfers, so TRC-20 transfers count as confirmed once they appear.

## Solana

Ed25519 keys cannot derive child addresses from a public key, so Solana invoices share the merchant's wallet address and are told apart by amount. Each open invoice gets a unique amount (base quote plus a random offset of up to `max_offset_base_units`) that no other open or recent invoice on that address uses. The worker reads `getSignaturesForAddress` with `finalized` commitment for the wallet (SOL) and its associated token accounts (USDC, USDT), compares balance deltas, and matches transfers to invoices by **exact amount**. A per-account signature cursor in `address_scan_cursors` keeps scans incremental. Set `SOLANA_RPC_URL` to a provider that keeps enough signature history.

## Matching rules

- Each derived address is used for exactly one invoice. The allocator skips any address an earlier invoice on the network already used, even after the merchant replaced the wallet key.
- Transfers older than the moment the customer picked the coin are ignored, with a small clock tolerance per family (UTXO 2 h for mempool timestamps, TRON 10 min, Solana 5 min). This prevents old history on an address from counting as payment.
- Funds that arrive after expiry or cancellation move the invoice to `late_payment` only if they are new; re-reading transfers that were already counted does not.

## Confirmations

Defaults: Bitcoin 2, Litecoin 6, Ethereum 12, Base/Arbitrum/Optimism 10, Polygon 64, BNB Smart Chain 15, TRON 1, Solana 1 (finalized). Override with `CONFIRMATIONS_<NETWORK>`, for example `CONFIRMATIONS_ETHEREUM=20` or `CONFIRMATIONS_BNB_CHAIN=20`.

## Known limits

- A transfer removed by a chain reorganization after it was counted is not rolled back automatically. Confirmation counts are the protection; keep them conservative for high values.
- Make test payments on every network you enable before going live; behaviour differs between providers.
