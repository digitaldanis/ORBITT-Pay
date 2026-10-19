# Address derivation

Authorship: W-Digital (hallo@w-digital.eu)

The service derives receiving addresses from merchant-provided **public account extended keys**. It rejects private extended keys. Merchants retain their seed phrases and signing keys outside ORBITT PAY.

## Account key requirements

- Bitcoin and Litecoin use account-level BIP84 public keys for account 0: `m/84'/coin_type'/0'`.
- EVM uses the BIP44 account-level public key at `m/44'/60'/0'`; the same key serves every EVM network and its tokens.
- TRON uses the BIP44 account-level public key at `m/44'/195'/0'`; addresses are base58check `T…` addresses.
- Solana has no public child derivation (ed25519). Merchants provide their wallet address; invoices are distinguished by a unique amount, and SPL tokens are watched on the wallet's associated token accounts.
- The service derives only non-hardened receiving children below the account key and records the complete path on each invoice.
- Supported Bitcoin-family extended public key versions are `xpub`, `tpub`, `zpub`, and `vpub`. Litecoin's `Ltub` version is not accepted because it identifies a legacy BIP44 serialization, not a BIP84 native SegWit account.

## Address allocation

The derivation functions are deterministic, but index allocation must be serialized per merchant and network. Reserve the next index in a database transaction and keep a unique constraint across open invoice addresses. Do not release an address while a payment is detected or confirming. Persist the index and derivation path so an operator can audit the assignment.

## Current coverage

- Bitcoin and Litecoin native SegWit P2WPKH (`bc1`/`tb1`, `ltc1`/`tltc1`).
- EVM account paths, with EIP-55 checksum casing.
- TRON receive addresses.
- Solana associated token account (ATA) calculation for USDC and USDT.
- Test vectors from the standard BIP39 test mnemonic cover every family.
- Bitcoin Taproot is not supported.
