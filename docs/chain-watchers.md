# Chain watcher adapters

Authorship: W-Digital (hallo@w-digital.eu)

## EVM

`EvmWatcher` scans configured block ranges for direct native-asset transactions and ERC-20 `Transfer` logs. It checks the configured chain ID, supports ordered RPC failover, chunks recipient filters, and computes confirmations from the latest block. When an asset has a configured high-value threshold, the watcher requires a second responsive RPC endpoint and compares the transaction or token receipt before accepting the transfer.

Direct native transfers to invoice addresses are included. Internal value movements caused by contract execution require trace APIs and are not included by this adapter. Configure distinct RPC providers for each EVM network and validate the network at worker startup.

## Bitcoin and Litecoin

`EsploraWatcher` reads address transactions and the tip height from Esplora-compatible APIs. Configure the correct API base for each chain and network. It sums outputs to the invoice address, tracks confirmed and mempool transfers, supports saved transaction cursors for pagination, and checks high-value transfers against a second responsive explorer.

On the first scan, the adapter reads the latest address page. Persist the returned `nextCursor` and pass it to later scans so the adapter can page back to the last processed transaction. The receiving address should be newly derived for the invoice. Never treat an old transaction already present on a reused address as a payment for a new invoice.

## Solana

`SolanaWatcher` scans signature history for each configured watch account and reads transaction balance deltas. Native SOL uses the invoice address as the watch account. SPL targets use the invoice's associated token account as `watchAddress`, with its owner wallet and mint supplied in config. Persist a signature cursor per watch account. The watcher reports a confirmation only when the RPC marks the signature finalized. A second RPC is required for assets with a configured high-value threshold.

## TRON

`TronWatcher` reads confirmed TRX and TRC-20 account history from TronGrid-compatible APIs and calculates confirmations against the solidified head block. It pages with the provider's fingerprint cursor, but persists the latest transaction ID as the application cursor. Use separate cursors for TRX and each token contract. A second responsive provider is required for assets with a configured high-value threshold. Provider API keys belong in environment configuration and must not appear in logs.

## Operational requirements

- Persist each chain's scan cursor and transfer records before advancing it.
- Recheck recent EVM blocks to handle reorganizations; do not treat a block as final solely because it first appeared.
- Set per-network confirmation requirements in configuration.
- Do not log RPC or explorer URLs because operators may include provider credentials in those URLs.
