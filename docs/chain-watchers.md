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

## Current worker wiring

The worker currently connects the Esplora adapter to BTC/LTC invoice addresses and the EVM adapter to native ETH addresses. It stores detected transfers and EVM scan cursors in PostgreSQL, refreshes EVM confirmations, expires unpaid invoices, and queues status webhooks in the same database transactions. Configure `BITCOIN_RPC_URL` and `LITECOIN_RPC_URL` with comma-separated Esplora-compatible API base URLs; despite the legacy variable names, these are not Bitcoin Core JSON-RPC endpoints. EVM variables such as `ETHEREUM_RPC_URL` accept comma-separated JSON-RPC URLs. The worker checks the configured chain ID before scanning.

Per-network confirmation defaults are in the worker scanner; override them with `CONFIRMATIONS_<NETWORK>` environment variables, for example `CONFIRMATIONS_ETHEREUM=12`. On first scan, an EVM network starts near the current head, then stores a durable block cursor. Keep the worker running before creating invoices and configure a reliable RPC/explorer provider. Chain reorganization recovery, ERC-20/SPL/TRC-20 invoice scanning, Solana and Tron worker wiring, and full testnet payment verification remain incomplete. This worker milestone is not production payment assurance.
